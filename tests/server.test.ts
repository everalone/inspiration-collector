import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "inspiration-http-test-"));
process.env.INSPIRATION_DATA_DIR = temp;
fs.mkdirSync(path.join(temp, "data"));
fs.writeFileSync(path.join(temp, "data/config.json"), JSON.stringify({ apiKey: "unit-test-secret-123456", inboxToken: "unit-test-inbox-secret", inboxEnabled: false, inboxUrl: "" }));
const { startServer } = await import("../core/server.js");
const store = await import("../core/store.js");
const { CONFIG_PATH, loadConfig, saveConfig } = await import("../core/config.js");
store.upsertArticle({ id: "existing", url: "https://mp.weixin.qq.com/s/existing", title: "Existing article", account: "test", publishDate: "", description: "", processed: true });
store.replaceItems("existing", Array.from({ length: 603 }, (_, i) => ({ type: "note" as const, title: `Card ${i}`, payload: { sections: [{ heading: "test", bullets: [String(i)] }] } })), new Map());
const server = await startServer(0);
const port = (server.address() as import("node:net").AddressInfo).port;
const base = `http://127.0.0.1:${port}`;
const post = (url: string, body: unknown, extra = {}) => fetch(base + url, { method: "POST", headers: { "Content-Type": "application/json", ...extra }, body: JSON.stringify(body) });
after(async () => {
  await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
  store.getDb().close();
  assert.ok(temp.startsWith(path.join(os.tmpdir(), "inspiration-http-test-")));
  fs.rmSync(temp, { recursive: true, force: true });
});

test('HTTP pagination includes all 603 stored cards without duplication', async () => {
  const ids = new Set<string>();
  for (const offset of [0, 200, 400, 600]) {
    const response = await fetch(`${base}/api/items?limit=200&offset=${offset}`);
    const data = await response.json() as any;
    assert.equal(data.total, 603);
    for (const row of data.items) ids.add(row.id);
  }
  assert.equal(ids.size, 603);
});

test('queue submission for an existing article finishes without API analysis or card replacement', async () => {
  const response = await post('/api/tasks', { url: 'https://mp.weixin.qq.com/s/existing' });
  assert.equal(response.status, 202);
  const { task } = await response.json() as any;
  const { getTaskQueue } = await import('../core/tasks.js');
  const result = await getTaskQueue().wait(task.id);
  assert.equal(result.skipped, true);
  assert.equal(store.countItems(), 603);
});

test('invalid collection URLs, cross-site mutations and rebinding hosts are rejected', async () => {
  assert.equal((await post('/api/tasks', { url: 'https://mp.weixin.qq.com.evil.invalid/s/no' })).status, 400);
  assert.equal((await post('/api/config', { model: 'should-not-save' }, { Origin: 'https://evil.invalid' })).status, 403);
  const status = await new Promise(resolve => {
    http.get(`${base}/api/config`, { headers: { Host: 'evil.invalid' } }, response => { response.resume(); resolve(response.statusCode); });
  });
  assert.equal(status, 403);
});

test('public config does not return API key or inbox token, and plaintext remote inbox is rejected', async () => {
  const response = await fetch(`${base}/api/config`);
  const config = await response.text();
  assert.ok(!config.includes('unit-test-secret-123456'));
  assert.ok(!config.includes('unit-test-inbox-secret'));
  assert.equal((await post('/api/config', { inboxUrl: 'http://example.invalid' })).status, 400);
  const saved = await post('/api/config', { inboxIntervalSec: 45 });
  assert.equal((await saved.json() as any).inboxIntervalSec, 45);
});

test('explicit empty secrets stay empty instead of inheriting environment credentials', () => {
  const previousKey = process.env.API_KEY, previousToken = process.env.INBOX_TOKEN;
  process.env.API_KEY = 'environment-only-test-key'; process.env.INBOX_TOKEN = 'environment-only-test-token';
  try {
    saveConfig({ apiKey: '', inboxToken: '' });
    assert.equal(loadConfig().apiKey, ''); assert.equal(loadConfig().inboxToken, '');
    assert.ok(fs.existsSync(CONFIG_PATH));
  } finally {
    if (previousKey === undefined) delete process.env.API_KEY; else process.env.API_KEY = previousKey;
    if (previousToken === undefined) delete process.env.INBOX_TOKEN; else process.env.INBOX_TOKEN = previousToken;
  }
});

test('deleting an article with an active refresh is refused instead of restoring it later', async () => {
  const originalFetch = globalThis.fetch;
  let release!: (value: Response) => void;
  const body = new Promise<Response>(resolve => { release = resolve; });
  globalThis.fetch = ((input, init) => String(input).startsWith('https://mp.weixin.qq.com/')
    ? body : originalFetch(input, init)) as typeof fetch;
  const { getTaskQueue } = await import('../core/tasks.js');
  const queue = getTaskQueue();
  const task = queue.enqueue('https://mp.weixin.qq.com/s/existing', 'reprocess', true);
  const outcome = queue.wait(task.id).catch(error => error);
  try {
    const response = await originalFetch(`${base}/api/articles/existing`, { method: 'DELETE' });
    assert.equal(response.status, 409);
    assert.equal(store.countItems(), 603);
  } finally {
    release(new Response('环境异常'));
    await outcome;
    globalThis.fetch = originalFetch;
  }
});
