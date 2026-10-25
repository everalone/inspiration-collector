#!/usr/bin/env node
/**
 * 灵感收集 · 公网收件箱（部署在 VPS）
 * 手机 POST 链接 → 入队；家里电脑 pull → ingest → ack。
 * 环境变量：INBOX_TOKEN（必填）、INBOX_DATA（数据目录，默认 ./data）、PORT（默认 8787）
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { sanitizeFailureReport, formatFailureReport } from "./failure-report.mjs";

const TOKEN = process.env.INBOX_TOKEN || "";
const DATA_DIR = process.env.INBOX_DATA || path.join(process.cwd(), "data");
const PORT = Number(process.env.PORT || 8787);
const DEDUPE_MS = 24 * 60 * 60 * 1000;
const DB_PATH = path.join(DATA_DIR, "inbox.jsonl");
function positiveInteger(value, fallback) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}
const MAX_ATTEMPTS = Math.min(3, positiveInteger(process.env.INBOX_MAX_ATTEMPTS, 3));
const RETRY_BASE_MS = positiveInteger(process.env.INBOX_RETRY_BASE_MS, 60_000);
const MAX_ROWS = positiveInteger(process.env.INBOX_MAX_ROWS, 10_000);
const HISTORY_MS = positiveInteger(process.env.INBOX_HISTORY_DAYS, 30) * 24 * 60 * 60 * 1000;

if (!TOKEN) {
  console.error("INBOX_TOKEN 未设置，拒绝启动");
  process.exit(1);
}
fs.mkdirSync(DATA_DIR, { recursive: true });

/** @type {{id:string,url:string,generation?:string,note?:string,title?:string,failureReport?:object,status:'pending'|'done'|'failed',received_at:string,acked_at?:string,ok?:boolean,error?:string,attempts?:number,next_attempt_at?:string,receipt_ids?:string[]}[]} */
let rows = [];
if (fs.existsSync(DB_PATH)) {
  rows = fs.readFileSync(DB_PATH, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function pruneHistory(input, makeRoom = false) {
  const cutoff = Date.now() - HISTORY_MS;
  // A terminal failure is an explicit stop until /retry, even after 24 hours or
  // history expiry. Removing it would silently grant the same URL more attempts.
  let next = input.filter((r) => r.status !== "done" || !(Date.parse(r.acked_at || r.received_at) < cutoff));
  // A full queue may evict completed history, but never pending or actionable failed work.
  if (makeRoom && next.length >= MAX_ROWS) {
    const remove = new Set(next.filter((r) => r.status === "done")
      .sort((a, b) => Date.parse(a.acked_at || a.received_at) - Date.parse(b.acked_at || b.received_at))
      .slice(0, next.length - MAX_ROWS + 1).map((r) => r.id));
    next = next.filter((r) => !remove.has(r.id));
  }
  return next;
}

function persist(nextRows) {
  const tempPath = `${DB_PATH}.${crypto.randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(tempPath, "wx", 0o600);
    try {
      fs.writeFileSync(fd, nextRows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(tempPath, DB_PATH);
    rows = nextRows; // Keep the previous in-memory queue if writing fails.
  } finally {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }
}

const retainedRows = pruneHistory(rows).map((row) => {
  const updated = { ...row };
  if (updated.status === "pending" && (updated.attempts || 0) >= MAX_ATTEMPTS) {
    updated.status = "failed";
    updated.ok = false;
    delete updated.next_attempt_at;
  }
  if (updated.status === "done" && updated.ok === true) {
    delete updated.failureReport;
    delete updated.error;
  } else if (updated.failureReport !== undefined || updated.error !== undefined || updated.ok === false || updated.status === "failed") {
    const report = sanitizeFailureReport(updated.failureReport, [TOKEN]);
    if (report) updated.failureReport = report;
    else delete updated.failureReport;
    updated.error = formatFailureReport(report);
  }
  return updated;
});
if (JSON.stringify(retainedRows) !== JSON.stringify(rows)) persist(retainedRows);

function isWeChatUrl(u) {
  try {
    const x = new URL(u);
    if (x.protocol !== "https:" || x.hostname !== "mp.weixin.qq.com" || x.username || x.password || x.port) return false;
    return /^\/s\/[A-Za-z0-9_-]+\/?$/.test(x.pathname) ||
      (x.pathname === "/s" && !!x.searchParams.get("__biz") && !!x.searchParams.get("sn"));
  } catch {
    return false;
  }
}

function authorized(req) {
  const h = req.headers.authorization || "";
  return h === `Bearer ${TOKEN}`;
}

function json(res, code, data) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = "";
    req.on("data", (c) => {
      b += c;
      if (b.length > 64_000) {
        reject(new Error("body 过大"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(b));
    req.on("error", reject);
  });
}

function findDuplicate(url) {
  const now = Date.now();
  for (const r of rows) {
    if (r.url !== url) continue;
    if (r.status === "pending" || r.status === "failed") return r;
    const t = Date.parse(r.received_at);
    if (Number.isFinite(t) && now - t < DEDUPE_MS) return r;
  }
  return null;
}

function resetForRetry(row) {
  row.status = "pending";
  row.attempts = 0;
  row.generation = crypto.randomUUID();
  delete row.next_attempt_at;
  delete row.acked_at;
  delete row.error;
  delete row.failureReport;
  delete row.title;
  delete row.ok;
}

function ackResult(row) {
  return { ok: true, id: row.id, status: row.status, attempts: row.attempts || 0, maxAttempts: MAX_ATTEMPTS,
    generation: row.generation || "legacy", next_attempt_at: row.next_attempt_at };
}

function articleTitle(value) {
  if (typeof value !== "string") return null;
  const normalized = value
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, " ")
    .replace(/\p{Surrogate}/gu, "")
    .replace(/\s+/gu, " ").trim();
  return Array.from(normalized).slice(0, 200).join("").trim() || null;
}

/** 入队互斥：避免并发 POST 同一 URL 时 check-then-act 竞态 */
let enqueueLock = Promise.resolve();
function withEnqueueLock(fn) {
  const run = enqueueLock.then(fn, fn);
  enqueueLock = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
  } catch {
    return json(res, 400, { error: "invalid request URL" });
  }
  const p = url.pathname;
  try {
    if (p === "/health" && req.method === "GET") return json(res, 200, { ok: true, protocol: 2 });

    if (p === "/collect" && req.method === "POST") {
      if (!authorized(req)) return json(res, 401, { error: "unauthorized" });
      const body = JSON.parse((await readBody(req)) || "{}");
      const link = String(body.url || "").trim();
      if (!isWeChatUrl(link)) return json(res, 400, { error: "仅支持微信公众号文章链接" });
      return await withEnqueueLock(() => {
        const dup = findDuplicate(link);
        if (dup) {
          if (dup.status === "failed") return json(res, 200, { id: dup.id, status: "failed" });
          return json(res, 200, { id: dup.id, status: "duplicate" });
        }
        const item = {
          id: crypto.randomUUID(),
          generation: crypto.randomUUID(),
          url: link,
          note: typeof body.note === "string" ? body.note.slice(0, 500) : undefined,
          status: "pending",
          received_at: new Date().toISOString(),
        };
        const next = pruneHistory(rows, true);
        if (next.length >= MAX_ROWS) return json(res, 429, { error: "收件箱已满，请先处理待办或失败任务" });
        persist([...next, item]);
        console.log(`[collect] ${item.id}`);
        return json(res, 201, { id: item.id, status: "queued" });
      });
    }

    if (p === "/pull" && req.method === "GET") {
      if (!authorized(req)) return json(res, 401, { error: "unauthorized" });
      const limit = Math.min(positiveInteger(url.searchParams.get("limit"), 5), 20);
      const items = rows.filter((r) => r.status === "pending" && (r.attempts || 0) < MAX_ATTEMPTS &&
        (!r.next_attempt_at || Date.parse(r.next_attempt_at) <= Date.now())).slice(0, limit)
        .map(({ id, url: u, received_at, note, attempts, generation }) => ({ id, url: u, received_at, note,
          attempts: attempts || 0, maxAttempts: MAX_ATTEMPTS, generation: generation || "legacy" }));
      return json(res, 200, { items });
    }

    if (p === "/status" && req.method === "GET") {
      if (!authorized(req)) return json(res, 401, { error: "unauthorized" });
      const params = url.searchParams.getAll("ids");
      const ids = params.length === 1 ? params[0].split(",").map((id) => id.toLowerCase()) : [];
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
      if (ids.length < 1 || ids.length > 20 || ids.some((id) => !uuid.test(id)) || new Set(ids).size !== ids.length) {
        return json(res, 400, { error: "ids must contain 1 to 20 unique UUIDs" });
      }
      // A status read must not prune history, consume attempts, or change retry timing.
      const byId = new Map(rows.map((row) => [row.id, row]));
      const items = [];
      const missing = [];
      for (const id of ids) {
        const row = byId.get(id);
        if (!row) { missing.push(id); continue; }
        const failureReport = sanitizeFailureReport(row.failureReport, [TOKEN]);
        items.push({
          id: row.id, status: row.status, ok: row.ok ?? null, generation: row.generation || "legacy",
          title: articleTitle(row.title) || failureReport?.articleTitle || null,
          failureReport,
          received_at: row.received_at, acked_at: row.acked_at ?? null,
          attempts: row.attempts || 0, maxAttempts: MAX_ATTEMPTS, next_attempt_at: row.next_attempt_at ?? null,
          ...(row.error === undefined ? {} : { error: formatFailureReport(failureReport) }),
        });
      }
      return json(res, 200, { items, missing });
    }

    if (p === "/failed" && req.method === "GET") {
      if (!authorized(req)) return json(res, 401, { error: "unauthorized" });
      const items = rows.filter((r) => r.status === "failed").map((row) => {
        const failureReport = sanitizeFailureReport(row.failureReport, [TOKEN]);
        return { id: row.id, url: row.url, received_at: row.received_at, attempts: row.attempts || 0,
          maxAttempts: MAX_ATTEMPTS, generation: row.generation || "legacy", title: articleTitle(row.title) || failureReport?.articleTitle || null,
          failureReport, error: formatFailureReport(failureReport), last_attempt_at: row.acked_at };
      });
      return json(res, 200, { items });
    }

    if (p === "/retry" && req.method === "POST") {
      if (!authorized(req)) return json(res, 401, { error: "unauthorized" });
      const body = JSON.parse((await readBody(req)) || "{}");
      const row = rows.find((r) => r.id === String(body.id || ""));
      if (!row) return json(res, 404, { error: "not found" });
      if (row.status === "done") return json(res, 409, { error: "article already completed" });
      if (row.status === "pending") return json(res, 200, ackResult(row));
      const updated = { ...row };
      resetForRetry(updated);
      persist(pruneHistory(rows.map((r) => r.id === row.id ? updated : r)));
      return json(res, 200, ackResult(updated));
    }

    if (p === "/ack" && req.method === "POST") {
      if (!authorized(req)) return json(res, 401, { error: "unauthorized" });
      const body = JSON.parse((await readBody(req)) || "{}");
      const id = String(body.id || "");
      const row = rows.find((r) => r.id === id);
      if (!row) return json(res, 404, { error: "not found" });
      // A durable receipt from an earlier manual retry cycle must not consume
      // this cycle's attempts or enrich a later successful result's title.
      if (body.generation !== undefined && body.generation !== (row.generation || "legacy")) {
        return json(res, 200, ackResult(row));
      }
      const receiptId = typeof body.receiptId === "string" ? body.receiptId.slice(0, 100) : "";
      const succeeded = body.ok === true;
      const title = succeeded ? articleTitle(body.title) : null;
      // A newer client can enrich a legacy successful receipt without replaying
      // completion, changing its timestamps, or replacing an existing title.
      if (row.status === "done" && row.ok === true && title && !articleTitle(row.title)) {
        const updated = { ...row, title };
        persist(rows.map((r) => r.id === row.id ? updated : r));
        return json(res, 200, ackResult(updated));
      }
      if (row.status !== "pending" || (receiptId && row.receipt_ids?.includes(receiptId))) return json(res, 200, ackResult(row));
      // Legacy clients have no receipt ID: a repeated failure within its backoff is a no-op.
      if (!receiptId && !succeeded && row.next_attempt_at && Date.parse(row.next_attempt_at) > Date.now()) return json(res, 200, ackResult(row));
      const updated = { ...row, attempts: (row.attempts || 0) + 1 };
      updated.status = succeeded ? "done" : updated.attempts >= MAX_ATTEMPTS ? "failed" : "pending";
      updated.ok = succeeded;
      if (title) updated.title = title;
      const failureReport = succeeded ? null : sanitizeFailureReport(body.failureReport, [TOKEN]);
      if (failureReport) updated.failureReport = failureReport;
      else delete updated.failureReport;
      updated.error = succeeded ? undefined : formatFailureReport(failureReport);
      updated.acked_at = new Date().toISOString();
      updated.next_attempt_at = updated.status === "pending" ? new Date(Date.now() + Math.min(RETRY_BASE_MS * 2 ** (updated.attempts - 1), 60 * 60 * 1000)).toISOString() : undefined;
      if (receiptId) updated.receipt_ids = [...(row.receipt_ids || []), receiptId].slice(-100);
      persist(pruneHistory(rows.map((r) => r.id === row.id ? updated : r)));
      console.log(`[ack] ${id} ok=${updated.ok} attempts=${updated.attempts}`);
      return json(res, 200, ackResult(updated));
    }

    return json(res, 404, { error: "unknown" });
  } catch {
    return json(res, 500, { error: "inbox request failed" });
  }
});

const HOST = process.env.HOST || "127.0.0.1";
server.listen(PORT, HOST, () => {
  console.log(`inbox listening ${HOST}:${PORT} data=${DATA_DIR}`);
});
