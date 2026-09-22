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

const TOKEN = process.env.INBOX_TOKEN || "";
const DATA_DIR = process.env.INBOX_DATA || path.join(process.cwd(), "data");
const PORT = Number(process.env.PORT || 8787);
const DEDUPE_MS = 24 * 60 * 60 * 1000;
const DB_PATH = path.join(DATA_DIR, "inbox.jsonl");

if (!TOKEN) {
  console.error("INBOX_TOKEN 未设置，拒绝启动");
  process.exit(1);
}
fs.mkdirSync(DATA_DIR, { recursive: true });

/** @type {{id:string,url:string,note?:string,status:'pending'|'done'|'failed',received_at:string,acked_at?:string,ok?:boolean,error?:string}[]} */
let rows = [];
if (fs.existsSync(DB_PATH)) {
  rows = fs.readFileSync(DB_PATH, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function persist() {
  fs.writeFileSync(DB_PATH, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

function isWeChatUrl(u) {
  try {
    const x = new URL(u);
    return x.protocol === "https:" && x.hostname === "mp.weixin.qq.com" && x.pathname.startsWith("/s/");
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
      if (b.length > 64_000) reject(new Error("body 过大"));
    });
    req.on("end", () => resolve(b));
    req.on("error", reject);
  });
}

function findDuplicate(url) {
  const now = Date.now();
  for (const r of rows) {
    if (r.url !== url) continue;
    if (r.status === "pending") return r;
    const t = Date.parse(r.received_at);
    if (Number.isFinite(t) && now - t < DEDUPE_MS) return r;
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
  const p = url.pathname;
  try {
    if (p === "/health" && req.method === "GET") return json(res, 200, { ok: true });

    if (p === "/collect" && req.method === "POST") {
      if (!authorized(req)) return json(res, 401, { error: "unauthorized" });
      const body = JSON.parse((await readBody(req)) || "{}");
      const link = String(body.url || "").trim();
      if (!isWeChatUrl(link)) return json(res, 400, { error: "仅支持 mp.weixin.qq.com/s/ 文章链接" });
      const dup = findDuplicate(link);
      if (dup) return json(res, 200, { id: dup.id, status: "duplicate" });
      const item = {
        id: crypto.randomUUID(),
        url: link,
        note: typeof body.note === "string" ? body.note.slice(0, 500) : undefined,
        status: "pending",
        received_at: new Date().toISOString(),
      };
      rows.push(item);
      persist();
      console.log(`[collect] ${item.id} ${link}`);
      return json(res, 201, { id: item.id, status: "queued" });
    }

    if (p === "/pull" && req.method === "GET") {
      if (!authorized(req)) return json(res, 401, { error: "unauthorized" });
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 5), 1), 20);
      const items = rows.filter((r) => r.status === "pending").slice(0, limit)
        .map(({ id, url: u, received_at, note }) => ({ id, url: u, received_at, note }));
      return json(res, 200, { items });
    }

    if (p === "/ack" && req.method === "POST") {
      if (!authorized(req)) return json(res, 401, { error: "unauthorized" });
      const body = JSON.parse((await readBody(req)) || "{}");
      const id = String(body.id || "");
      const row = rows.find((r) => r.id === id && r.status === "pending");
      if (!row) return json(res, 404, { error: "not found" });
      row.status = body.ok ? "done" : "failed";
      row.ok = !!body.ok;
      row.error = body.ok ? undefined : String(body.error || "").slice(0, 500);
      row.acked_at = new Date().toISOString();
      persist();
      console.log(`[ack] ${id} ok=${row.ok} ${row.error || ""}`);
      return json(res, 200, { ok: true });
    }

    return json(res, 404, { error: "unknown" });
  } catch (e) {
    return json(res, 500, { error: (e && e.message) || "error" });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`inbox listening :${PORT} data=${DATA_DIR}`);
});
