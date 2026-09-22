import { loadConfig } from "./config.js";

export interface InboxItem {
  id: string;
  url: string;
  received_at: string;
  note?: string;
}

async function inboxFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const cfg = loadConfig();
  const base = (cfg.inboxUrl || "").replace(/\/$/, "");
  if (!base) throw new Error("未配置 inboxUrl");
  return fetch(`${base}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.inboxToken}`,
      ...(init.headers || {}),
    },
  });
}

async function inboxPullRaw(limit: number): Promise<InboxItem[]> {
  const res = await inboxFetch(`/pull?limit=${limit}`);
  const data = (await res.json()) as { items?: InboxItem[]; error?: string };
  if (!res.ok) throw new Error(data.error || `pull ${res.status}`);
  return data.items ?? [];
}

export async function inboxAck(id: string, ok: boolean, error?: string): Promise<void> {
  const res = await inboxFetch("/ack", {
    method: "POST",
    body: JSON.stringify({ id, ok, error }),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || `ack ${res.status}`);
  }
}

/** 拉取一批并逐条走 ingest（refresh），无论成败都 ack。返回汇总。进程内互斥。 */
let drainLock = false;
export async function drainInboxOnce(): Promise<{
  ok: number;
  fail: number;
  titles: string[];
  cards: number;
}> {
  const cfg = loadConfig();
  if (!cfg.inboxEnabled || !cfg.inboxUrl || !cfg.inboxToken) {
    return { ok: 0, fail: 0, titles: [], cards: 0 };
  }
  if (drainLock) return { ok: 0, fail: 0, titles: [], cards: 0 };
  drainLock = true;
  try {
    const items = await inboxPullRaw(5);
    let ok = 0,
      fail = 0,
      cards = 0;
    const titles: string[] = [];
    for (const it of items) {
      try {
        const r = await reprocessByUrl(it.url);
        await inboxAck(it.id, true);
        ok++;
        titles.push(r.title);
        cards += Object.values(r.counts || {}).reduce((s, n) => s + n, 0);
      } catch (e) {
        const msg = (e as Error).message || "error";
        try {
          await inboxAck(it.id, false, msg);
        } catch {
          /* ack 失败下次 pull 再处理 */
        }
        fail++;
      }
    }
    return { ok, fail, titles, cards };
  } finally {
    drainLock = false;
  }
}

async function reprocessByUrl(url: string) {
  const { ingest } = await import("./ingest.js");
  return ingest(url, { refresh: true });
}

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

export function startInboxPoller(): void {
  stopInboxPoller();
  const tick = async () => {
    if (running) return;
    const cfg = loadConfig();
    if (!cfg.inboxEnabled) return;
    running = true;
    try {
      const r = await drainInboxOnce();
      if (r.ok || r.fail) {
        console.log(`[inbox] ok=${r.ok} fail=${r.fail}`);
      }
    } catch (e) {
      console.warn(`[inbox] ${(e as Error).message}`);
    } finally {
      running = false;
    }
  };
  const sec = Math.min(120, Math.max(10, loadConfig().inboxIntervalSec || 30));
  timer = setInterval(() => void tick(), sec * 1000);
  void tick();
}

export function stopInboxPoller(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
