import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR, loadConfig } from "./config.js";
import type { Config } from "./config.js";
import type { IngestResult } from "./ingest.js";
import { failureReportFromError, sanitizeFailureReport, type FailureReport } from "./failure-report.js";
import type { InboxAttempt } from "./tasks.js";

export interface InboxItem {
  id: string;
  url: string;
  received_at: string;
  note?: string;
  attempts?: number;
  maxAttempts?: number;
  generation?: string;
}

export interface InboxFailure extends InboxItem {
  attempts: number;
  error?: string;
  last_attempt_at?: string;
  failureReport?: FailureReport;
}

export interface InboxStatus {
  enabled: boolean;
  configured: boolean;
  connection: "disabled" | "idle" | "connected" | "error";
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  pendingAckCount: number;
}

type InboxConfig = Pick<Config, "inboxUrl" | "inboxToken" | "inboxEnabled" | "inboxIntervalSec"> & Partial<Pick<Config, "apiKey">>;
type DrainResult = { ok: number; fail: number; titles: string[]; cards: number };
type Connection = { base: string; token: string };
interface AckReceipt {
  endpoint: string;
  id: string;
  generation?: string;
  ok: boolean;
  title?: string;
  error?: string;
  failureReport?: FailureReport;
  receiptId: string;
  createdAt: string;
  attempts: number;
  nextAttemptAt: number;
  lastError?: string;
}

function receiptTitle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, " ").replace(/\s+/g, " ").trim();
  return normalized ? Array.from(normalized).slice(0, 200).join("") : undefined;
}

class InboxHttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export interface InboxClientOptions {
  readConfig?: () => InboxConfig;
  dataDir?: string;
  collect?: (url: string, attempt?: InboxAttempt) => Promise<IngestResult>;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  sanitizeError?: (error: unknown) => string;
}

