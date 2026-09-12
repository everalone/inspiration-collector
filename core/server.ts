import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT_DIR, ASSETS_DIR, loadConfig } from "./config.js";
import { listItems, countItems, getItem, updateItem, deleteItem, listArticles, typeCounts, getArticle, type ItemRow } from "./store.js";
import { ingest } from "./ingest.js";

const VIEWER_DIR = path.join(ROOT_DIR, "viewer");

/** 文章原图目录：兼容旧库存的 "assets\<id>" 与新库存的 "<id>" 两种 images_dir */
function imagesDirOf(imagesDir: string): string {
  const rel = imagesDir.replace(/^assets[\\/]/, "");
  return path.join(ASSETS_DIR, rel);
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".ico": "image/x-icon",
};

function sendJson(res: http.ServerResponse, code: number, data: unknown): boolean {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
  return true;
}

function sendFile(res: http.ServerResponse, filePath: string): void {
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    "Content-Type": MIME[ext] ?? "application/octet-stream",
    "Cache-Control": "no-cache", // 开发迭代期始终拿最新文件
  });
  fs.createReadStream(filePath).pipe(res);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 5_000_000) reject(new Error("body 过大")); });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  const p = url.pathname;
  if (!p.startsWith("/api/")) return false;

  if (req.method === "GET") {
    if (p === "/api/crop") {
      const q = url.searchParams;
      const id = q.get("article") ?? "";
      const idx = Number(q.get("idx") ?? 0);
      const box = ["x1", "y1", "x2", "y2"].map((k) => Number(q.get(k)));
      const a = getArticle(id);
      const dir = a?.images_dir ? imagesDirOf(a.images_dir) : "";
      const files = dir && fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
      const file = files[idx];
      if (!a || !file || box.some((n) => !Number.isFinite(n))) {
        return sendJson(res, 404, { error: "crop source not found" });
      }
      const { default: sharp } = await import("sharp");
      const img = sharp(path.join(dir, file));
      const meta = await img.metadata();
      const W = meta.width ?? 0, H = meta.height ?? 0;
      if (!W || !H) return sendJson(res, 404, { error: "unreadable image" });
      const left = Math.max(0, Math.min(W - 10, Math.round((box[0] / 1000) * W)));
      const top = Math.max(0, Math.min(H - 10, Math.round((box[1] / 1000) * H)));
      const width = Math.max(10, Math.min(W - left, Math.round(((box[2] - box[0]) / 1000) * W)));
      const height = Math.max(10, Math.min(H - top, Math.round(((box[3] - box[1]) / 1000) * H)));
      const buf = await img.extract({ left, top, width, height }).jpeg({ quality: 86 }).toBuffer();
      res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "max-age=31536000, immutable" });
      res.end(buf);
      return true;
    }
    if (p === "/api/bootstrap") {
      const articles = listArticles();
      return sendJson(res, 200, {
        typeCounts: typeCounts(),
        unsureCount: countItems({ verify: "unsure" }),
        articleCount: articles.length,
      });
    }
    if (p === "/api/items") {
      const q = url.searchParams;
      const filter = {
        type: q.get("type") ?? undefined, tag: q.get("tag") ?? undefined,
        q: q.get("q") ?? undefined, verify: q.get("verify") ?? undefined,
      };
      const rows = listItems(filter);
      const withSource = rows.map((r) => ({ ...r, article: getArticle(r.article_id) }));
      return sendJson(res, 200, { total: countItems(filter), items: withSource });
    }
    if (p === "/api/articles") return sendJson(res, 200, listArticles());
    if (p === "/api/article-images") {
      const id = url.searchParams.get("id") ?? "";
      const a = getArticle(id);
      const dir = a?.images_dir ? imagesDirOf(a.images_dir) : "";
      const files = dir && fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
      return sendJson(res, 200, { images: files.map((f) => `/assets/${id}/${f}`) });
    }
    return sendJson(res, 404, { error: "unknown api" });
  }

  if (req.method === "POST" && p === "/api/ingest") {
    const body = JSON.parse(await readBody(req)) as { url: string };
    if (!body.url?.includes("mp.weixin.qq.com")) return sendJson(res, 400, { error: "请粘贴微信公众号文章链接" });
    try {
      const r = await ingest(body.url);
      return sendJson(res, 200, r);
    } catch (e) {
      return sendJson(res, 500, { error: (e as Error).message });
    }
  }

  const m = p.match(/^\/api\/items\/([\w-]+)$/);
  if (m) {
    const id = m[1];
    if (req.method === "PATCH") {
      const patch = JSON.parse(await readBody(req)) as { title?: string; payload?: unknown; tags?: string[] };
      updateItem(id, patch);
      return sendJson(res, 200, getItem(id));
    }
    if (req.method === "DELETE") {
      deleteItem(id);
      return sendJson(res, 200, { ok: true });
    }
  }
  return sendJson(res, 404, { error: "unknown api" });
}

export function startServer(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${port}`);
      try {
        if (await handleApi(req, res, url)) return;
        // 静态资源
        let rel = decodeURIComponent(url.pathname);
        if (rel === "/") rel = "/index.html";
        if (rel.startsWith("/assets/")) {
          const fp = path.join(ASSETS_DIR, rel.slice("/assets/".length));
          if (fs.existsSync(fp) && fs.statSync(fp).isFile()) return sendFile(res, fp);
          res.writeHead(404); return res.end();
        }
        const fp = path.join(VIEWER_DIR, path.normalize(rel).replace(/^([./\\])+/, ""));
        if (fp.startsWith(VIEWER_DIR) && fs.existsSync(fp) && fs.statSync(fp).isFile()) return sendFile(res, fp);
        res.writeHead(404); res.end("not found");
      } catch (e) {
        sendJson(res, 500, { error: (e as Error).message });
      }
    });
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      console.log(`卡片墙已启动: http://127.0.0.1:${port}`);
      resolve();
    });
  });
}
