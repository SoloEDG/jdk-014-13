import type { Chapter } from "../../../shared/document";
import type { ImportTask } from "./importTask";

const TASK_KEY = "panel-jdk014-import-v1";
const STATES = new Set(["preview", "running", "paused", "staged", "quota"]);
const STATUS = new Set(["pending", "processing", "done", "failed"]);

/** 持久化任务（含暂存页），返回是否写入成功；失败说明本地额度不足 */
export function persistTask(task: ImportTask | null): boolean {
  try {
    if (task) localStorage.setItem(TASK_KEY, JSON.stringify(task));
    else localStorage.removeItem(TASK_KEY);
    return true;
  } catch {
    return false;
  }
}

/** 刷新后恢复任务：运行中一律转为已暂停，等待用户继续 */
export function readTask(): ImportTask | null {
  try {
    const raw = localStorage.getItem(TASK_KEY);
    if (!raw) return null;
    const task = JSON.parse(raw) as ImportTask;
    if (
      !task ||
      typeof task.id !== "string" ||
      typeof task.title !== "string" ||
      !STATES.has(task.state) ||
      (task.mode !== "fidelity" && task.mode !== "saver") ||
      !Array.isArray(task.pages) ||
      !task.pages.length
    )
      return null;
    for (const p of task.pages) {
      if (
        typeof p?.key !== "string" ||
        typeof p.name !== "string" ||
        typeof p.size !== "number" ||
        !STATUS.has(p.status)
      )
        return null;
      if (p.status === "processing") p.status = "pending";
      if (p.status === "done" && typeof p.page?.image !== "string") {
        p.status = "pending";
        p.page = null;
      }
      if (p.status !== "done") p.page = null;
      p.width = typeof p.width === "number" ? p.width : 0;
      p.height = typeof p.height === "number" ? p.height : 0;
      p.error = typeof p.error === "string" ? p.error : "";
      p.attempts = typeof p.attempts === "number" ? p.attempts : 0;
    }
    if (task.state === "running" || task.state === "preview")
      task.state = "paused";
    task.committedChapterId =
      typeof task.committedChapterId === "string" ? task.committedChapterId : "";
    return task;
  } catch {
    return null;
  }
}

/** 额度不足时把已完成部分导出为 JSON，而不是整批丢弃 */
export function exportChapter(task: ImportTask, chapter: Chapter): void {
  const done = task.pages.filter((p) => p.status === "done").length;
  const payload = {
    app: "PANEL",
    kind: "chapter-export",
    version: 1,
    exportedAt: new Date().toISOString(),
    title: chapter.title,
    completedPages: done,
    totalPages: task.pages.length,
    chapter,
  };
  const blob = new Blob([JSON.stringify(payload)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${chapter.title.replace(/[\\/:*?"<>|]/g, "_")}-已完成${done}页.json`;
  a.click();
  URL.revokeObjectURL(url);
}
