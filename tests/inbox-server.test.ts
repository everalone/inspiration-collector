import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";

const token = "inbox-test-token";
const article = "https://mp.weixin.qq.com/s/inbox-regression";

async function startInbox(extraEnv: Record<string, string> = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "inspiration-inbox-test-"));
  const reservation = net.createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = (reservation.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const child = spawn(process.execPath, [path.resolve("inbox/server.mjs")], {
    env: { ...process.env, INBOX_TOKEN: token, INBOX_DATA: dir, PORT: String(port), HOST: "127.0.0.1", ...extraEnv },
    stdio: "ignore", windowsHide: true,
  });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* startup */ }
    if (i === 99) throw new Error("Test inbox did not start");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return {
    dir,
    async request(route: string, body?: unknown) {
      const response = await fetch(`${base}${route}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, data: await response.json() as any };
    },
    async close() {
      child.kill();
      await exited;
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

test("a successful ACK may be retried after its response is lost", async () => {
  const inbox = await startInbox();
  try {
    const queued = await inbox.request("/collect", { url: article });
    assert.equal(queued.status, 201);
    const ack = { id: queued.data.id, ok: true, receiptId: "success-receipt" };
    assert.equal((await inbox.request("/ack", ack)).status, 200);
    assert.equal((await inbox.request("/ack", ack)).status, 200);
    assert.deepEqual((await inbox.request("/pull")).data.items, []);
  } finally { await inbox.close(); }
});

test("temporary analysis failures retry three times, then expose a manually retryable failure", async () => {
  const inbox = await startInbox({ INBOX_RETRY_BASE_MS: "500" });
  try {
    const { data: queued } = await inbox.request("/collect", { url: article });
    for (let attempt = 1; attempt <= 3; attempt++) {
      const ack = { id: queued.id, ok: false, error: "temporary model outage", receiptId: `failure-${attempt}` };
      const first = await inbox.request("/ack", ack);
      assert.equal(first.status, 200);
      assert.equal(first.data.status, attempt < 3 ? "pending" : "failed");
      assert.equal(first.data.attempts, attempt);
      assert.equal((await inbox.request("/ack", ack)).data.attempts, attempt, "replayed ACK must not consume another attempt");
      assert.deepEqual((await inbox.request("/pull")).data.items, [], "backoff must prevent immediate analysis retry");
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, attempt === 1 ? 550 : 1050));
        assert.equal((await inbox.request("/pull")).data.items[0]?.id, queued.id);
        assert.equal((await inbox.request("/ack", ack)).data.attempts, attempt, "delayed replay must still be idempotent");
      }
    }
    const failed = (await inbox.request("/failed")).data.items;
    assert.equal(failed.length, 1);
    assert.equal(failed[0].error, "temporary model outage");
    assert.equal(failed[0].attempts, 3);
    assert.equal((await inbox.request("/retry", { id: queued.id })).status, 200);
    assert.equal((await inbox.request("/pull")).data.items[0]?.id, queued.id);
    assert.deepEqual((await inbox.request("/failed")).data.items, []);
  } finally { await inbox.close(); }
});

test("a failed atomic write returns an error without adding a phantom task or corrupting the previous queue", async () => {
  const inbox = await startInbox();
  const savedPath = path.join(inbox.dir, "inbox.jsonl");
  const backupPath = path.join(inbox.dir, "saved-queue.jsonl");
  try {
    const first = await inbox.request("/collect", { url: article });
    await fs.rename(savedPath, backupPath);
    await fs.mkdir(savedPath);
    assert.equal((await inbox.request("/collect", { url: `${article}-blocked` })).status, 500);
    assert.equal((await inbox.request("/pull")).data.items.length, 1);
    await fs.rmdir(savedPath);
    await fs.rename(backupPath, savedPath);
    assert.equal((await inbox.request("/pull")).data.items[0]?.id, first.data.id);
    assert.equal((await inbox.request("/collect", { url: `${article}-recovered` })).status, 201);
  } finally { await inbox.close(); }
});

test("sharing a terminal failed article again retries it instead of a 24-hour duplicate dead end", async () => {
  const inbox = await startInbox({ INBOX_RETRY_BASE_MS: "1", INBOX_MAX_ATTEMPTS: "1" });
  try {
    const { data: queued } = await inbox.request("/collect", { url: article });
    await inbox.request("/ack", { id: queued.id, ok: false, receiptId: "failed" });
    const reshared = await inbox.request("/collect", { url: article });
    assert.equal(reshared.data.status, "queued");
    assert.equal((await inbox.request("/pull")).data.items.length, 1);
  } finally { await inbox.close(); }
});

test("queue capacity preserves pending work and reclaims completed history", async () => {
  const inbox = await startInbox({ INBOX_MAX_ROWS: "2" });
  try {
    const a = await inbox.request("/collect", { url: `${article}-a` });
    await inbox.request("/collect", { url: `${article}-b` });
    assert.equal((await inbox.request("/collect", { url: `${article}-c` })).status, 429);
    assert.equal((await inbox.request("/pull")).data.items.length, 2);
    await inbox.request("/ack", { id: a.data.id, ok: true });
    assert.equal((await inbox.request("/collect", { url: `${article}-c` })).status, 201);
    assert.equal((await inbox.request("/pull")).data.items.length, 2);
    assert.deepEqual((await fs.readdir(inbox.dir)).sort(), ["inbox.jsonl"], "atomic writes must not leave temporary files");
  } finally { await inbox.close(); }
});
