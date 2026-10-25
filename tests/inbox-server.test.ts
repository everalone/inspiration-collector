import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { sanitizeFailureReport, formatFailureReport } from "../inbox/failure-report.mjs";

const token = "inbox-test-token";
const article = "https://mp.weixin.qq.com/s/inbox-regression";
const genericFailure = "分析失败（未提供结构化报告）";

async function startInbox(extraEnv: Record<string, string> = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "inspiration-inbox-test-"));
  const reservation = net.createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = (reservation.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  function launch() {
    const child = spawn(process.execPath, [path.resolve("inbox/server.mjs")], {
      env: { ...process.env, INBOX_TOKEN: token, INBOX_DATA: dir, PORT: String(port), HOST: "127.0.0.1", ...extraEnv },
      stdio: "ignore", windowsHide: true,
    });
    return { child, exited: new Promise<void>((resolve) => child.once("exit", () => resolve())) };
  }
  let running = launch();
  const base = `http://127.0.0.1:${port}`;
  async function waitReady() {
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`${base}/health`)).ok) return; } catch { /* startup */ }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    running.child.kill();
    await running.exited;
    await fs.rm(dir, { recursive: true, force: true });
    throw new Error("Test inbox did not start");
  }
  await waitReady();
  return {
    dir,
    async rawRequest(target: string) {
      return new Promise<number>((resolve, reject) => {
        let response = "";
        const socket = net.connect(port, "127.0.0.1", () => {
          socket.write(`GET ${target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
        });
        socket.setTimeout(2_000, () => socket.destroy(new Error("Raw request timed out")));
        socket.on("data", (chunk) => { response += chunk; });
        socket.on("error", reject);
        socket.on("close", () => resolve(Number(response.match(/^HTTP\/1\.1 (\d+)/)?.[1] || 0)));
      });
    },
    async request(route: string, body?: unknown, authorization: string | null = `Bearer ${token}`) {
      const response = await fetch(`${base}${route}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { ...(authorization === null ? {} : { Authorization: authorization }), "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, data: await response.json() as any };
    },
    async close() {
      running.child.kill();
      await running.exited;
      await fs.rm(dir, { recursive: true, force: true });
    },
    async restart() {
      running.child.kill();
      await running.exited;
      running = launch();
      await waitReady();
    },
  };
}

test("the inbox accepts long WeChat article links and rejects unsupported article URLs", async () => {
  const inbox = await startInbox();
  try {
    const longArticle = "https://mp.weixin.qq.com/s?__biz=example&mid=1&idx=1&sn=signature#wechat_redirect";
    assert.equal((await inbox.request("/collect", { url: longArticle })).status, 201);
    assert.equal((await inbox.request("/pull")).data.items[0]?.url, longArticle);
    for (const url of [
      "https://mp.weixin.qq.com/s?__biz=example",
      "https://mp.weixin.qq.com/s/",
      "https://mp.weixin.qq.com/s/a/b",
      "https://user:secret@mp.weixin.qq.com/s/article",
      "https://mp.weixin.qq.com:8443/s/article",
      "https://mp.weixin.qq.com.example.com/s/article",
      "http://mp.weixin.qq.com/s/article",
    ]) {
      assert.equal((await inbox.request("/collect", { url })).status, 400, url);
    }
  } finally { await inbox.close(); }
});

test("a malformed request target returns 400 without stopping the inbox", async () => {
  const inbox = await startInbox();
  try {
    assert.equal(await inbox.rawRequest("//["), 400);
    assert.equal((await inbox.request("/health")).status, 200);
    assert.equal((await inbox.request("/collect", { url: article })).status, 201);
  } finally { await inbox.close(); }
});

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

test("status requires authentication and validates a bounded, unique UUID list", async () => {
  const inbox = await startInbox();
  try {
    const { data: queued } = await inbox.request("/collect", { url: article });
    const route = `/status?ids=${queued.id}`;
    assert.equal((await inbox.request(route, undefined, null)).status, 401);
    assert.equal((await inbox.request(route, undefined, "Bearer incorrect")).status, 401);
    for (const invalid of [
      "/status", "/status?ids=", "/status?ids=not-a-uuid",
      `/status?ids=${queued.id},`, `/status?ids=${queued.id},${queued.id.toUpperCase()}`,
      `/status?ids=${queued.id}&ids=${randomUUID()}`,
      `/status?ids=${Array.from({ length: 21 }, () => randomUUID()).join(",")}`,
    ]) {
      assert.equal((await inbox.request(invalid)).status, 400, invalid);
    }
    const unknown = randomUUID();
    const mixed = await inbox.request(`/status?ids=${unknown},${queued.id.toUpperCase()}`);
    assert.equal(mixed.status, 200);
    assert.deepEqual(mixed.data.missing, [unknown]);
    assert.deepEqual(mixed.data.items.map((item: any) => item.id), [queued.id]);
    const limit = await inbox.request(`/status?ids=${Array.from({ length: 20 }, () => randomUUID()).join(",")}`);
    assert.equal(limit.status, 200);
    assert.equal(limit.data.missing.length, 20);
  } finally { await inbox.close(); }
});

test("status observes pending and completed work without mutating the queue", async () => {
  const inbox = await startInbox();
  try {
    const { data: queued } = await inbox.request("/collect", { url: article });
    const savedPath = path.join(inbox.dir, "inbox.jsonl");
    const before = await fs.readFile(savedPath, "utf8");
    const route = `/status?ids=${queued.id}`;
    const pending = (await inbox.request(route)).data.items[0];
    assert.deepEqual(pending, {
      id: queued.id, status: "pending", ok: null, title: null, failureReport: null, generation: JSON.parse(before).generation,
      received_at: JSON.parse(before).received_at, acked_at: null,
      attempts: 0, maxAttempts: 3, next_attempt_at: null,
    });
    assert.equal(await fs.readFile(savedPath, "utf8"), before);
    assert.equal((await inbox.request("/pull")).data.items[0]?.id, queued.id);
    await inbox.request("/ack", { id: queued.id, ok: true, receiptId: "status-success" });
    const after = await fs.readFile(savedPath, "utf8");
    const completed = (await inbox.request(route)).data.items[0];
    assert.equal(completed.status, "done");
    assert.equal(completed.ok, true);
    assert.equal(completed.title, null, "legacy successful ACKs need no title");
    assert.equal(completed.attempts, 1);
    assert.equal(completed.acked_at, JSON.parse(after).acked_at);
    assert.equal(completed.next_attempt_at, null);
    assert.equal(await fs.readFile(savedPath, "utf8"), after);
  } finally { await inbox.close(); }
});

test("successful ACK titles are sanitized, persisted and available after restart", async () => {
  const inbox = await startInbox();
  try {
    const { data: queued } = await inbox.request("/collect", { url: article });
    const title = " \u0000视觉\t词典\n\u0085上篇\u202e  😀\ud800  ";
    const expected = "视觉 词典 上篇 😀";
    assert.equal((await inbox.request("/ack", { id: queued.id, ok: true, title, receiptId: "titled-success" })).status, 200);
    assert.equal(JSON.parse(await fs.readFile(path.join(inbox.dir, "inbox.jsonl"), "utf8")).title, expected);
    await inbox.restart();
    const result = (await inbox.request(`/status?ids=${queued.id}`)).data.items[0];
    assert.equal(result.title, expected);
    assert.equal(result.status, "done");
    assert.equal(result.ok, true);
    assert.equal(result.attempts, 1);
    assert.deepEqual((await inbox.request("/pull")).data.items, []);
  } finally { await inbox.close(); }
});

test("ACK title length counts Unicode characters and invalid optional titles remain absent", async () => {
  const inbox = await startInbox();
  try {
    const { data: queued } = await inbox.request("/collect", { url: article });
    await inbox.request("/ack", { id: queued.id, ok: true, title: "😀".repeat(205) });
    assert.equal((await inbox.request(`/status?ids=${queued.id}`)).data.items[0].title, "😀".repeat(200));
    for (const [index, title] of [undefined, null, 123, { text: "not a title" }, "\u0000\t\u202e"].entries()) {
      const { data: item } = await inbox.request("/collect", { url: `${article}-invalid-title-${index}` });
      assert.equal((await inbox.request("/ack", { id: item.id, ok: true, title })).status, 200);
      const result = (await inbox.request(`/status?ids=${item.id}`)).data.items[0];
      assert.equal(result.title, null);
      assert.equal(result.status, "done");
    }
  } finally { await inbox.close(); }
});

test("a successful ACK may backfill a missing title without replaying or replacing completion", async () => {
  const inbox = await startInbox();
  try {
    const { data: queued } = await inbox.request("/collect", { url: article });
    const route = `/status?ids=${queued.id}`;
    const ack = { id: queued.id, ok: true, receiptId: "legacy-success" };
    await inbox.request("/ack", ack);
    const before = (await inbox.request(route)).data.items[0];
    assert.equal(before.title, null);
    await inbox.request("/ack", { ...ack, ok: false, title: "failure cannot supply a title", error: "late failure" });
    assert.deepEqual((await inbox.request(route)).data.items[0], before);
    await inbox.request("/ack", { ...ack, title: "  补充\n标题  " });
    const enriched = (await inbox.request(route)).data.items[0];
    assert.deepEqual(enriched, { ...before, title: "补充 标题" });
    const saved = await fs.readFile(path.join(inbox.dir, "inbox.jsonl"), "utf8");
    await inbox.request("/ack", { ...ack, title: "replacement" });
    await inbox.request("/ack", { id: queued.id, ok: true, title: "another replacement", receiptId: "new-receipt" });
    await inbox.request("/ack", { id: queued.id, ok: false, title: "failed overwrite", error: "late failure" });
    assert.deepEqual((await inbox.request(route)).data.items[0], enriched);
    assert.equal(await fs.readFile(path.join(inbox.dir, "inbox.jsonl"), "utf8"), saved);
    await inbox.restart();
    assert.deepEqual((await inbox.request(route)).data.items[0], enriched);
  } finally { await inbox.close(); }
});

test("failed ACKs never persist titles or become successful through title enrichment", async () => {
  const inbox = await startInbox({ INBOX_MAX_ATTEMPTS: "1" });
  try {
    const { data: queued } = await inbox.request("/collect", { url: article });
    await inbox.request("/ack", { id: queued.id, ok: false, title: "not a completed title", receiptId: "terminal-failure" });
    const route = `/status?ids=${queued.id}`;
    const failed = (await inbox.request(route)).data.items[0];
    assert.equal(failed.status, "failed");
    assert.equal(failed.ok, false);
    assert.equal(failed.title, null);
    const saved = await fs.readFile(path.join(inbox.dir, "inbox.jsonl"), "utf8");
    assert.equal(JSON.parse(saved).title, undefined);
    await inbox.request("/ack", { id: queued.id, ok: true, title: "late success", receiptId: "late-success" });
    assert.deepEqual((await inbox.request(route)).data.items[0], failed);
    assert.equal(await fs.readFile(path.join(inbox.dir, "inbox.jsonl"), "utf8"), saved);
  } finally { await inbox.close(); }
});

test("status distinguishes a retrying failure from a terminal failure", async () => {
  const inbox = await startInbox({ INBOX_RETRY_BASE_MS: "60000", INBOX_MAX_ATTEMPTS: "2" });
  try {
    const { data: queued } = await inbox.request("/collect", { url: article });
    const route = `/status?ids=${queued.id}`;
    await inbox.request("/ack", { id: queued.id, ok: false, error: "temporary outage", receiptId: "status-failure-1" });
    const before = await fs.readFile(path.join(inbox.dir, "inbox.jsonl"), "utf8");
    const retrying = (await inbox.request(route)).data.items[0];
    assert.equal(retrying.status, "pending");
    assert.equal(retrying.ok, false);
    assert.equal(retrying.error, genericFailure);
    assert.equal(retrying.attempts, 1);
    assert.ok(Date.parse(retrying.next_attempt_at) > Date.now());
    assert.equal(await fs.readFile(path.join(inbox.dir, "inbox.jsonl"), "utf8"), before);
    assert.deepEqual((await inbox.request("/pull")).data.items, [], "status must preserve retry backoff");
    await inbox.request("/ack", { id: queued.id, ok: false, error: "still unavailable", receiptId: "status-failure-2" });
    const failed = (await inbox.request(route)).data.items[0];
    assert.equal(failed.status, "failed");
    assert.equal(failed.ok, false);
    assert.equal(failed.error, genericFailure);
    assert.equal(failed.attempts, 2);
    assert.equal(failed.next_attempt_at, null);
    assert.deepEqual((await inbox.request("/pull")).data.items, []);
  } finally { await inbox.close(); }
});

test("analysis failures stop after three total attempts even when configuration requests more", async () => {
  const inbox = await startInbox({ INBOX_RETRY_BASE_MS: "500", INBOX_MAX_ATTEMPTS: "99" });
  try {
    const { data: queued } = await inbox.request("/collect", { url: article });
    for (let attempt = 1; attempt <= 3; attempt++) {
      const ack = { id: queued.id, ok: false, error: "temporary model outage", receiptId: `failure-${attempt}` };
      const first = await inbox.request("/ack", ack);
      assert.equal(first.status, 200);
      assert.equal(first.data.status, attempt < 3 ? "pending" : "failed");
      assert.equal(first.data.attempts, attempt);
      assert.equal(first.data.maxAttempts, 3);
      assert.equal((await inbox.request("/ack", ack)).data.attempts, attempt, "replayed ACK must not consume another attempt");
      assert.deepEqual((await inbox.request("/pull")).data.items, [], "backoff must prevent immediate analysis retry");
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, attempt === 1 ? 550 : 1050));
        const pulled = (await inbox.request("/pull")).data.items[0];
        assert.equal(pulled?.id, queued.id);
        assert.equal(pulled.attempts, attempt);
        assert.equal(pulled.maxAttempts, 3);
        assert.equal((await inbox.request("/ack", ack)).data.attempts, attempt, "delayed replay must still be idempotent");
      }
    }
    const failed = (await inbox.request("/failed")).data.items;
    assert.equal(failed.length, 1);
    assert.equal(failed[0].error, genericFailure);
    assert.equal(failed[0].attempts, 3);
    assert.equal(failed[0].maxAttempts, 3);
    assert.equal((await inbox.request("/ack", { id: queued.id, ok: false, receiptId: "fourth-failure" })).data.attempts, 3);
    assert.equal((await inbox.request("/ack", { id: queued.id, ok: true, receiptId: "late-success" })).data.status, "failed");
    const stored = await fs.readFile(path.join(inbox.dir, "inbox.jsonl"), "utf8");
    assert.deepEqual((await inbox.request("/collect", { url: article })).data, { id: queued.id, status: "failed" });
    assert.equal(await fs.readFile(path.join(inbox.dir, "inbox.jsonl"), "utf8"), stored);
    await inbox.restart();
    assert.equal((await inbox.request(`/status?ids=${queued.id}`)).data.items[0].attempts, 3);
    assert.deepEqual((await inbox.request("/pull")).data.items, []);
    assert.equal((await inbox.request("/retry", { id: queued.id })).status, 200);
    const retry = (await inbox.request("/pull")).data.items[0];
    assert.equal(retry?.id, queued.id);
    assert.equal(retry.attempts, 0);
    assert.equal(retry.maxAttempts, 3);
    assert.equal((await inbox.request("/ack", { id: queued.id, ok: false, receiptId: "failure-3" })).data.attempts, 0,
      "a delayed old receipt after manual retry must remain a no-op");
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

test("terminal failed articles stay stopped beyond history expiry and require explicit retry", async () => {
  const inbox = await startInbox({ INBOX_RETRY_BASE_MS: "1", INBOX_MAX_ATTEMPTS: "1" });
  try {
    const { data: queued } = await inbox.request("/collect", { url: article });
    await inbox.request("/ack", { id: queued.id, ok: false, receiptId: "failed" });
    const savedPath = path.join(inbox.dir, "inbox.jsonl");
    const stored = JSON.parse(await fs.readFile(savedPath, "utf8"));
    stored.received_at = stored.acked_at = new Date(Date.now() - 90 * 24 * 60 * 60 * 1_000).toISOString();
    await fs.writeFile(savedPath, JSON.stringify(stored) + "\n");
    await inbox.restart();
    const reshared = await inbox.request("/collect", { url: article });
    assert.equal(reshared.data.status, "failed");
    assert.equal(reshared.data.id, queued.id);
    assert.equal((await inbox.request("/failed")).data.items[0]?.id, queued.id);
    assert.equal((await inbox.request("/pull")).data.items.length, 0);
    assert.equal((await inbox.request("/retry", { id: queued.id })).data.attempts, 0);
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

test("failure report sanitizer allows only bounded structural diagnostics and redacts known secrets", () => {
  const secret = "private-test-value";
  const input = {
    version: 1, stage: "card_validation", articleTitle: `文章\u0000 ${secret} ${"😀".repeat(205)}`,
    batch: 2, imageStart: 3, imageEnd: 7, rawResponse: secret, apiKey: secret, issueCount: 30,
    issues: [
      { cardIndex: 1, cardType: "palette", cardTitle: `配色 sk-proj-abcdefghijk ${secret} ${"色".repeat(90)}`,
        field: "payload.colors[0].hex", code: "invalid_color", rawValue: secret, message: secret },
      { cardIndex: 2, cardType: secret, cardTitle: "网站", field: "payload.url", code: "invalid_url" },
      { cardIndex: 3, field: `payload.${secret}`, code: "invalid_format" },
      { cardIndex: 4, field: "payload.url\nraw response", code: "invalid_url" },
      { cardIndex: 5, field: "payload", code: "unknown_code" },
      ...Array.from({ length: 15 }, (_, index) => ({ cardIndex: index + 6, field: "title", code: "missing_value" }))
    ]
  };
  const report = sanitizeFailureReport(input, [secret]);
  assert.equal(report.version, 1); assert.equal(report.stage, "card_validation");
  assert.equal(report.issues.length, 10); assert.equal(report.issueCount, 30);
  assert.ok(Array.from(report.articleTitle).length <= 200);
  assert.ok(Array.from(report.issues[0].cardTitle).length <= 80);
  assert.equal(report.issues[1].cardType, undefined);
  const encoded = JSON.stringify(report);
  for (const forbidden of [secret, "sk-proj-abcdefghijk", "rawResponse", "rawValue", "apiKey", "unknown_code", "message"]) {
    assert.ok(!encoded.includes(forbidden), forbidden);
  }
  const summary = formatFailureReport(report);
  assert.match(summary, /第 2 批，图片 3–7/);
  assert.match(summary, /payload.colors\[0\].hex — 颜色值无效/);
  assert.match(summary, /共 30 个问题/);
  assert.ok(Array.from(summary).length <= 2_200);
  for (const invalid of [null, {}, { ...input, version: 2 }, { ...input, stage: "raw_model" },
    { ...input, issues: [] }, { ...input, issues: [{ cardIndex: -1, field: "$", code: "invalid_json" }] }]) {
    assert.equal(sanitizeFailureReport(invalid), null);
  }
  assert.equal(formatFailureReport(null), genericFailure);
  const longContext = "long-private-context-".repeat(500);
  const protectedContext = sanitizeFailureReport({ version: 1, stage: "model_response", articleTitle: longContext,
    issues: [{ cardIndex: 0, field: "$", code: "truncated" }], issueCount: 1 }, [longContext]);
  assert.equal(protectedContext.articleTitle, "[已隐藏]", "long context secrets must be redacted before title truncation");
});

test("structured failure reports persist through restart and status never exposes raw model/API text", async () => {
  const inbox = await startInbox({ INBOX_MAX_ATTEMPTS: "1" });
  try {
    const { data: queued } = await inbox.request("/collect", { url: article });
    const failureReport = { version: 1, stage: "card_validation", articleTitle: `文章 ${token}`,
      batch: 2, imageStart: 4, imageEnd: 6, issueCount: 1,
      issues: [{ cardIndex: 3, cardTitle: "无效颜色", cardType: "palette", field: "payload.colors[0].hex", code: "invalid_color",
        raw: `Bearer ${token}` }], rawResponse: token };
    const ack = { id: queued.id, ok: false, receiptId: "structured-failure", failureReport,
      error: `Raw API: Bearer ${token}; sk-proj-abcdefghijklmnop` };
    assert.equal((await inbox.request("/ack", ack)).data.maxAttempts, 1);
    const savedPath = path.join(inbox.dir, "inbox.jsonl");
    const saved = await fs.readFile(savedPath, "utf8");
    assert.ok(!saved.includes(token)); assert.ok(!saved.includes("sk-proj-abcdefghijklmnop")); assert.ok(!saved.includes("rawResponse"));
    assert.equal(JSON.parse(saved).failureReport.issues[0].code, "invalid_color");
    await inbox.restart();
    const status = (await inbox.request(`/status?ids=${queued.id}`)).data.items[0];
    assert.equal(status.title, "文章 [已隐藏]");
    assert.equal(status.failureReport.articleTitle, status.title);
    assert.equal(status.maxAttempts, 1); assert.equal(status.attempts, 1);
    assert.match(status.error, /颜色值无效/);
    const failed = (await inbox.request("/failed")).data.items[0];
    assert.deepEqual(failed.failureReport, status.failureReport);
    assert.equal(failed.maxAttempts, 1); assert.equal(failed.title, status.title);
    await inbox.request("/ack", { ...ack, receiptId: "another-failure", failureReport: { version: 2 } });
    assert.deepEqual((await inbox.request(`/status?ids=${queued.id}`)).data.items[0], status);
    await inbox.request("/retry", { id: queued.id });
    const reset = (await inbox.request(`/status?ids=${queued.id}`)).data.items[0];
    assert.equal(reset.failureReport, null); assert.equal(reset.title, null); assert.equal(reset.error, undefined);
    assert.equal(reset.attempts, 0);
  } finally { await inbox.close(); }
});

test("successful completion clears failure reports and its parsed title wins", async () => {
  const inbox = await startInbox({ INBOX_RETRY_BASE_MS: "1" });
  try {
    const { data: queued } = await inbox.request("/collect", { url: article });
    await inbox.request("/ack", { id: queued.id, ok: false, receiptId: "first-failure", failureReport: {
      version: 1, stage: "model_response", articleTitle: "失败时的标题", issues: [{ cardIndex: 0, field: "$", code: "invalid_json" }], issueCount: 1
    } });
    assert.equal((await inbox.request(`/status?ids=${queued.id}`)).data.items[0].title, "失败时的标题");
    await inbox.request("/ack", { id: queued.id, ok: true, title: "成功解析标题", receiptId: "success" });
    const result = (await inbox.request(`/status?ids=${queued.id}`)).data.items[0];
    assert.equal(result.title, "成功解析标题"); assert.equal(result.failureReport, null); assert.equal(result.error, undefined);
    assert.equal(result.status, "done"); assert.equal(result.attempts, 2);
    const saved = JSON.parse(await fs.readFile(path.join(inbox.dir, "inbox.jsonl"), "utf8"));
    assert.equal(saved.failureReport, undefined);
  } finally { await inbox.close(); }
});

test("legacy pending rows at the retry cap become stopped failures on startup", async () => {
  const inbox = await startInbox();
  try {
    const { data: queued } = await inbox.request("/collect", { url: article });
    const savedPath = path.join(inbox.dir, "inbox.jsonl");
    const stored = JSON.parse(await fs.readFile(savedPath, "utf8"));
    Object.assign(stored, { attempts: 3, status: "pending", next_attempt_at: new Date(Date.now() + 60_000).toISOString(),
      error: `Legacy raw API ${token}` });
    await fs.writeFile(savedPath, JSON.stringify(stored) + "\n");
    await inbox.restart();
    assert.deepEqual((await inbox.request("/pull")).data.items, []);
    const failed = (await inbox.request(`/status?ids=${queued.id}`)).data.items[0];
    assert.equal(failed.status, "failed"); assert.equal(failed.attempts, 3); assert.equal(failed.maxAttempts, 3);
    assert.equal(failed.next_attempt_at, null); assert.equal(failed.error, genericFailure);
    assert.equal((await inbox.request("/ack", { id: queued.id, ok: false, receiptId: "fourth" })).data.attempts, 3);
    assert.ok(!(await fs.readFile(savedPath, "utf8")).includes(token));
  } finally { await inbox.close(); }
});

test("terminal failures are retained when capacity is exhausted rather than evicted for another retry", async () => {
  const inbox = await startInbox({ INBOX_MAX_ATTEMPTS: "1", INBOX_MAX_ROWS: "1", INBOX_HISTORY_DAYS: "1" });
  try {
    const { data: queued } = await inbox.request("/collect", { url: article });
    await inbox.request("/ack", { id: queued.id, ok: false, receiptId: "failed" });
    const savedPath = path.join(inbox.dir, "inbox.jsonl");
    const stored = JSON.parse(await fs.readFile(savedPath, "utf8"));
    stored.received_at = stored.acked_at = "2020-01-01T00:00:00.000Z";
    await fs.writeFile(savedPath, JSON.stringify(stored) + "\n");
    await inbox.restart();
    assert.equal((await inbox.request("/collect", { url: `${article}-new` })).status, 429);
    assert.equal((await inbox.request("/collect", { url: article })).data.status, "failed");
    assert.equal((await inbox.request("/failed")).data.items.length, 1);
  } finally { await inbox.close(); }
});

test("manual retry gets a new stable generation and rejects receipts from the previous cycle", async () => {
  const inbox = await startInbox({ INBOX_MAX_ATTEMPTS: "1" });
  try {
    const { data: queued } = await inbox.request("/collect", { url: article });
    const route = `/status?ids=${queued.id}`;
    const first = (await inbox.request("/pull")).data.items[0];
    assert.match(first.generation, /^[0-9a-f-]{36}$/);
    assert.equal((await inbox.request(route)).data.items[0].generation, first.generation);
    const failed = await inbox.request("/ack", { id: queued.id, generation: first.generation, ok: false, receiptId: "generation-first-failure" });
    assert.equal(failed.data.generation, first.generation);
    assert.equal((await inbox.request("/failed")).data.items[0].generation, first.generation);
    const retry = (await inbox.request("/retry", { id: queued.id })).data;
    assert.notEqual(retry.generation, first.generation);
    assert.equal(retry.attempts, 0);
    await inbox.restart();
    assert.equal((await inbox.request("/pull")).data.items[0].generation, retry.generation);
    const before = (await inbox.request(route)).data.items[0];
    for (const ok of [true, false]) {
      const stale = await inbox.request("/ack", { id: queued.id, generation: first.generation,
        ok, title: "过期的标题", receiptId: `stale-generation-${ok}` });
      assert.equal(stale.data.generation, retry.generation);
      assert.equal(stale.data.attempts, 0);
      assert.deepEqual((await inbox.request(route)).data.items[0], before);
    }
    await inbox.request("/ack", { id: queued.id, generation: retry.generation, ok: true, receiptId: "current-success" });
    await inbox.request("/ack", { id: queued.id, generation: first.generation, ok: true, title: "过期补填不得生效", receiptId: "old-title" });
    assert.equal((await inbox.request(route)).data.items[0].title, null);
    await inbox.request("/ack", { id: queued.id, generation: retry.generation, ok: true, title: "本轮标题", receiptId: "current-success" });
    const completed = (await inbox.request(route)).data.items[0];
    assert.equal(completed.title, "本轮标题"); assert.equal(completed.attempts, 1);
    await inbox.restart();
    assert.deepEqual((await inbox.request(route)).data.items[0], completed);
  } finally { await inbox.close(); }
});

test("legacy rows keep the stable legacy generation without rewriting identity on startup", async () => {
  const inbox = await startInbox({ INBOX_MAX_ATTEMPTS: "1" });
  try {
    const { data: queued } = await inbox.request("/collect", { url: article });
    const savedPath = path.join(inbox.dir, "inbox.jsonl");
    const stored = JSON.parse(await fs.readFile(savedPath, "utf8"));
    delete stored.generation;
    const legacy = JSON.stringify(stored) + "\n";
    await fs.writeFile(savedPath, legacy);
    await inbox.restart();
    assert.equal(await fs.readFile(savedPath, "utf8"), legacy);
    assert.equal((await inbox.request("/pull")).data.items[0].generation, "legacy");
    assert.equal((await inbox.request(`/status?ids=${queued.id}`)).data.items[0].generation, "legacy");
    const failed = await inbox.request("/ack", { id: queued.id, generation: "legacy", ok: false, receiptId: "legacy-failure" });
    assert.equal(failed.data.generation, "legacy");
    await inbox.restart();
    assert.equal((await inbox.request("/failed")).data.items[0].generation, "legacy");
    assert.equal(JSON.parse(await fs.readFile(savedPath, "utf8")).generation, undefined);
    const retried = (await inbox.request("/retry", { id: queued.id })).data;
    assert.notEqual(retried.generation, "legacy");
    assert.equal(retried.id, queued.id);
  } finally { await inbox.close(); }
});
