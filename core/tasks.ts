import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR, loadConfig } from "./config.js";
import type { IngestResult } from "./ingest.js";

export interface CollectionTask {
  id: string;
  url: string;
  source: string;
  refresh: boolean;
  status: "queued" | "running" | "done" | "failed";
  attempts: number;
  createdAt: string;
  updatedAt: string;
  title?: string;
  error?: string;
  result?: IngestResult;
}

export function normalizeArticleUrl(value: string): string {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.hostname !== "mp.weixin.qq.com" ||
        url.username || url.password || url.port) throw new Error();
    if (/^\/s\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)) {
      return `https://mp.weixin.qq.com${url.pathname.replace(/\/$/, "")}`;
    }
    if (url.pathname === "/s" && url.searchParams.get("__biz") && url.searchParams.get("sn")) {
      url.hash = "";
      return url.href; // Preserve long-link identity/parameters used by older libraries.
    }
    throw new Error();
  } catch {
    throw new Error("请粘贴 https://mp.weixin.qq.com/s/ 开头的微信公众号文章链接");
  }
}

export function redactTaskError(error: unknown): string {
  const cfg = loadConfig();
  let text = error instanceof Error ? error.message : String(error);
  for (const secret of [cfg.apiKey, cfg.inboxToken]) {
    if (secret) text = text.replaceAll(secret, "[已隐藏]");
  }
  return text.slice(0, 500);
}

/** One durable queue for manual, clipboard, inbox and explicit reprocessing work. */
export function createTaskQueue(options: {
  filePath: string;
  process: (url: string, options: { refresh: boolean }) => Promise<IngestResult>;
  sanitizeError?: (error: unknown) => string;
}) {
  let tasks: CollectionTask[] = [];
  let running = false;
  const waiters = new Map<string, { resolve: (r: IngestResult) => void; reject: (e: Error) => void }[]>();
  if (fs.existsSync(options.filePath)) {
    const stored: unknown = JSON.parse(fs.readFileSync(options.filePath, "utf8"));
    if (!Array.isArray(stored) || stored.some(t => !t || typeof t.id !== "string" || typeof t.url !== "string" ||
        !["queued", "running", "done", "failed"].includes(t.status))) {
      throw new Error("任务记录损坏，请保留任务文件并反馈，未清空原记录");
    }
    tasks = stored as CollectionTask[];
    for (const task of tasks) if (task.status === "running") {
      task.status = task.refresh ? "failed" : "queued";
      if (task.refresh) task.error = "上次重跑被中断，请查看已有卡片后决定是否重试";
    }
  }
  const persist = () => {
    fs.mkdirSync(path.dirname(options.filePath), { recursive: true });
    const recentDone = new Set(tasks.filter(t => t.status === "done").slice(-200).map(t => t.id));
    tasks = tasks.filter(t => t.status !== "done" || recentDone.has(t.id));
    fs.writeFileSync(`${options.filePath}.tmp`, JSON.stringify(tasks), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(`${options.filePath}.tmp`, options.filePath);
  };
  const sanitize = options.sanitizeError ?? ((e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500));
  async function pump() {
    if (running) return;
    running = true;
    try {
      let task: CollectionTask | undefined;
      while ((task = tasks.find(t => t.status === "queued"))) {
        task.status = "running";
        task.attempts++;
        task.updatedAt = new Date().toISOString();
        persist();
        try {
          task.result = await options.process(task.url, { refresh: task.refresh });
          task.title = task.result.title;
          task.status = "done";
          delete task.error;
        } catch (e) {
          task.status = "failed";
          task.error = sanitize(e);
        }
        task.updatedAt = new Date().toISOString();
        persist();
        for (const waiter of waiters.get(task.id) ?? []) {
          if (task.status === "done") waiter.resolve(task.result!);
          else waiter.reject(new Error(task.error));
        }
        waiters.delete(task.id);
      }
    } catch (e) {
      // Disk failures must settle waiting callers; leave persisted work recoverable.
      const message = sanitize(e);
      for (const [id, pending] of waiters) {
        const task = tasks.find(t => t.id === id);
        for (const waiter of pending) {
          // A committed extraction is still successful even if its history cannot be saved.
          if (task?.status === "done" && task.result) waiter.resolve(task.result);
          else waiter.reject(new Error(`任务记录保存失败：${message}`));
        }
      }
      waiters.clear();
      for (const task of tasks.filter(t => t.status === "running" || t.status === "queued")) {
        task.status = "failed"; task.error = `任务记录保存失败：${message}`;
        task.updatedAt = new Date().toISOString();
      }
      console.error(`[tasks] ${message}`);
    } finally {
      running = false;
    }
  }
  const start = () => queueMicrotask(() => void pump());
  const enqueue = (input: string, source = "manual", refresh = false) => {
    const url = normalizeArticleUrl(input);
    const existing = tasks.find(t => t.url === url && t.refresh === refresh && ["queued", "running"].includes(t.status));
    if (existing) return { ...existing };
    const now = new Date().toISOString();
    const task: CollectionTask = { id: crypto.randomUUID(), url, source, refresh, status: "queued", attempts: 0, createdAt: now, updatedAt: now };
    tasks.push(task);
    try { persist(); } catch (e) { tasks = tasks.filter(t => t !== task); throw e; }
    start();
    return { ...task };
  };
  const wait = (id: string): Promise<IngestResult> => {
    const task = tasks.find(t => t.id === id);
    if (!task) return Promise.reject(new Error("任务不存在"));
    if (task.status === "done") return Promise.resolve(task.result!);
    if (task.status === "failed") return Promise.reject(new Error(task.error));
    return new Promise((resolve, reject) => {
      waiters.set(id, [...(waiters.get(id) ?? []), { resolve, reject }]);
      start();
    });
  };
  const retry = (id: string) => {
    const task = tasks.find(t => t.id === id);
    if (!task) throw new Error("任务不存在");
    if (task.status !== "failed") return { ...task };
    const active = tasks.find(t => t.id !== id && t.url === task.url && t.refresh === task.refresh && ["queued", "running"].includes(t.status));
    if (active) return { ...active };
    const previous = { ...task };
    task.status = "queued";
    task.updatedAt = new Date().toISOString();
    delete task.error;
    try { persist(); } catch (e) { Object.assign(task, previous); throw e; }
    start();
    return { ...task };
  };
  return { enqueue, wait, retry, start, list: () => tasks.slice().reverse().map(t => ({ ...t })) };
}

let sharedQueue: ReturnType<typeof createTaskQueue> | undefined;
export function getTaskQueue() {
  return sharedQueue ??= createTaskQueue({
    filePath: path.join(DATA_DIR, "tasks.json"),
    process: async (url, opts) => (await import("./ingest.js")).ingest(url, opts),
    sanitizeError: redactTaskError,
  });
}
export async function runCollection(url: string, source = "manual"): Promise<IngestResult> {
  const queue = getTaskQueue();
  return queue.wait(queue.enqueue(url, source).id);
}
export async function runReprocess(url: string): Promise<IngestResult> {
  const queue = getTaskQueue();
  return queue.wait(queue.enqueue(url, "reprocess", true).id);
}
