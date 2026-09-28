import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { ROOT_DIR, ASSETS_DIR, loadConfig, saveConfig } from "./config.js";
import { listItems, countItems, getItem, updateItem, deleteItem, deleteArticle, listArticles, typeCounts, getArticle } from "./store.js";
import { startInboxPoller, stopInboxPoller, getInboxStatus, listInboxFailures, retryInboxItem } from "./inbox-client.js";
import { getTaskQueue, runCollection, runReprocess, normalizeArticleUrl, redactTaskError } from "./tasks.js";
import { getArticleImageFiles, getArticleImagesDir, getArticleImageUrl } from "./article-images.js";
import { articleIdFromUrl } from "./parse.js";

// viewer 静态目录：开发态在项目根；打包态在应用根（asar），由主进程通过环境变量注入
const VIEWER_DIR = process.env.INSPIRATION_APP_ROOT
  ? path.join(process.env.INSPIRATION_APP_ROOT, "viewer")
  : path.join(ROOT_DIR, "viewer");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".ico": "image/x-icon",
};

function sendJson(res: http.ServerResponse, code: number, data: unknown): boolean {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
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
    if (p === "/api/config") {
      const c = loadConfig();
      return sendJson(res, 200, {
        hasKey: !!c.apiKey,
        keyMasked: c.apiKey ? c.apiKey.slice(0, 6) + "…" + c.apiKey.slice(-4) : "",
        baseUrl: c.baseUrl,
        model: c.model,
        inboxUrl: c.inboxUrl,
        inboxTokenSet: !!c.inboxToken,
        inboxEnabled: c.inboxEnabled,
        inboxIntervalSec: c.inboxIntervalSec,
      });
    }
    if (p === "/api/tasks") return sendJson(res, 200, { tasks: getTaskQueue().list(), inbox: getInboxStatus() });
    if (p === "/api/inbox/failed") return sendJson(res, 200, await listInboxFailures());
    if (p === "/api/crop") {
      const q = url.searchParams;
      const id = q.get("article") ?? "";
      const idx = Number(q.get("idx") ?? 0);
      const box = ["x1", "y1", "x2", "y2"].map((k) => Number(q.get(k)));
      const a = getArticle(id);
      const dir = a?.images_dir ? getArticleImagesDir(a.images_dir) : "";
      const files = a?.images_dir ? getArticleImageFiles(a.images_dir) : [];
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
      res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "no-cache" });
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
        limit: Math.min(500, Math.max(1, Number.parseInt(q.get("limit") || "200", 10) || 200)),
        offset: Math.max(0, Number.parseInt(q.get("offset") || "0", 10) || 0),
      };
      const rows = listItems(filter);
      const withSource = rows.map((r) => ({ ...r, article: getArticle(r.article_id) }));
      return sendJson(res, 200, { total: countItems(filter), items: withSource });
    }
    if (p === "/api/articles") return sendJson(res, 200, listArticles());
    if (p === "/api/article-images") {
      const id = url.searchParams.get("id") ?? "";
      const a = getArticle(id);
      const files = a?.images_dir ? getArticleImageFiles(a.images_dir) : [];
      return sendJson(res, 200, { images: files.map((f) => getArticleImageUrl(a!.images_dir, f)) });
    }
    return sendJson(res, 404, { error: "unknown api" });
  }

  if (req.method === "POST" && p === "/api/config") {
    const body = JSON.parse(await readBody(req)) as {
      apiKey?: string; baseUrl?: string; model?: string;
      inboxUrl?: string; inboxToken?: string; inboxEnabled?: boolean; inboxIntervalSec?: number;
    };
    const patch: Record<string, unknown> = {};
    if (typeof body.apiKey === "string") patch.apiKey = body.apiKey.trim();
    if (typeof body.baseUrl === "string" && body.baseUrl.trim()) patch.baseUrl = body.baseUrl.trim().replace(/\/$/, "");
    if (typeof body.model === "string" && body.model.trim()) patch.model = body.model.trim();
    if (typeof body.inboxUrl === "string") {
      const value = body.inboxUrl.trim().replace(/\/$/, "");
      if (value) {
        try {
          const target = new URL(value);
          const local = ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname);
          if (target.username || target.password || target.search || target.hash ||
              (target.protocol !== "https:" && !(local && target.protocol === "http:"))) throw new Error();
        } catch { return sendJson(res, 400, { error: "收件箱请使用 HTTPS 地址（本机测试可使用 HTTP）" }); }
      }
      patch.inboxUrl = value;
    }
    if (typeof body.inboxToken === "string" && body.inboxToken.trim()) patch.inboxToken = body.inboxToken.trim();
    if (typeof body.inboxEnabled === "boolean") patch.inboxEnabled = body.inboxEnabled;
    if (typeof body.inboxIntervalSec === "number" && Number.isFinite(body.inboxIntervalSec)) {
      patch.inboxIntervalSec = Math.min(120, Math.max(10, Math.round(body.inboxIntervalSec)));
    }
    const saved = saveConfig(patch as Parameters<typeof saveConfig>[0]);
    startInboxPoller();
    return sendJson(res, 200, {
      hasKey: !!saved.apiKey,
      keyMasked: saved.apiKey ? saved.apiKey.slice(0, 6) + "…" + saved.apiKey.slice(-4) : "",
      baseUrl: saved.baseUrl,
      model: saved.model,
      inboxUrl: saved.inboxUrl,
      inboxTokenSet: !!saved.inboxToken,
      inboxEnabled: saved.inboxEnabled,
      inboxIntervalSec: saved.inboxIntervalSec,
    });
  }

  if (req.method === "POST" && p === "/api/tasks") {
    const body = JSON.parse(await readBody(req)) as { url?: string; source?: string };
    try {
      const task = getTaskQueue().enqueue(normalizeArticleUrl(String(body.url ?? "")), body.source === "clipboard" ? "clipboard" : "manual");
      return sendJson(res, 202, { task });
    } catch (e) { return sendJson(res, 400, { error: redactTaskError(e) }); }
  }
  const taskRetry = p.match(/^\/api\/tasks\/([\w-]+)\/retry$/);
  if (req.method === "POST" && taskRetry) {
    const task = getTaskQueue().list().find(t => t.id === taskRetry[1]);
    if (task?.source === "inbox") return sendJson(res, 400, { error: "请从手机收件箱失败列表重新排队" });
    try { return sendJson(res, 200, { task: getTaskQueue().retry(taskRetry[1]) }); }
    catch (e) { return sendJson(res, 400, { error: redactTaskError(e) }); }
  }
  if (req.method === "POST" && p === "/api/inbox/retry") {
    const body = JSON.parse(await readBody(req)) as { id?: string };
    if (!body.id) return sendJson(res, 400, { error: "请选择失败任务" });
    return sendJson(res, 200, await retryInboxItem(body.id));
  }

  if (req.method === "POST" && p === "/api/ingest") {
    const body = JSON.parse(await readBody(req)) as { url: string };
    try {
      const r = await runCollection(normalizeArticleUrl(String(body.url ?? "")));
      return sendJson(res, 200, r);
    } catch (e) {
      return sendJson(res, 500, { error: redactTaskError(e) });
    }
  }

  if (req.method === "POST" && p === "/api/articles/reprocess") {
    const body = JSON.parse(await readBody(req)) as { ids?: string[] };
    const ids = Array.isArray(body.ids) ? body.ids.filter((x) => typeof x === "string" && x) : [];
    if (!ids.length) return sendJson(res, 400, { error: "请选择要重跑的文章" });
    const results: {
      id: string; ok: boolean; title?: string;
      counts?: Record<string, number>; error?: string;
    }[] = [];
    for (const id of ids) {
      try {
        const article = getArticle(id);
        if (!article) throw new Error("文章不存在");
        const r = await runReprocess(article.url);
        results.push({ id, ok: true, title: r.title, counts: r.counts });
      } catch (e) {
        results.push({ id, ok: false, error: redactTaskError(e) });
      }
    }
    return sendJson(res, 200, { results });
  }

  if (req.method === "POST" && p === "/api/inbox/drain") {
    const { drainInboxOnce } = await import("./inbox-client.js");
    const r = await drainInboxOnce();
    return sendJson(res, 200, r);
  }

  const m = p.match(/^\/api\/items\/([\w-]+)$/);
  if (m) {
    const id = m[1];
    if (req.method === "PATCH") {
      if (!getItem(id)) return sendJson(res, 404, { error: "卡片不存在" });
      const patch = JSON.parse(await readBody(req)) as { title?: string; payload?: unknown; tags?: string[] };
      updateItem(id, patch);
      return sendJson(res, 200, getItem(id));
    }
    if (req.method === "DELETE") {
      deleteItem(id);
      return sendJson(res, 200, { ok: true });
    }
  }

  const am = p.match(/^\/api\/articles\/([\w-]+)$/);
  if (am && req.method === "DELETE") {
    const active = getTaskQueue().list().some(task =>
      ["queued", "running"].includes(task.status) && articleIdFromUrl(task.url) === am[1]);
    if (active) return sendJson(res, 409, { error: "这篇文章正在收集或等待重跑，请任务结束后再删除" });
    deleteArticle(am[1]);
    return sendJson(res, 200, { ok: true });
  }
  return sendJson(res, 404, { error: "unknown api" });
}

