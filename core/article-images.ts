import fs from "node:fs";
import path from "node:path";
import { ASSETS_DIR } from "./config.js";

export interface ArticleImage { file: string; url: string }
const IMAGE_FILE = /\.(?:png|jpe?g|gif|webp|svg)$/i;

/** Resolve only directories inside this library, including legacy assets\\id values. */
export function getArticleImagesDir(imagesDir: string): string {
  const rel = imagesDir.replace(/^assets[\\/]/, "");
  const base = path.resolve(ASSETS_DIR);
  const dir = path.resolve(base, rel);
  if (!rel || dir === base || !dir.startsWith(base + path.sep)) throw new Error("文章图片目录无效");
  return dir;
}

/** The manifest is the authoritative image order. Older libraries use numeric filenames. */
export function getArticleImageFiles(imagesDir: string): string[] {
  const dir = getArticleImagesDir(imagesDir);
  if (!fs.existsSync(dir)) return [];
  const manifest = path.join(dir, "images.json");
  if (fs.existsSync(manifest)) {
    const parsed = JSON.parse(fs.readFileSync(manifest, "utf8"));
    if (parsed?.version !== 1 || !Array.isArray(parsed.images)) throw new Error("文章图片清单无效");
    const files: string[] = parsed.images.map((entry: unknown) => {
      const file = (entry as ArticleImage | null)?.file;
      if (typeof file !== "string" || /[\\/]/.test(file) || file !== path.basename(file) || !IMAGE_FILE.test(file) || !fs.statSync(path.join(dir, file), { throwIfNoEntry: false })?.isFile()) {
        throw new Error("文章图片清单含无效或缺失文件");
      }
      return file;
    });
    if (new Set(files).size !== files.length) throw new Error("文章图片清单含重复文件");
    return files;
  }
  return fs.readdirSync(dir)
    .filter((file) => IMAGE_FILE.test(file) && fs.statSync(path.join(dir, file)).isFile())
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
}

export function writeArticleImageManifest(imagesDir: string, images: ArticleImage[]): void {
  fs.writeFileSync(path.join(getArticleImagesDir(imagesDir), "images.json"), JSON.stringify({ version: 1, images }, null, 2), "utf8");
}

export function getArticleImageUrl(imagesDir: string, file: string): string {
  const relative = path.relative(ASSETS_DIR, getArticleImagesDir(imagesDir));
  if (/[\\/]/.test(file) || !IMAGE_FILE.test(file)) throw new Error("文章图片文件名无效");
  return "/assets/" + [...relative.split(path.sep), file].map(encodeURIComponent).join("/");
}
