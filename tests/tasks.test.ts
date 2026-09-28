import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTaskQueue, normalizeArticleUrl } from '../core/tasks.js';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inspiration-tasks-'));
  return { dir, filePath: path.join(dir, 'tasks.json') };
}
const result = (title: string) => ({ articleId: title, title, account: '', articleType: 'note', summary: '', tags: [], counts: { note: 1 }, unsureCount: 0, items: [] });

test('overlapping submissions are queued without dropping links, and duplicates share active work', async () => {
  const { filePath } = fixture();
  let active = 0, maxActive = 0;
  const calls: string[] = [];
  const queue = createTaskQueue({ filePath, process: async (url) => {
    calls.push(url); maxActive = Math.max(maxActive, ++active);
    await new Promise(resolve => setTimeout(resolve, 10));
    active--; return result(url);
  } });
  const one = queue.enqueue('https://mp.weixin.qq.com/s/one', 'clipboard');
  const duplicate = queue.enqueue(one.url, 'inbox');
  const two = queue.enqueue('https://mp.weixin.qq.com/s/two', 'clipboard');
  assert.equal(duplicate.id, one.id);
  await Promise.all([queue.wait(one.id), queue.wait(two.id)]);
  assert.equal(maxActive, 1);
  assert.deepEqual(calls, [one.url, two.url]);
  assert.deepEqual(queue.list().map(t => t.status), ['done', 'done']);
});

test('failed work is visible and can be retried while preserving its identity', async () => {
  const { filePath } = fixture(); let attempts = 0;
  const queue = createTaskQueue({ filePath, process: async () => {
    if (++attempts === 1) throw new Error('network unavailable');
    return result('recovered');
  } });
  const task = queue.enqueue('https://mp.weixin.qq.com/s/retry', 'manual');
  await assert.rejects(queue.wait(task.id), /network unavailable/);
  assert.equal(queue.list()[0].status, 'failed');
  const retried = queue.retry(task.id);
  assert.equal(retried.id, task.id);
  assert.equal((await queue.wait(task.id)).title, 'recovered');
  assert.equal(queue.list()[0].attempts, 2);
});

test('persisted interrupted work resumes on restart, completed work does not run again', async () => {
  const { filePath } = fixture();
  const now = new Date().toISOString();
  fs.writeFileSync(filePath, JSON.stringify([
    { id: 'interrupted', url: 'https://mp.weixin.qq.com/s/resume', source: 'manual', status: 'running', attempts: 1, createdAt: now, updatedAt: now, refresh: false },
    { id: 'completed', url: 'https://mp.weixin.qq.com/s/done', source: 'manual', status: 'done', attempts: 1, createdAt: now, updatedAt: now, refresh: false, result: result('done') },
  ]));
  const calls: string[] = [];
  const queue = createTaskQueue({ filePath, process: async url => { calls.push(url); return result('resumed'); } });
  queue.start();
  await queue.wait('interrupted');
  assert.equal(calls.length, 1);
  assert.equal((await queue.wait('completed')).title, 'done');
});

test('explicit refresh stays separate from ordinary collection and errors can be redacted', async () => {
  const { filePath } = fixture(); const refreshes: boolean[] = [];
  const queue = createTaskQueue({ filePath, process: async (_url, opts) => { refreshes.push(opts.refresh); throw new Error('secret-value'); }, sanitizeError: () => 'redacted' });
  const first = queue.enqueue('https://mp.weixin.qq.com/s/same', 'manual');
  const second = queue.enqueue(first.url, 'reprocess', true);
  assert.notEqual(first.id, second.id);
  await assert.rejects(queue.wait(first.id), /redacted/);
  await assert.rejects(queue.wait(second.id), /redacted/);
  assert.deepEqual(refreshes, [false, true]);
  assert.ok(!fs.readFileSync(filePath, 'utf8').includes('secret-value'));
});

test('long WeChat links remain accepted while lookalike hosts are rejected', () => {
  const url = 'https://mp.weixin.qq.com/s?__biz=MzABC==&mid=42&idx=1&sn=abcdef';
  assert.equal(normalizeArticleUrl(url), url);
  assert.throws(() => normalizeArticleUrl('https://mp.weixin.qq.com.evil.invalid/s/no'));
  assert.throws(() => normalizeArticleUrl('https://evil.invalid/?url=https://mp.weixin.qq.com/s/no'));
});

test('completed extraction settles even when its final history write fails', async (t) => {
  const { filePath } = fixture();
  const rename = fs.renameSync;
  let failSave = false;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (failSave && to === filePath) throw new Error('disk full');
    return rename(from, to);
  });
  const queue = createTaskQueue({ filePath, process: async () => { failSave = true; return result('committed'); } });
  const task = queue.enqueue('https://mp.weixin.qq.com/s/committed');
  const completed = await Promise.race([queue.wait(task.id), new Promise((_, reject) => setTimeout(() => reject(new Error('waiter hung')), 300))]);
  assert.equal((completed as any).title, 'committed');
});

test('failed retry persistence restores the original failed task', async (t) => {
  const { filePath } = fixture();
  const queue = createTaskQueue({ filePath, process: async () => { throw new Error('model unavailable'); } });
  const task = queue.enqueue('https://mp.weixin.qq.com/s/retry-persist');
  await assert.rejects(queue.wait(task.id));
  t.mock.method(fs, 'renameSync', () => { throw new Error('disk full'); });
  assert.throws(() => queue.retry(task.id), /disk full/);
  assert.equal(queue.list()[0].status, 'failed');
  assert.equal(queue.list()[0].error, 'model unavailable');
});

test('an interrupted explicit reprocess waits for human retry instead of repeating a possible commit', async () => {
  const { filePath } = fixture(); const now = new Date().toISOString();
  fs.writeFileSync(filePath, JSON.stringify([{ id: 'refresh', url: 'https://mp.weixin.qq.com/s/refresh', source: 'reprocess', refresh: true, status: 'running', attempts: 1, createdAt: now, updatedAt: now }]));
  let calls = 0;
  const queue = createTaskQueue({ filePath, process: async () => { calls++; return result('unexpected'); } });
  await assert.rejects(queue.wait('refresh'), /重跑被中断/);
  assert.equal(calls, 0);
});