export function startServer(port: number): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    // Validate saved tasks before listening so startup errors reject cleanly.
    const queue = getTaskQueue();
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${port}`);
      try {
        const host = req.headers.host ?? "";
        if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) {
          sendJson(res, 403, { error: "仅支持本机访问" }); return;
        }
        if (!["GET", "HEAD"].includes(req.method ?? "") && req.headers.origin &&
            req.headers.origin !== `http://${host}`) {
          sendJson(res, 403, { error: "不允许跨站修改本地数据" }); return;
        }
        if (await handleApi(req, res, url)) return;
        // 静态资源
        let rel = decodeURIComponent(url.pathname);
        if (rel === "/") rel = "/index.html";
        if (rel.startsWith("/assets/")) {
          const fp = path.join(ASSETS_DIR, rel.slice("/assets/".length));
          if (fp.startsWith(ASSETS_DIR + path.sep) && fs.existsSync(fp) && fs.statSync(fp).isFile()) return sendFile(res, fp);
          res.writeHead(404); return res.end();
        }
        const fp = path.join(VIEWER_DIR, path.normalize(rel).replace(/^([./\\])+/, ""));
        if (fp.startsWith(VIEWER_DIR + path.sep) && fs.existsSync(fp) && fs.statSync(fp).isFile()) return sendFile(res, fp);
        res.writeHead(404); res.end("not found");
      } catch (e) {
        sendJson(res, 500, { error: redactTaskError(e) });
      }
    });
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      console.log(`卡片墙已启动: http://127.0.0.1:${typeof address === "object" && address ? address.port : port}`);
      queue.start();
      startInboxPoller();
      resolve(server);
    });
    server.on("close", stopInboxPoller);
  });
}