/** Isolated client state allows a temporary directory and fake processor in regression tests. */
export function createInboxClient(options: InboxClientOptions = {}) {
  const readConfig = options.readConfig ?? loadConfig;
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const receiptsPath = path.join(options.dataDir ?? DATA_DIR, "inbox-receipts.json");
  const collect = options.collect ?? (async (url: string, attempt?: InboxAttempt) => {
    const { runCollection } = await import("./tasks.js");
    return runCollection(url, "inbox", attempt);
  });
  let draining = false;
  let lastCheckedAt: string | null = null;
  let lastSuccessAt: string | null = null;
  let lastError: string | null = null;
  let connection: InboxStatus["connection"] = "idle";
  let receipts: AckReceipt[] | null = null;

  function endpoint(cfg: InboxConfig): Connection {
    return { base: cfg.inboxUrl.trim().replace(/\/+$/, ""), token: cfg.inboxToken };
  }

  function loadReceipts(): AckReceipt[] {
    if (receipts !== null) return receipts;
    if (!fs.existsSync(receiptsPath)) return receipts = [];
    try {
      const saved = JSON.parse(fs.readFileSync(receiptsPath, "utf8"));
      if (saved.version !== 1 || !Array.isArray(saved.pending) || saved.pending.some((r: AckReceipt) =>
        !r || typeof r.id !== "string" || typeof r.endpoint !== "string" || typeof r.receiptId !== "string" ||
        typeof r.ok !== "boolean" || !Number.isFinite(r.nextAttemptAt) || !Number.isFinite(r.attempts))) throw new Error("invalid receipt data");
      // Receipts created by older versions have no title. Keep them replayable without re-analysis.
      return receipts = saved.pending.map((receipt: AckReceipt) => ({ ...receipt,
        title: receipt.ok ? receiptTitle(receipt.title) : undefined,
        failureReport: receipt.ok ? undefined : safeReport(receipt.failureReport) }));
    } catch {
      throw new Error("手机收件箱回执文件损坏，请先恢复 inbox-receipts.json 备份，已暂停拉取以避免重复分析");
    }
  }

  function saveReceipts(next: AckReceipt[]): void {
    fs.mkdirSync(path.dirname(receiptsPath), { recursive: true });
    const tempPath = `${receiptsPath}.${crypto.randomUUID()}.tmp`;
    try {
      const fd = fs.openSync(tempPath, "wx", 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify({ version: 1, pending: next }, null, 2), "utf8");
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      fs.renameSync(tempPath, receiptsPath);
      receipts = next;
    } finally {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    }
  }

  function errorMessage(error: unknown, requestSecrets: string[] = []): string {
    let message = options.sanitizeError ? options.sanitizeError(error) : error instanceof Error ? error.message : String(error);
    // Use this client's injected config only; isolated tests must never load a real user's key.
    const cfg = readConfig();
    for (const secret of [cfg.inboxToken, cfg.apiKey, ...requestSecrets]) {
      if (secret) message = message.replaceAll(secret, "[已隐藏]");
    }
    return message.slice(0, 500);
  }

  function safeReport(value: unknown, extraSecrets: string[] = []): FailureReport | undefined {
    const cfg = readConfig();
    return sanitizeFailureReport(value, [cfg.apiKey || "", cfg.inboxToken, ...extraSecrets]);
  }

  async function request(route: string, body?: unknown, target = endpoint(readConfig())) {
    if (!target.base || !target.token) throw new Error("请先配置手机收件箱地址与 Token");
    const ctrl = new AbortController();
    const timeoutMs = options.timeoutMs ?? 15_000;
    const timeout = setTimeout(() => ctrl.abort(), timeoutMs);
    lastCheckedAt = new Date(now()).toISOString();
    try {
      const response = await fetchImpl(`${target.base}${route}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${target.token}` },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
      const text = await response.text();
      let data: { error?: string; items?: InboxItem[] };
      try { data = JSON.parse(text); }
      catch { throw new InboxHttpError(response.status, `收件箱 HTTP ${response.status}：未返回有效 JSON，请检查地址与反向代理`); }
      if (!response.ok) throw new InboxHttpError(response.status, data.error || `收件箱 HTTP ${response.status}`);
      connection = "connected";
      lastSuccessAt = new Date(now()).toISOString();
      lastError = null;
      return data;
    } catch (error) {
      const failure = ctrl.signal.aborted ? new Error(`收件箱请求超时（${timeoutMs / 1000} 秒）`) : error;
      connection = "error";
      lastError = errorMessage(failure, [target.token]);
      throw failure instanceof InboxHttpError ? new InboxHttpError(failure.status, lastError) : new Error(lastError);
    } finally { clearTimeout(timeout); }
  }

  async function ack(id: string, ok: boolean, error?: string) {
    await request("/ack", { id, ok, error: error === undefined ? undefined : errorMessage(error) });
  }

  async function sendReceipt(receipt: AckReceipt, target: Connection): Promise<void> {
    try {
      await request("/ack", { id: receipt.id, ok: receipt.ok, generation: receipt.generation,
        title: receipt.ok ? receiptTitle(receipt.title) : undefined,
        failureReport: receipt.ok ? undefined : safeReport(receipt.failureReport, [target.token]),
        error: receipt.error === undefined ? undefined : errorMessage(receipt.error, [target.token]), receiptId: receipt.receiptId }, target);
    } catch (error) {
      // v1 inbox responds 404 when an earlier successful ACK already removed the pending item.
      if (!(error instanceof InboxHttpError && error.status === 404)) {
        const updated = { ...receipt, attempts: receipt.attempts + 1,
          nextAttemptAt: now() + Math.min(5_000 * 2 ** Math.min(receipt.attempts, 6), 300_000), lastError: errorMessage(error) };
        saveReceipts(loadReceipts().map((r) => r.receiptId === receipt.receiptId ? updated : r));
        return;
      }
    }
    saveReceipts(loadReceipts().filter((r) => r.receiptId !== receipt.receiptId));
  }

  async function drain(): Promise<DrainResult> {
    const result: DrainResult = { ok: 0, fail: 0, titles: [], cards: 0 };
    const cfg = readConfig();
    if (!cfg.inboxEnabled || !cfg.inboxUrl || !cfg.inboxToken || draining) return result;
    draining = true;
    try {
      const target = endpoint(cfg);
      for (const receipt of loadReceipts().filter((r) => r.endpoint === target.base && r.nextAttemptAt <= now())) {
        await sendReceipt(receipt, target);
      }
      const items = (await request("/pull?limit=5", undefined, target)).items ?? [];
      for (const item of items) {
        if (loadReceipts().some((r) => r.endpoint === target.base && r.id === item.id)) continue;
        let receipt: AckReceipt;
        try {
          const maxAttempts = Math.min(3, Math.max(1, Number.isSafeInteger(item.maxAttempts) ? item.maxAttempts! : 3));
          const completed = Number.isSafeInteger(item.attempts) && item.attempts! >= 0 ? item.attempts! : 0;
          // A stale/older server must not make this client process a fourth attempt.
          if (completed >= maxAttempts) continue;
          const generation = typeof item.generation === "string" && /^(?:legacy|[a-f0-9-]{36})$/i.test(item.generation) ? item.generation : undefined;
          const collected = await collect(item.url, { id: item.id, attempt: completed + 1, maxAttempts, generation });
          result.ok++;
          result.titles.push(collected.title);
          result.cards += Object.values(collected.counts || {}).reduce((sum, count) => sum + count, 0);
          receipt = { endpoint: target.base, id: item.id, generation, ok: true, title: receiptTitle(collected.title), receiptId: crypto.randomUUID(), createdAt: new Date(now()).toISOString(), attempts: 0, nextAttemptAt: 0 };
        } catch (error) {
          result.fail++;
          receipt = { endpoint: target.base, id: item.id, ok: false, error: errorMessage(error, [target.token, cfg.apiKey || ""]),
            generation: typeof item.generation === "string" && /^(?:legacy|[a-f0-9-]{36})$/i.test(item.generation) ? item.generation : undefined,
            failureReport: safeReport(failureReportFromError(error), [target.token, cfg.apiKey || ""]),
            receiptId: crypto.randomUUID(), createdAt: new Date(now()).toISOString(), attempts: 0, nextAttemptAt: 0 };
        }
        // Persist the outcome BEFORE acknowledgement. ACK failures never enter the analysis-failure branch.
        saveReceipts([...loadReceipts(), receipt]);
        await sendReceipt(receipt, target);
      }
      return result;
    } catch (error) {
      connection = "error";
      lastError = errorMessage(error);
      throw error;
    } finally { draining = false; }
  }

  function status(): InboxStatus {
    const cfg = readConfig();
    let pending: AckReceipt[] = [];
    try { pending = loadReceipts().filter((r) => r.endpoint === endpoint(cfg).base); }
    catch (error) { connection = "error"; lastError = errorMessage(error); }
    const pendingError = pending.find((r) => r.lastError)?.lastError;
    const visibleError = pendingError || lastError;
    return { enabled: cfg.inboxEnabled, configured: !!(cfg.inboxUrl && cfg.inboxToken), connection: cfg.inboxEnabled ? (pendingError ? "error" : connection) : "disabled", lastCheckedAt, lastSuccessAt, lastError: visibleError ? errorMessage(visibleError) : null, pendingAckCount: pending.length };
  }

  async function failures(): Promise<{ items: InboxFailure[]; supported: boolean }> {
    try {
      const data = await request("/failed");
      const items = ((data.items ?? []) as InboxFailure[]).map((item) => ({ ...item,
        error: item.error === undefined ? undefined : errorMessage(item.error), failureReport: safeReport(item.failureReport) }));
      return { items, supported: true };
    } catch (error) {
      if (error instanceof InboxHttpError && error.status === 404) {
        connection = "connected";
        lastError = null;
        return { items: [], supported: false };
      }
      throw error;
    }
  }

  async function retry(id: string): Promise<{ ok: true }> {
    if (!id) throw new Error("请选择要重试的收件箱任务");
    const target = endpoint(readConfig());
    for (const receipt of loadReceipts().filter((r) => r.endpoint === target.base && r.id === id)) await sendReceipt(receipt, target);
    if (loadReceipts().some((r) => r.endpoint === target.base && r.id === id)) throw new Error("该任务仍有回执未送达，请恢复收件箱连接后重试");
    await request("/retry", { id }, target);
    return { ok: true };
  }

  return { drain, ack, status, failures, retry };
}

const client = createInboxClient();
export const drainInboxOnce = client.drain;
export const inboxAck = client.ack;
export const getInboxStatus = client.status;
export const listInboxFailures = client.failures;
export const retryInboxItem = client.retry;

let timer: ReturnType<typeof setTimeout> | null = null;
let pollGeneration = 0;
export function startInboxPoller(): void {
  stopInboxPoller();
  const generation = pollGeneration;
  const tick = async () => {
    try { await drainInboxOnce(); }
    catch (error) { console.warn(`[inbox] ${(error as Error).message}`); }
    if (generation !== pollGeneration) return;
    timer = setTimeout(() => void tick(), Math.min(120, Math.max(10, loadConfig().inboxIntervalSec || 30)) * 1000);
  };
  void tick();
}
export function stopInboxPoller(): void {
  pollGeneration++;
  if (timer) clearTimeout(timer);
  timer = null;
}
