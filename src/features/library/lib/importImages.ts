import type { ComicPage } from "../../../shared/document";
import { makeId } from "../../../shared/commands";
import {
  SAVER_MAX_EDGE,
  SAVER_QUALITY,
  type ImportMode,
} from "./importTask";

const ACCEPTED = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_PIXELS = 40000000;

function checkFile(file: File): void {
  if (!ACCEPTED.includes(file.type))
    throw new Error(`不支持 ${file.name}，请选择 PNG、JPG、WebP 或 GIF`);
  if (file.size > MAX_FILE_BYTES)
    throw new Error(`${file.name} 超过 8 MB 上限`);
}

function checkPixels(width: number, height: number): void {
  if (width * height > MAX_PIXELS) throw new Error("图片分辨率过大");
}

function makePage(
  name: string,
  image: string,
  width: number,
  height: number,
): ComicPage {
  return {
    id: makeId("page"),
    title: name,
    image,
    width,
    height,
    panels: [
      {
        id: makeId("panel"),
        rect: { x: 0, y: 0, width, height },
        dialogue: "在这一页，留下属于你的故事。",
        speaker: "旁白",
        sound: "wind",
        duration: 5,
      },
    ],
  };
}

async function decode(file: File): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file);
  } catch {
    throw new Error("图片无法解码");
  }
}

/** 保真：保留原始文件内容，仅读取尺寸 */
async function readFidelity(file: File): Promise<ComicPage> {
  const image = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("图片读取失败"));
    r.readAsDataURL(file);
  });
  const dimensions = await new Promise<{ width: number; height: number }>(
    (resolve, reject) => {
      const img = new Image();
      img.onload = () =>
        resolve({ width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => reject(new Error("图片无法解码"));
      img.src = image;
    },
  );
  checkPixels(dimensions.width, dimensions.height);
  return makePage(file.name, image, dimensions.width, dimensions.height);
}

/** 节省空间：长边压到 1600px 以内并转码为 JPEG（GIF 会变为静态图） */
async function readSaver(file: File): Promise<ComicPage> {
  const bitmap = await decode(file);
  try {
    checkPixels(bitmap.width, bitmap.height);
    const scale = Math.min(
      1,
      SAVER_MAX_EDGE / Math.max(bitmap.width, bitmap.height),
    );
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("当前浏览器不支持图像压缩");
    ctx.drawImage(bitmap, 0, 0, width, height);
    return makePage(file.name, canvas.toDataURL("image/jpeg", SAVER_QUALITY), width, height);
  } finally {
    bitmap.close();
  }
}

export function processPage(file: File, mode: ImportMode): Promise<ComicPage> {
  checkFile(file);
  return mode === "saver" ? readSaver(file) : readFidelity(file);
}

/** 预览阶段探测尺寸，用于估算占用；失败说明该页无法导入 */
export async function probeImage(
  file: File,
): Promise<{ width: number; height: number }> {
  checkFile(file);
  const bitmap = await decode(file);
  const dimensions = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  checkPixels(dimensions.width, dimensions.height);
  return dimensions;
}
