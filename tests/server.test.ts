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

test('article summaries expose complete type counts independently from child filtering', async () => {
  store.upsertArticle({ id: 'v024-types', url: 'https://mp.weixin.qq.com/s/v024-types', title: 'Mixed categories', account: 'Fixture author', publishDate: '', description: '', summary: 'Summary for parent view', imagesDir: 'private-image-directory', processed: true });
  store.replaceItems('v024-types', [
    { type: 'note', title: 'Note', payload: { sections: [{ heading: 'Test', bullets: ['Content'] }] } },
    { type: 'palette', title: 'Color', payload: { colors: [{ hex: '#6FAEE0', name: 'Blue' }] } },
    { type: 'note', title: 'Another note', payload: { sections: [{ heading: 'Test', bullets: ['Second'] }] } },
  ], new Map());
  store.upsertArticle({ id: 'v024-empty', url: 'https://mp.weixin.qq.com/s/v024-empty', title: 'Article without cards', account: 'Fixture author', publishDate: '', description: '' });
  try {
    const bootstrap = await (await fetch(`${base}/api/bootstrap`)).json() as any;
    const summary = bootstrap.articles.find((a: any) => a.id === 'v024-types');
    assert.equal(summary.title, 'Mixed categories');
    assert.equal(summary.account, 'Fixture author');
    assert.equal(summary.itemCount, 3);
    assert.deepEqual(summary.typeCounts, { palette: 1, website: 0, repo: 0, prompt: 0, note: 2 });
    assert.ok(summary.processed_at && summary.fetched_at);
    assert.equal(Object.hasOwn(summary, 'images_dir'), false);
    const empty = bootstrap.articles.find((a: any) => a.id === 'v024-empty');
    assert.equal(empty.itemCount, 0);
    assert.deepEqual(empty.typeCounts, { palette: 0, website: 0, repo: 0, prompt: 0, note: 0 });
    const fullArticles = await (await fetch(`${base}/api/articles`)).json() as any[];
    assert.equal(fullArticles.find(a => a.id === 'v024-types').images_dir, 'private-image-directory');
  } finally {
    store.deleteArticle('v024-types');
    store.deleteArticle('v024-empty');
  }
});

test('article-scoped item query applies category, search, total and pagination to one article', async () => {
  store.upsertArticle({ id: 'v024-scoped', url: 'https://mp.weixin.qq.com/s/v024-scoped', title: 'Scoped article', account: 'Fixture author', publishDate: '', description: '' });
  store.replaceItems('v024-scoped', [
    { type: 'note', title: 'Needle one', payload: { sections: [{ heading: 'Test', bullets: ['Content'] }] } },
    { type: 'note', title: 'Needle two', payload: { sections: [{ heading: 'Test', bullets: ['Content'] }] } },
    { type: 'palette', title: 'Needle color', payload: { colors: [{ hex: '#8CC9EC' }] } },
  ], new Map());
  try {
    const first = await (await fetch(`${base}/api/items?articleId=v024-scoped&type=note&q=Needle&limit=1&offset=0`)).json() as any;
    const second = await (await fetch(`${base}/api/items?articleId=v024-scoped&type=note&q=Needle&limit=1&offset=1`)).json() as any;
    assert.equal(first.total, 2);
    assert.equal(second.total, 2);
    assert.equal(first.items.length, 1);
    assert.equal(second.items.length, 1);
    assert.notEqual(first.items[0].id, second.items[0].id);
    for (const item of [...first.items, ...second.items]) {
      assert.equal(item.article_id, 'v024-scoped');
      assert.equal(item.type, 'note');
    }
    const absent = await (await fetch(`${base}/api/items?articleId=unknown&type=note`)).json() as any;
    assert.deepEqual(absent, { items: [], total: 0 });
  } finally { store.deleteArticle('v024-scoped'); }
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

test('archive endpoint clears only completed history and never deletes collected articles or cards', async () => {
  const created = await post('/api/tasks', { url: 'https://mp.weixin.qq.com/s/existing' });
  const { task } = await created.json() as any;
  const { getTaskQueue } = await import('../core/tasks.js');
  await getTaskQueue().wait(task.id);
  const response = await post('/api/tasks/archive', { ids: ['arbitrary-untrusted-id'] });
  assert.equal(response.status, 200);
  assert.ok(((await response.json()) as any).archived >= 1);
  const snapshot = await (await fetch(`${base}/api/tasks`)).json() as any;
  assert.equal(snapshot.tasks.some((row: any) => row.id === task.id), false);
  assert.equal(store.countItems(), 603);
  assert.equal((await getTaskQueue().wait(task.id)).skipped, true);
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
  const deleted = await fetch(`${base}/api/tasks/${task.id}`, { method: 'DELETE' });
  assert.equal(deleted.status, 200);
  const visible = await (await fetch(`${base}/api/tasks`)).json() as any;
  assert.equal(visible.tasks.some((row: any) => row.id === task.id), false);
  assert.equal(store.countItems(), 603);
  assert.ok(store.getArticle('existing'));
  assert.equal((await fetch(`${base}/api/tasks/missing`, { method: 'DELETE' })).status, 400);
});
