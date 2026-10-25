import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { createInboxClient } from "../core/inbox-client.js";
import { createTaskQueue, type InboxAttempt } from "../core/tasks.js";
import { CollectionFailure, sanitizeFailureReport, type FailureReport } from "../core/failure-report.js";

test("structured failures cross the task, receipt and real inbox boundary and stop after three attempts", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "inspiration-failure-flow-"));
  const serverDir = path.join(root, "inbox");
  const desktopDir = path.join(root, "desktop");
  const reservation = net.createServer();
  await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const port = (reservation.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const token = "failure-flow-fake-token";
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.resolve("inbox/server.mjs")], {
    env: { ...process.env, INBOX_TOKEN: token, INBOX_DATA: serverDir, HOST: "127.0.0.1", PORT: String(port),
      INBOX_RETRY_BASE_MS: "1", INBOX_MAX_ATTEMPTS: "3", INSPIRATION_DATA_DIR: root, API_KEY: "", BASE_URL: "https://model.invalid" },
    stdio: "ignore", windowsHide: true,
  });
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  async function request(route: string, body?: unknown) {
    const response = await fetch(`${base}${route}`, {
      method: body === undefined ? "GET" : "POST", signal: AbortSignal.timeout(1500),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert.equal(response.ok, true, `temporary inbox ${route} returned ${response.status}`);
    return await response.json() as any;
  }
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { await request("/health"); ready = true; break; } catch { /* process startup */ }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(ready, true, "temporary inbox must start");
    const url = "https://mp.weixin.qq.com/s/failure-flow-test-only";
    const queued = await request("/collect", { url });
    let processed = 0;
    const metadata: InboxAttempt[] = [];
    const report: FailureReport = { version: 1, stage: "card_validation", articleTitle: "集成测试文章", batch: 2, imageStart: 9, imageEnd: 12,
      issues: [{ cardIndex: 4, cardTitle: "有问题的卡片", cardType: "website", field: "payload.url", code: "invalid_url" }], issueCount: 1 };
    const filePath = path.join(desktopDir, "tasks.json");
    const queue = createTaskQueue({ filePath,
      process: async () => { processed++; throw new CollectionFailure(report); },
      sanitizeError: error => error instanceof Error ? error.message : String(error),
      sanitizeReport: value => sanitizeFailureReport(value, [token]),
    });
    const client = createInboxClient({ dataDir: desktopDir,
      readConfig: () => ({ inboxUrl: base, inboxToken: token, inboxEnabled: true, inboxIntervalSec: 30, apiKey: "fake-model-key" }),
      collect: async (articleUrl, attempt) => {
        assert.ok(attempt, "the pull attempt metadata must reach the collection task");
        metadata.push({ ...attempt });
        return queue.wait(queue.enqueue(articleUrl, "inbox", false, attempt).id);
      },
    });
    for (let attempt = 1; attempt <= 3; attempt++) {
      assert.deepEqual(await client.drain(), { ok: 0, fail: 1, titles: [], cards: 0 });
      const status = (await request(`/status?ids=${queued.id}`)).items[0];
      assert.equal(status.attempts, attempt);
      assert.equal(status.maxAttempts, 3);
      assert.equal(status.status, attempt === 3 ? "failed" : "pending");
      assert.equal(status.failureReport.articleTitle, report.articleTitle);
      assert.equal(status.failureReport.issues[0].cardIndex, 4);
      assert.equal(status.failureReport.issues[0].field, "payload.url");
      assert.equal(status.failureReport.issues[0].code, "invalid_url");
      assert.equal(client.status().pendingAckCount, 0);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(processed, 3);
    assert.deepEqual(metadata.map(value => [value.id, value.attempt, value.maxAttempts]), [1, 2, 3].map(attempt => [queued.id, attempt, 3]));
    const tasks = queue.list();
    assert.equal(tasks.length, 3);
    assert.ok(tasks.every(task => task.status === "failed" && task.failureReport?.issues[0].field === "payload.url"));
    assert.deepEqual(JSON.parse(await fs.readFile(filePath, "utf8")).map((task: any) => task.inbox.attempt), [1, 2, 3]);
    assert.deepEqual(await client.drain(), { ok: 0, fail: 0, titles: [], cards: 0 });
    assert.equal(processed, 3, "fourth drain cannot call the processor");
    const duplicate = await request("/collect", { url });
    assert.equal(duplicate.id, queued.id);
    const stopped = (await request(`/status?ids=${queued.id}`)).items[0];
    assert.equal(stopped.status, "failed");
    assert.equal(stopped.attempts, 3);
    assert.deepEqual((await request("/pull")).items, []);
    const failures = await client.failures();
    assert.equal(failures.items.length, 1);
    assert.equal(failures.items[0].failureReport?.articleTitle, report.articleTitle);
    assert.equal(failures.items[0].failureReport?.issues[0].field, "payload.url");
    assert.deepEqual(await client.drain(), { ok: 0, fail: 0, titles: [], cards: 0 });
    assert.equal(processed, 3, "resharing a failed URL cannot silently reset the attempt budget");
  } finally {
    child.kill();
    await exited;
    assert.ok(root.startsWith(path.join(os.tmpdir(), "inspiration-failure-flow-")));
    await fs.rm(root, { recursive: true, force: true });
  }
});
