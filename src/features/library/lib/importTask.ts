import type { Chapter, ComicPage } from "../../../shared/document";
import { makeId } from "../../../shared/commands";

export type ImportMode = "fidelity" | "saver";
export type PageStatus = "pending" | "processing" | "done" | "failed";
export type TaskState = "preview" | "running" | "paused" | "staged" | "quota";

export interface ImportPageTask {
  /** 幂等键：文件名 + 大小 + 同名单元序号，重试/续传都靠它定位 */
  key: string;
  name: string;
  size: number;
  width: number;
  height: number;
  status: PageStatus;
  error: string;
  attempts: number;
  /** 暂存页：只在确认入库前存在于任务里，不进入文档 */
  page: ComicPage | null;
}

export interface ImportTask {
  id: string;
  created: number;
  mode: ImportMode;
  title: string;
  state: TaskState;
  /** 确认成功后记录章节 id，用于重复确认/刷新后的幂等判断 */
  committedChapterId: string;
  pages: ImportPageTask[];
}

export const MAX_IMPORT_FILES = 60;
export const SAVER_MAX_EDGE = 1600;
export const SAVER_QUALITY = 0.82;

/** base64 DataURL 相对原始字节的膨胀系数 */
const BASE64_OVERHEAD = 1.37;
/** JPEG(0.82) 漫画图的经验字节/像素系数 */
const JPEG_BYTES_PER_PIXEL = 0.22;

export function byPageName(a: File, b: File): number {
  return a.name.localeCompare(b.name, undefined, { numeric: true });
}

/** 把文件列表按页序排序并配发幂等键 */
export function pairFiles(files: File[]): Array<[string, File]> {
  const sorted = [...files].sort(byPageName);
  const seen = new Map<string, number>();
  return sorted.map((file) => {
    const base = `${file.name}:${file.size}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return [`${base}#${n}`, file];
  });
}

export function createTask(files: File[]): ImportTask {
  const pairs = pairFiles(files);
  const first = pairs[0]![1];
  return {
    id: makeId("import"),
    created: Date.now(),
    mode: "fidelity",
    title: `导入章节 · ${first.name.replace(/\.[^.]+$/, "")}`,
    state: "preview",
    committedChapterId: "",
    pages: pairs.map(([key, file]) => ({
      key,
      name: file.name,
      size: file.size,
      width: 0,
      height: 0,
      status: "pending",
      error: "",
      attempts: 0,
      page: null,
    })),
  };
}

export function summarize(task: ImportTask) {
  const total = task.pages.length;
  const done = task.pages.filter((p) => p.status === "done").length;
  const failed = task.pages.filter((p) => p.status === "failed").length;
  return {
    total,
    done,
    failed,
    pending: total - done - failed,
    /** 确认时将变成缺页占位页的数量 */
    missing: total - done,
  };
}

/** 按当前模式估算入库后的本地占用 */
export function estimateBytes(
  pages: ImportPageTask[],
  mode: ImportMode,
): number {
  let bytes = 0;
  for (const p of pages) {
    if (mode === "saver" && p.width > 0 && p.height > 0) {
      const scale = Math.min(1, SAVER_MAX_EDGE / Math.max(p.width, p.height));
      bytes +=
        p.width * scale * (p.height * scale) * JPEG_BYTES_PER_PIXEL * BASE64_OVERHEAD;
    } else {
      bytes += p.size * BASE64_OVERHEAD * (mode === "saver" ? 0.5 : 1);
    }
  }
  return Math.round(bytes);
}

export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

export function movePage(
  task: ImportTask,
  key: string,
  delta: number,
): boolean {
  if (task.state !== "preview") return false;
  const i = task.pages.findIndex((p) => p.key === key);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= task.pages.length) return false;
  const [page] = task.pages.splice(i, 1);
  task.pages.splice(j, 0, page!);
  return true;
}

function escapeXml(value: string): string {
  return value.replace(
    /[<>&'"]/g,
    (c) =>
      ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[
        c
      ]!,
  );
}

/** 缺页占位页：入库后明确标示哪一页没能导入 */
export function missingPage(name: string): ComicPage {
  const safe = escapeXml(name);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1200" viewBox="0 0 900 1200">` +
    `<rect width="900" height="1200" fill="#17141f"/>` +
    `<rect x="60" y="60" width="780" height="1080" fill="none" stroke="#4a4157" stroke-width="3" stroke-dasharray="14 12"/>` +
    `<text x="450" y="552" fill="#8d80a3" font-size="46" text-anchor="middle" font-family="sans-serif">此页缺失</text>` +
    `<text x="450" y="626" fill="#5f586c" font-size="24" text-anchor="middle" font-family="sans-serif">${safe}</text>` +
    `<text x="450" y="690" fill="#5f586c" font-size="20" text-anchor="middle" font-family="sans-serif">导入时未能完成，可在导入任务中重试</text>` +
    `</svg>`;
  return {
    id: makeId("page"),
    title: `缺页 · ${name}`,
    image: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
    width: 900,
    height: 1200,
    panels: [
      {
        id: makeId("panel"),
        rect: { x: 0, y: 0, width: 900, height: 1200 },
        dialogue: "这一页未能成功导入。",
        speaker: "旁白",
        sound: "wind",
        duration: 4,
      },
    ],
  };
}

/**
 * 把暂存页组装成章节：只追加、不替换文档其它内容；
 * 未完成的页以缺页占位页标记，保证页序完整可读。
 */
export function buildChapter(task: ImportTask): Chapter {
  const pages = task.pages.map((p) => p.page ?? missingPage(p.name));
  const missing = pages.length - task.pages.filter((p) => p.page).length;
  return {
    id: makeId("chapter"),
    title: task.title,
    subtitle: `本地导入 / ${pages.length - missing} 页${
      missing ? ` · 缺 ${missing} 页` : ""
    }`,
    pages,
  };
}
