import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { RAW_DIR } from "./config.js";
import { fetchHtml, downloadImage, extFromWxFmt } from "./fetch.js";
import { parseArticle, articleIdFromUrl } from "./parse.js";
import { extractCards } from "./extract.js";
import { verifyPalette, checkUrl, type ColorCheck, type UrlCheck } from "./verify.js";
import { replaceArticle, getArticle, listItems, type ArticleRow } from "./store.js";
import { getArticleImagesDir, writeArticleImageManifest, type ArticleImage } from "./article-images.js";

export interface IngestResult {
  skipped?: boolean;
  articleId: string;
  title: string;
  account: string;
  articleType: string;
  summary: string;
  tags: string[];
  counts: Record<string, number>;
  unsureCount: number;
  items: { type: string; title: string; detail: string }[];
}

const articleRuns = new Map<string, Promise<IngestResult>>();

export async function ingest(
  url: string,
  opts: { offline?: boolean; refresh?: boolean } = {},
): Promise<IngestResult> {
  const articleId = articleIdFromUrl(url);
  const previous = articleRuns.get(articleId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(() => ingestArticle(url, opts));
  articleRuns.set(articleId, current);
  try { return await current; }
  finally { if (articleRuns.get(articleId) === current) articleRuns.delete(articleId); }
}

async function ingestArticle(
  url: string,
  opts: { offline?: boolean; refresh?: boolean } = {},
): Promise<IngestResult> {
  const articleId = articleIdFromUrl(url);
  const existing = getArticle(articleId);
  if (existing?.processed_at && existing.status === "ok" && !opts.refresh) return existingResult(existing);

  // 1. HTML：离线缓存优先，否则抓取；refresh 强制在线重抓（reprocess）。成功入库后再写 raw 缓存。
  let html: string;
  let freshHtml: string | null = null;
  const cachePath = path.join(RAW_DIR, `${articleId}.html`);
  if (opts.offline && !url.startsWith("http")) {
    html = fs.readFileSync(url, "utf8"); // offline 模式 url 传本地 html 路径
  } else {
    fs.mkdirSync(RAW_DIR, { recursive: true });
    if (opts.refresh || !fs.existsSync(cachePath)) {
      freshHtml = await fetchHtml(url); // 失败向上抛，不改库
      html = freshHtml;
    } else {
      html = fs.readFileSync(cachePath, "utf8");
    }
  }

  // 2. 解析（元数据与卡片均在提取成功后才写入，失败不改库）
  const meta = parseArticle(html, url.startsWith("http") ? url : `https://mp.weixin.qq.com/s/${articleId}`);
  if (meta.images.length === 0 && meta.text.length < 50) {
    throw new Error("未获取到有效正文或图片，请检查原文是否可访问；已有内容未变更");
  }

  // Every attempt builds a complete, independent image set. The DB points to it only after success.
  const imagesName = `${meta.id}-${crypto.randomUUID()}`;
  const imagesDir = getArticleImagesDir(imagesName);
  fs.mkdirSync(imagesDir, { recursive: true });
  let committed = false;
  try {
    const imagePaths: string[] = [];
    const imageManifest: ArticleImage[] = [];
    for (let i = 0; i < meta.images.length; i++) {
      const file = `img-${i}.${extFromWxFmt(meta.images[i])}`;
      const dest = path.join(imagesDir, file);
      try {
        await downloadImage(meta.images[i], dest);
      } catch (e) {
        throw new Error(`图片 ${i + 1}/${meta.images.length} 下载失败，已有内容未变更：${(e as Error).message}`);
      }
      imagePaths.push(dest);
      imageManifest.push({ file, url: meta.images[i] });
    }
    writeArticleImageManifest(imagesName, imageManifest);

    // 4. 视觉提取
    console.log(`  [extract] ${meta.title} — 文字 ${meta.text.length} 字，图片 ${imagePaths.length} 张`);
    const images = imagePaths.map((p) => fs.readFileSync(p));
    const extraction = await extractCards(meta, images);
    console.log(`  [extract] ${extraction.items.length} 张卡片，类型=${extraction.articleType}`);

    // 5. 校验
    const verifyResults = new Map<string, { status: string; detail: unknown }>();
    let unsureCount = 0;
    for (const it of extraction.items) {
      if (it.type === "palette") {
        const src = imagePaths[it.source_image_index ?? 0];
        if (src && it.payload?.colors?.length) {
          const checks: ColorCheck[] = await verifyPalette(it.payload.colors, src);
          const ok = checks.every((c) => c.ok);
          if (!ok) unsureCount++;
          verifyResults.set(keyOf(it), { status: ok ? "ok" : "unsure", detail: checks });
        }
      } else if (it.type === "website" || it.type === "repo") {
        const check: UrlCheck = await checkUrl(it.payload!.url!);
        verifyResults.set(keyOf(it), { status: check.alive ? "ok" : "dead", detail: check });
      }
    }
    if (unsureCount) console.log(`  [verify] ${unsureCount} 张色卡待人工核对`);

    // 6. 入库（标签只保留"类型"这一层维度，主题标签不再自动写入 items）
    replaceArticle({
      id: meta.id, url: meta.url, title: meta.title, account: meta.account,
      publishDate: meta.publishDate, description: meta.description,
      summary: extraction.articleSummary, articleType: extraction.articleType,
      tags: extraction.tags, imagesDir: imagesName, // versioned relative directory remains portable
      status: "ok", processed: true,
    }, extraction.items, verifyResults);
    committed = true;
    // A cache/cleanup failure must not report an already committed extraction as a failed job.
    if (freshHtml !== null) {
      try {
        fs.mkdirSync(RAW_DIR, { recursive: true });
        fs.writeFileSync(cachePath, freshHtml, "utf8");
      } catch (e) { console.warn(`[cache] HTML 缓存未更新: ${(e as Error).message}`); }
    }
    if (existing?.images_dir && existing.images_dir !== imagesName) removeImageDirectory(existing.images_dir);

    const counts: Record<string, number> = {};
    for (const it of extraction.items) counts[it.type] = (counts[it.type] ?? 0) + 1;

    return {
      articleId: meta.id, title: meta.title, account: meta.account,
      articleType: extraction.articleType, summary: extraction.articleSummary, tags: extraction.tags,
      counts, unsureCount,
      items: extraction.items.map((it) => ({
        type: it.type, title: it.title,
        detail: it.type === "palette" ? (it.payload?.colors ?? []).map((c) => c.hex).join(" ")
          : it.type === "note" ? `${(it.payload?.sections ?? []).length} 节`
          : (it.payload?.url ?? (it.payload?.text ?? "").slice(0, 60) + "…"),
      })),
    };
  } finally {
    if (!committed) removeImageDirectory(imagesName);
  }
}

function removeImageDirectory(imagesDir: string): void {
  try {
    // Resolve and verify the complete absolute target before any recursive removal.
    fs.rmSync(getArticleImagesDir(imagesDir), { recursive: true, force: true });
  } catch (e) { console.warn(`[images] 旧或未完成图片清理失败: ${(e as Error).message}`); }
}

function existingResult(article: ArticleRow): IngestResult {
  const rows = listItems({ articleId: article.id, limit: -1 });
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.type] = (counts[row.type] ?? 0) + 1;
  return {
    skipped: true, articleId: article.id, title: article.title, account: article.account,
    articleType: article.article_type, summary: article.summary,
    tags: JSON.parse(article.tags || "[]"), counts,
    unsureCount: rows.filter((row) => row.verify_status === "unsure").length,
    items: rows.map((row) => ({ type: row.type, title: row.title, detail: "已在本地库中，跳过重复提取" })),
  };
}

function keyOf(it: { type: string; title: string; payload?: unknown }): string {
  return JSON.stringify([it.type, it.title, it.payload]);
}

/** 重新处理已入库文章（例如换模型后重跑提取）：强制在线重抓，失败不改库 */
export async function reprocess(articleId: string): Promise<IngestResult> {
  const a = getArticle(articleId);
  if (!a) throw new Error(`文章不存在: ${articleId}`);
  return ingest(a.url, { refresh: true });
}
