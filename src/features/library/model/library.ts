import { ref, type Ref } from "vue";
import type { ComicDocument } from "../../../shared/document";
import { demoDocument } from "../lib/demo";
import { processPage, probeImage } from "../lib/importImages";
import {
  createTask,
  buildChapter,
  pairFiles,
  movePage,
  MAX_IMPORT_FILES,
  type ImportTask,
  type ImportMode,
  type TaskState,
} from "../lib/importTask";
import { persistTask, readTask, exportChapter } from "../lib/importStore";

export interface LibraryHooks {
  /** 把当前文档/位置/书签写入本地，返回是否成功（失败即额度不足） */
  persist: () => boolean;
  /** 章节入库后回调：只协调阅读位置与书签，不跳转、不打扰阅读 */
  onCommitted: () => void;
  /** 回到内置漫画后回调 */
  onReset: () => void;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

export function useLibrary(doc: Ref<ComicDocument>, hooks: LibraryHooks) {
  const task = ref<ImportTask | null>(null);
  const busy = ref(false);
  const message = ref("");
  /** 递增即请求界面弹出文件选择（用于续传/重试时补选原图） */
  const fileRequest = ref(0);
  /** 本地剩余可用字节数，0 表示未知 */
  const quotaBytes = ref(0);
  /** 运行期文件句柄，不持久化；刷新后需重新选择 */
  const files = new Map<string, File>();
  let storeTimer: ReturnType<typeof setTimeout> | undefined;

  // ---------- 任务持久化 ----------

  function storeNow(): boolean {
    const t = task.value;
    if (!t || t.state === "preview") return true;
    return persistTask(t);
  }

  function scheduleStore() {
    clearTimeout(storeTimer);
    storeTimer = setTimeout(() => {
      const t = task.value;
      if (!t || t.state === "preview") return;
      if (!persistTask(t)) {
        if (t.state === "running") t.state = "quota";
        message.value = "本地空间不足，进度保存失败；可导出已完成部分";
      }
    }, 400);
  }

  function clearTask() {
    clearTimeout(storeTimer);
    task.value = null;
    files.clear();
    persistTask(null);
  }

  // ---------- 任务生命周期 ----------

  function beginImport(list: File[]) {
    if (busy.value) {
      message.value = "正在停止当前任务，请稍候";
      return;
    }
    if (task.value || !list.length) return;
    if (list.length > MAX_IMPORT_FILES) {
      message.value = `一次最多导入 ${MAX_IMPORT_FILES} 张图片`;
      return;
    }
    message.value = "";
    const t = createTask(list);
    for (const [key, file] of pairFiles(list)) files.set(key, file);
    task.value = t;
    refreshQuota();
    void probeAll(t);
  }

  /** 预览阶段并发受限地探测尺寸，既估算占用也提前校验可解码 */
  async function probeAll(t: ImportTask) {
    const queue = t.pages.filter((p) => !p.width && p.status === "pending");
    async function worker() {
      for (;;) {
        const page = queue.shift();
        if (!page || task.value !== t || t.state !== "preview") return;
        const file = files.get(page.key);
        if (!file) continue;
        try {
          const d = await probeImage(file);
          page.width = d.width;
          page.height = d.height;
        } catch (error) {
          page.status = "failed";
          page.error = error instanceof Error ? error.message : "无法读取图片";
        }
      }
    }
    await Promise.all([worker(), worker()]);
  }

  function refreshQuota() {
    const estimate = navigator.storage?.estimate?.bind(navigator.storage);
    if (!estimate) return;
    void estimate()
      .then(({ quota, usage }) => {
        quotaBytes.value = quota ? Math.max(0, quota - (usage ?? 0)) : 0;
      })
      .catch(() => {});
  }

  function setMode(mode: ImportMode) {
    const t = task.value;
    if (t && t.state === "preview") t.mode = mode;
  }

  function reorder(key: string, delta: number) {
    if (task.value) movePage(task.value, key, delta);
  }

  function start() {
    const t = task.value;
    if (!t || busy.value || t.state !== "preview") return;
    void run();
  }

  function pause() {
    const t = task.value;
    if (!t || t.state !== "running") return;
    t.state = "paused";
    if (!storeNow()) {
      t.state = "quota";
      message.value = "本地空间不足，进度保存失败；可导出已完成部分";
      return;
    }
    message.value = "已暂停，已完成的页会保留，可随时继续";
  }

  /** 逐页处理：每页之间让出主线程，阅读当前漫画不被阻塞 */
  async function run() {
    const t = task.value;
    if (!t || busy.value) return;
    busy.value = true;
    t.state = "running";
    message.value = "";
    storeNow();
    try {
      for (;;) {
        const current = task.value;
        if (!current || current !== t || t.state !== "running") break;
        const next = t.pages.find(
          (p) => p.status === "pending" && files.has(p.key),
        );
        if (!next) {
          t.state = t.pages.every(
            (p) => p.status === "done" || p.status === "failed",
          )
            ? "staged"
            : "paused";
          break;
        }
        next.status = "processing";
        next.attempts += 1;
        try {
          next.page = await processPage(files.get(next.key)!, t.mode);
          next.status = "done";
          next.error = "";
          files.delete(next.key); // 已完成的页释放文件句柄，降低内存占用
        } catch (error) {
          next.status = "failed";
          next.error = error instanceof Error ? error.message : "处理失败";
        }
        scheduleStore();
        await tick();
        // 额度不足由延时落盘回调置为 quota，这里读取最新状态
        if ((t.state as TaskState) === "quota") break;
      }
    } finally {
      busy.value = false;
      if (
        !storeNow() &&
        task.value === t &&
        (t.state as TaskState) !== "quota"
      ) {
        t.state = "quota";
        message.value = "本地空间不足，进度保存失败；可导出已完成部分";
      }
    }
  }

  /**
   * 继续导入：幂等——已完成页直接跳过，重复点击不会产生重复页。
   * 缺少原图文件（如刷新后）时先请用户补选。
   */
  function resume() {
    tryResume(true);
  }

  function tryResume(askForFiles: boolean) {
    const t = task.value;
    if (!t || busy.value) return;
    if (t.state !== "paused" && t.state !== "staged" && t.state !== "quota")
      return;
    const pending = t.pages.filter((p) => p.status === "pending");
    if (!pending.length) {
      if (t.state !== "staged") {
        t.state = "staged";
        storeNow();
      }
      return;
    }
    const missing = pending.filter((p) => !files.has(p.key));
    if (missing.length) {
      if (t.state !== "paused") {
        t.state = "paused";
        storeNow();
      }
      message.value = `还有 ${missing.length} 页需要重新选择原图文件`;
      if (askForFiles) fileRequest.value += 1;
      return;
    }
    void run();
  }

  /** 单页重试：重新选择该页原图，其余页不受影响 */
  function retry(key: string) {
    const t = task.value;
    if (!t || busy.value) return;
    const page = t.pages.find((p) => p.key === key);
    if (!page || page.status !== "failed") return;
    page.status = "pending";
    page.error = "";
    page.width = 0;
    page.height = 0;
    files.delete(key);
    if (t.state === "staged") t.state = "paused";
    storeNow();
    fileRequest.value += 1;
  }

  /** 收到补选的文件：按 文件名+大小 匹配到未完成的页 */
  function provideFiles(list: File[]) {
    const t = task.value;
    if (!t || !list.length) return;
    let matched = 0;
    for (const file of list) {
      const page = t.pages.find(
        (p) =>
          p.status !== "done" &&
          !files.has(p.key) &&
          p.name === file.name &&
          p.size === file.size,
      );
      if (page) {
        files.set(page.key, file);
        matched += 1;
      }
    }
    message.value = matched
      ? `已匹配 ${matched} 个文件`
      : "没有匹配的文件，请选择本批次原图";
    if (!matched) return;
    if (t.state === "preview") void probeAll(t);
    else tryResume(false);
  }

  /**
   * 明确确认后才入库：把暂存页追加到当前文档（不替换任何并发修改），
   * 缺页以占位页标记；额度不足时保留在当前会话并提供导出。
   */
  function confirm() {
    const t = task.value;
    if (!t || busy.value) return;
    if (t.state !== "staged" && t.state !== "quota") return;
    if (t.committedChapterId) {
      // 已入库过：这里只重试持久化，绝不重复追加章节
      if (doc.value.chapters.some((c) => c.id === t.committedChapterId)) {
        if (hooks.persist()) {
          clearTask();
          message.value = "已保存到本地";
        } else {
          message.value = "仍无法写入本地，请导出备份或清理空间";
        }
        return;
      }
      // 上次入库未能持久化（已刷新）：允许重新入库一次
      t.committedChapterId = "";
    }
    const done = t.pages.filter((p) => p.status === "done" && p.page).length;
    if (!done) {
      message.value = "没有可入库的页面";
      return;
    }
    const chapter = buildChapter(t);
    doc.value.chapters.push(chapter);
    t.committedChapterId = chapter.id;
    const ok = hooks.persist();
    hooks.onCommitted();
    if (ok) {
      const missing = chapter.pages.length - done;
      clearTask();
      message.value = missing
        ? `已入库 ${done} 页，${missing} 页以缺页标记`
        : `已入库 ${done} 页`;
    } else {
      t.state = "quota";
      scheduleStore();
      message.value =
        "本地额度不足：章节已保留在当前页面，建议导出已完成部分备份";
    }
  }

  /** 额度不足时的逃生口：导出已完成部分（缺页以占位页标记） */
  function exportDone() {
    const t = task.value;
    if (!t) return;
    if (!t.pages.some((p) => p.status === "done")) {
      message.value = "还没有已完成的页可导出";
      return;
    }
    exportChapter(t, buildChapter(t));
    message.value = "已导出已完成部分（JSON），缺页以占位页标记";
  }

  function discard() {
    if (!task.value) return;
    clearTask();
    message.value = "已放弃导入任务";
  }

  function reset() {
    clearTask();
    doc.value = demoDocument();
    hooks.onReset();
    message.value = "已打开内置漫画";
  }

  // ---------- 刷新恢复 ----------

  const restored = readTask();
  if (restored) {
    const alreadyCommitted =
      restored.committedChapterId &&
      doc.value.chapters.some((c) => c.id === restored.committedChapterId);
    if (alreadyCommitted) {
      persistTask(null);
    } else {
      // 入库过但没存上：回到待确认，可重新确认或导出
      if (restored.committedChapterId) restored.state = "staged";
      task.value = restored;
      message.value = "已恢复未完成的导入任务，可继续或确认入库";
    }
  }

  return {
    busy,
    message,
    task,
    fileRequest,
    quotaBytes,
    beginImport,
    provideFiles,
    setMode,
    reorder,
    start,
    pause,
    resume,
    retry,
    confirm,
    exportDone,
    discard,
    reset,
  };
}
