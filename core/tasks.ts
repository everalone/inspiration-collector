import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR, loadConfig } from "./config.js";
import type { IngestResult } from "./ingest.js";
import { CollectionFailure, failureReportFromError, sanitizeFailureReport, type FailureReport } from "./failure-report.js";
import { assertCollectionAvailable } from "./maintenance.js";

export interface InboxAttempt { id: string; attempt: number; maxAttempts: number; generation?: string }

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
  failureReport?: FailureReport;
  inbox?: InboxAttempt;
  result?: IngestResult;
  /** Display history only: original status/result stays replayable for inbox ACK recovery. */
  resolvedAt?: string;
  resolvedBy?: string;
  archivedAt?: string;
  completedOrder?: number;
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
  sanitizeReport?: (report: unknown) => FailureReport | undefined;
}) {
  let tasks: CollectionTask[] = [];
  let running = false;
  let completedOrder = 0;
  const waiters = new Map<string, { resolve: (r: IngestResult) => void; reject: (e: Error) => void }[]>();
  if (fs.existsSync(options.filePath)) {
    const stored: unknown = JSON.parse(fs.readFileSync(options.filePath, "utf8"));
    if (!Array.isArray(stored) || stored.some(t => !t || typeof t.id !== "string" || typeof t.url !== "string" ||
        !["queued", "running", "done", "failed"].includes(t.status))) {
      throw new Error("任务记录损坏，请保留任务文件并反馈，未清空原记录");
    }
    tasks = stored as CollectionTask[];
    for (const task of tasks) task.failureReport = (options.sanitizeReport ?? sanitizeFailureReport)(task.failureReport);
    for (const task of tasks) if (task.status === "running") {
      task.status = task.refresh ? "failed" : "queued";
      if (task.refresh) task.error = "上次重跑被中断，请查看已有卡片后决定是否重试";
    }
  }
  const ordered = () => tasks.map((task, index) => ({ task, index })).sort((a, b) =>
    (Date.parse(a.task.updatedAt) || 0) - (Date.parse(b.task.updatedAt) || 0) ||
    (a.task.completedOrder ?? a.index) - (b.task.completedOrder ?? b.index));
  completedOrder = Math.max(tasks.length, ...tasks.map(t => t.completedOrder || 0));
  const canResolve = (failure: CollectionTask, success: CollectionTask) => failure.url === success.url &&
    (!failure.refresh || (success.refresh && !success.result?.skipped));
  const resolveFailures = (success: CollectionTask, candidates: CollectionTask[]) => {
    let changed = false;
    for (const failure of candidates) if (failure.status === "failed" && !failure.resolvedBy && canResolve(failure, success)) {
      failure.resolvedBy = success.id;
      failure.resolvedAt = success.updatedAt;
      changed = true;
    }
    return changed;
  };
  // Repair old task files before pruning the successful record that proves recovery.
  // File order breaks equal-timestamp ties for legacy attempts; current successes mark
  // earlier outcomes directly, including retries that reuse an older task ID.
  let migrated = false;
  const earlier: CollectionTask[] = [];
  for (const { task } of ordered()) {
    if (task.status === "done") migrated = resolveFailures(task, earlier) || migrated;
    earlier.push(task);
  }
  const persist = () => {
    fs.mkdirSync(path.dirname(options.filePath), { recursive: true });
    const recentDone = new Set(ordered().filter(({ task }) => task.status === "done").slice(-200).map(({ task }) => task.id));
    const recentResolved = new Set(ordered().filter(({ task }) => task.resolvedBy).slice(-200).map(({ task }) => task.id));
    // Retain identified inbox outcomes even after display history is cleared: replaying
    // a lost ACK must not turn a hidden record into a second paid analysis.
    const next = tasks.filter(t => (t.source === "inbox" && t.inbox?.generation) ||
      (t.status === "done" ? recentDone.has(t.id) : !t.resolvedBy || recentResolved.has(t.id)));
    fs.writeFileSync(`${options.filePath}.tmp`, JSON.stringify(next), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(`${options.filePath}.tmp`, options.filePath);
    tasks = next;
  };
  if (migrated) persist();
  const sanitize = options.sanitizeError ?? ((e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500));
  const sanitizeReport = options.sanitizeReport ?? sanitizeFailureReport;
  const taskError = (task: CollectionTask): Error => task.failureReport ? new CollectionFailure(task.failureReport) : new Error(task.error);
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
          delete task.failureReport;
        } catch (e) {
          task.status = "failed";
          task.error = sanitize(e);
          task.failureReport = sanitizeReport(failureReportFromError(e));
          if (task.failureReport?.articleTitle) task.title = task.failureReport.articleTitle;
        }
        task.updatedAt = new Date().toISOString();
        task.completedOrder = ++completedOrder;
        if (task.status === "done") resolveFailures(task, tasks);
        persist();
        for (const waiter of waiters.get(task.id) ?? []) {
          if (task.status === "done") waiter.resolve(task.result!);
          else waiter.reject(taskError(task));
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
  const enqueue = (input: string, source = "manual", refresh = false, inbox?: InboxAttempt) => {
    assertCollectionAvailable();
    const url = normalizeArticleUrl(input);
    // A durable outcome can outlive the process before its ACK receipt is saved.
    // Replay that outcome for the same server attempt rather than paying again.
    // A manual new round has a new generation and is intentionally distinct.
    if (inbox?.generation) {
      const previousAttempt = tasks.find(t => t.url === url && t.source === "inbox" && t.inbox?.id === inbox.id &&
        t.inbox?.generation === inbox.generation && t.inbox?.attempt === inbox.attempt);
      if (previousAttempt) return { ...previousAttempt };
    }
    const existing = tasks.find(t => t.url === url && t.refresh === refresh && ["queued", "running"].includes(t.status));
    if (existing) return { ...existing };
    const now = new Date().toISOString();
    const task: CollectionTask = { id: crypto.randomUUID(), url, source, refresh, status: "queued", attempts: 0, createdAt: now, updatedAt: now,
      ...(inbox ? { inbox: { ...inbox } } : {}) };
    tasks.push(task);
    try { persist(); } catch (e) { tasks = tasks.filter(t => t !== task); throw e; }
    start();
    return { ...task };
  };
  const wait = (id: string): Promise<IngestResult> => {
    const task = tasks.find(t => t.id === id);
    if (!task) return Promise.reject(new Error("任务不存在"));
    if (task.status === "done") return Promise.resolve(task.result!);
    if (task.status === "failed") return Promise.reject(taskError(task));
    return new Promise((resolve, reject) => {
      waiters.set(id, [...(waiters.get(id) ?? []), { resolve, reject }]);
      start();
    });
  };
  const retry = (id: string) => {
    assertCollectionAvailable();
    const task = tasks.find(t => t.id === id);
    if (!task) throw new Error("任务不存在");
    if (task.status !== "failed") return { ...task };
    if (task.resolvedBy) throw new Error("该失败任务已由后续成功处理，无需重试");
    const active = tasks.find(t => t.id !== id && t.url === task.url && t.refresh === task.refresh && ["queued", "running"].includes(t.status));
    if (active) return { ...active };
    const previous = { ...task };
    task.status = "queued";
    task.updatedAt = new Date().toISOString();
    delete task.error;
    delete task.failureReport;
    delete task.completedOrder;
    try { persist(); } catch (e) { Object.assign(task, previous); throw e; }
    start();
    return { ...task };
  };
  const list = (view: { includeArchived?: boolean } = {}) => {
    const recent = ordered().reverse().map(({ task }) => task);
    if (view.includeArchived) return recent.map(t => ({ ...t }));
    let completed = 0;
    const pending = new Set<string>();
    return recent.filter(task => {
      if (task.archivedAt || task.resolvedBy) return false;
      if (task.status === "done") return ++completed <= 10;
      const key = `${task.url}\0${!!task.refresh}`;
      if (task.status === "failed" && pending.has(key)) return false;
      pending.add(key);
      return true;
    }).map(t => ({ ...t }));
  };
  const archiveCompleted = () => {
    const candidates = tasks.filter(task => !task.archivedAt && (task.status === "done" || task.resolvedBy));
    if (!candidates.length) return { archived: 0 };
    const now = new Date().toISOString();
    for (const task of candidates) task.archivedAt = now;
    try { persist(); }
    catch (error) { for (const task of candidates) delete task.archivedAt; throw error; }
    return { archived: candidates.length };
  };
  return { enqueue, wait, retry, start, list, archiveCompleted };
}

let sharedQueue: ReturnType<typeof createTaskQueue> | undefined;
export function getTaskQueue() {
  return sharedQueue ??= createTaskQueue({
    filePath: path.join(DATA_DIR, "tasks.json"),
    process: async (url, opts) => (await import("./ingest.js")).ingest(url, opts),
    sanitizeError: redactTaskError,
    sanitizeReport: report => {
      const cfg = loadConfig();
      return sanitizeFailureReport(report, [cfg.apiKey, cfg.inboxToken]);
    },
  });
}
export async function runCollection(url: string, source = "manual", inbox?: InboxAttempt): Promise<IngestResult> {
  const queue = getTaskQueue();
  return queue.wait(queue.enqueue(url, source, false, inbox).id);
}
export async function runReprocess(url: string): Promise<IngestResult> {
  const queue = getTaskQueue();
  return queue.wait(queue.enqueue(url, "reprocess", true).id);
}
