import fs from "node:fs";
import path from "node:path";
import { RAW_DIR, ASSETS_DIR } from "./config.js";
import { fetchHtml, downloadImage, extFromWxFmt } from "./fetch.js";
import { parseArticle, articleIdFromUrl } from "./parse.js";
import { extractCards } from "./extract.js";
import { verifyPalette, checkUrl, type ColorCheck, type UrlCheck } from "./verify.js";
import { upsertArticle, replaceItems, getArticle } from "./store.js";

export interface IngestResult {
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

export async function ingest(url: string, opts: { offline?: boolean } = {}): Promise<IngestResult> {
  const articleId = articleIdFromUrl(url);

  // 1. HTML：离线缓存优先，否则抓取
  let html: string;
  if (opts.offline && !url.startsWith("http")) {
    html = fs.readFileSync(url, "utf8"); // offline 模式 url 传本地 html 路径
  } else {
    fs.mkdirSync(RAW_DIR, { recursive: true });
    const cachePath = path.join(RAW_DIR, `${articleId}.html`);
    if (fs.existsSync(cachePath)) {
      html = fs.readFileSync(cachePath, "utf8");
    } else {
      html = await fetchHtml(url);
      fs.writeFileSync(cachePath, html, "utf8");
    }
  }

  // 2. 解析
  const meta = parseArticle(html, url.startsWith("http") ? url : `https://mp.weixin.qq.com/s/${articleId}`);
  upsertArticle({
    id: meta.id, url: meta.url, title: meta.title, account: meta.account,
    publishDate: meta.publishDate, description: meta.description,
    status: "ok",
  });

  // 3. 下载正文图片
  const imagesDir = path.join(ASSETS_DIR, meta.id);
  fs.mkdirSync(imagesDir, { recursive: true });
  const imagePaths: string[] = [];
  for (let i = 0; i < meta.images.length; i++) {
    const dest = path.join(imagesDir, `img-${i}.${extFromWxFmt(meta.images[i])}`);
    if (!fs.existsSync(dest)) {
      try {
        await downloadImage(meta.images[i], dest);
      } catch (e) {
        console.warn(`  [warn] 图片 ${i} 下载失败: ${(e as Error).message}`);
        continue;
      }
    }
    imagePaths.push(dest);
  }

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
      verifyResults.set(keyOf(it), { status: "ok", detail: check });
    }
  }
  if (unsureCount) console.log(`  [verify] ${unsureCount} 张色卡待人工核对`);

  // 6. 入库（标签只保留"类型"这一层维度，主题标签不再自动写入 items）
  upsertArticle({
    id: meta.id, url: meta.url, title: meta.title, account: meta.account,
    publishDate: meta.publishDate, description: meta.description,
    summary: extraction.articleSummary, articleType: extraction.articleType,
    tags: extraction.tags, imagesDir: path.relative(process.cwd(), imagesDir),
    status: "ok", processed: true,
  });
  replaceItems(meta.id, extraction.items, verifyResults);

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
}

function keyOf(it: { type: string; title: string; payload?: unknown }): string {
  return JSON.stringify([it.type, it.title, it.payload]);
}

/** 重新处理已入库文章（例如换模型后重跑提取） */
export async function reprocess(articleId: string): Promise<IngestResult> {
  const a = getArticle(articleId);
  if (!a) throw new Error(`文章不存在: ${articleId}`);
  return ingest(a.url);
}
