import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTaskQueue, normalizeArticleUrl } from '../core/tasks.js';
import { CollectionFailure, sanitizeFailureReport, type FailureReport } from '../core/failure-report.js';
import { setUpdatePending } from '../core/maintenance.js';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inspiration-tasks-'));
  return { dir, filePath: path.join(dir, 'tasks.json') };
}

test('deleting a failure hides collapsed attempts durably while keeping inbox replay and later rounds', async () => {
  const { filePath } = fixture(); let calls = 0;
  const process = async () => { calls++; throw new Error('no article content'); };
  const queue = createTaskQueue({ filePath, process });
  const url = 'https://mp.weixin.qq.com/s/delete-failure';
  const context = { id: 'remote-delete', generation: 'round-one', maxAttempts: 3 };
  let latest = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    latest = queue.enqueue(url, 'inbox', false, { ...context, attempt }).id;
    await assert.rejects(queue.wait(latest));
  }
  assert.equal(queue.archiveFailure(latest).archived, 3);
  assert.equal(queue.archiveFailure(latest).archived, 0);
  assert.deepEqual(queue.list(), []);
  const restarted = createTaskQueue({ filePath, process });
  assert.deepEqual(restarted.list(), []);
  assert.equal(restarted.isInboxFailureArchived({ ...context, attempts: 3 }), true);
  assert.equal(restarted.isInboxFailureArchived({ ...context, generation: 'round-two', attempts: 3 }), false);
  const replay = restarted.enqueue(url, 'inbox', false, { ...context, attempt: 3 });
  assert.equal(replay.id, latest);
  await assert.rejects(restarted.wait(replay.id), /no article content/);
  assert.equal(calls, 3);
  assert.throws(() => restarted.retry(latest), /已删除/);
  const next = restarted.enqueue(url, 'inbox', false, { ...context, generation: 'round-two', attempt: 1 });
  await assert.rejects(restarted.wait(next.id));
  assert.deepEqual(restarted.list().map(t => t.id), [next.id]);
});

test('failure deletion refuses active/completed work and rolls back on persistence failure', async (t) => {
  const { filePath } = fixture();
  const queue = createTaskQueue({ filePath, process: async () => result('kept') });
  const pending = queue.enqueue('https://mp.weixin.qq.com/s/keep-active');
  assert.throws(() => queue.archiveFailure(pending.id), /只能删除失败/);
  await queue.wait(pending.id);
  assert.throws(() => queue.archiveFailure(pending.id), /只能删除失败/);
  assert.throws(() => queue.archiveFailure('missing'), /任务不存在/);
  const failed = createTaskQueue({ filePath: fixture().filePath, process: async () => { throw new Error('failed'); } });
  const item = failed.enqueue('https://mp.weixin.qq.com/s/rollback');
  await assert.rejects(failed.wait(item.id));
  t.mock.method(fs, 'renameSync', () => { throw new Error('disk full'); });
  assert.throws(() => failed.archiveFailure(item.id), /disk full/);
  assert.equal(failed.list()[0].archivedAt, undefined);
});
const result = (title: string) => ({ articleId: title, title, account: '', articleType: 'note', summary: '', tags: [], counts: { note: 1 }, unsureCount: 0, items: [] });

test('two failed inbox attempts are archived after the third succeeds without losing replay outcomes', async () => {
  const { filePath } = fixture(); let calls = 0;
  const process = async () => { if (++calls < 3) throw new Error(`failure ${calls}`); return result('recovered article'); };
  const queue = createTaskQueue({ filePath, process });
  const url = 'https://mp.weixin.qq.com/s/recovered-history';
  const context = { id: 'remote', generation: 'round-one', maxAttempts: 3 };
  const first = queue.enqueue(url, 'inbox', false, { ...context, attempt: 1 });
  await assert.rejects(queue.wait(first.id), /failure 1/);
  const second = queue.enqueue(url, 'inbox', false, { ...context, attempt: 2 });
  await assert.rejects(queue.wait(second.id), /failure 2/);
  const third = queue.enqueue(url, 'inbox', false, { ...context, attempt: 3 });
  await queue.wait(third.id);
  assert.deepEqual(queue.list().map(t => t.id), [third.id]);
  const stored = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(stored.find((t: any) => t.id === first.id).resolvedBy, third.id);
  const restarted = createTaskQueue({ filePath, process });
  assert.deepEqual(restarted.list().map(t => t.id), [third.id]);
  const replayed = restarted.enqueue(url, 'inbox', false, { ...context, attempt: 1 });
  assert.equal(replayed.id, first.id);
  await assert.rejects(restarted.wait(replayed.id), /failure 1/);
  assert.equal(calls, 3);
});

test('legacy same-millisecond success repairs old failure history but keeps a later failed refresh', () => {
  const { filePath } = fixture(); const now = '2026-11-01T10:00:00.000Z';
  const base = { url: 'https://mp.weixin.qq.com/s/legacy-history', source: 'inbox', attempts: 1, createdAt: now, updatedAt: now, refresh: false };
  fs.writeFileSync(filePath, JSON.stringify([
    { ...base, id: 'failure-one', status: 'failed', error: 'first' },
    { ...base, id: 'failure-two', status: 'failed', error: 'second' },
    { ...base, id: 'success', status: 'done', result: result('success') },
    { ...base, id: 'failed-refresh', source: 'reprocess', refresh: true, status: 'failed', error: 'refresh failed' },
    { ...base, id: 'duplicate', status: 'done', result: { ...result('already saved'), skipped: true } },
  ]));
  const queue = createTaskQueue({ filePath, process: async () => { throw new Error('must not run'); } });
  assert.deepEqual(queue.list().filter(t => t.status === 'failed').map(t => t.id), ['failed-refresh']);
  assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8')).find((t: any) => t.id === 'failure-one').resolvedBy, 'success');
});

test('a successful retry of an older task id resolves newer-created failures without rewriting their replay result', async () => {
  const { filePath } = fixture(); const now = '2026-11-01T10:00:00.000Z';
  const base = { url: 'https://mp.weixin.qq.com/s/reused-id', source: 'manual', attempts: 1, createdAt: now, updatedAt: now, refresh: false, status: 'failed' };
  fs.writeFileSync(filePath, JSON.stringify([
    { ...base, id: 'older-id', error: 'old failure' },
    { ...base, id: 'newer-id', source: 'inbox', error: 'later failure', inbox: { id: 'remote', generation: 'same-round', attempt: 2, maxAttempts: 3 } },
  ]));
  const queue = createTaskQueue({ filePath, process: async () => result('recovered') });
  queue.retry('older-id'); await queue.wait('older-id');
  assert.deepEqual(queue.list().map(t => t.id), ['older-id']);
  await assert.rejects(queue.wait('newer-id'), /later failure/);
  assert.throws(() => queue.retry('newer-id'), /后续成功处理/);
});

test('archived inbox failures remain archived when completed history rolls over', async () => {
  const { filePath } = fixture(); const now = '2026-11-01T10:00:00.000Z';
  const base = { source: 'inbox', attempts: 1, createdAt: now, updatedAt: now, refresh: false };
  fs.writeFileSync(filePath, JSON.stringify([
    { ...base, id: 'old-failure', url: 'https://mp.weixin.qq.com/s/old', status: 'failed', error: 'old error', inbox: { id: 'remote', generation: 'old-round', attempt: 1, maxAttempts: 3 } },
    { ...base, source: 'manual', id: 'old-success', url: 'https://mp.weixin.qq.com/s/old', status: 'done', result: result('old success') },
    ...Array.from({ length: 205 }, (_, i) => ({ ...base, source: 'manual', id: `done-${i}`, url: `https://mp.weixin.qq.com/s/done-${i}`, status: 'done', result: result(`done-${i}`) })),
  ]));
  const queue = createTaskQueue({ filePath, process: async () => result('new') });
  const added = queue.enqueue('https://mp.weixin.qq.com/s/new'); await queue.wait(added.id);
  const restarted = createTaskQueue({ filePath, process: async () => { throw new Error('must not run'); } });
  assert.equal(restarted.list().some(t => t.id === 'old-failure'), false);
  assert.equal(restarted.list().filter(t => t.status === 'done').length, 10);
  assert.equal(restarted.list({ includeArchived: true }).filter(t => t.status === 'done').length, 200);
  await assert.rejects(restarted.wait('old-failure'), /old error/);
});

test('clearing completed history persists through restart and leaves active work and unresolved failures intact', async () => {
  const { filePath } = fixture(); const now = '2026-11-01T10:00:00.000Z';
  const base = { source: 'manual', attempts: 1, createdAt: now, updatedAt: now, refresh: false };
  const context = { id: 'remote', generation: 'archive-round', attempt: 1, maxAttempts: 3 };
  fs.writeFileSync(filePath, JSON.stringify([
    ...Array.from({ length: 12 }, (_, i) => ({ ...base, id: `done-${i}`, url: `https://mp.weixin.qq.com/s/archive-${i}`, status: 'done', result: result(`done-${i}`),
      ...(i === 11 ? { source: 'inbox', inbox: context } : {}) })),
    { ...base, id: 'still-failed', url: 'https://mp.weixin.qq.com/s/still-failed', status: 'failed', error: 'not solved' },
    { ...base, id: 'still-queued', url: 'https://mp.weixin.qq.com/s/still-queued', status: 'queued' },
  ]));
  let calls = 0;
  const process = async () => { calls++; return result('unexpected'); };
  const queue = createTaskQueue({ filePath, process });
  assert.equal(queue.list().filter(t => t.status === 'done').length, 10);
  assert.equal(queue.archiveCompleted().archived, 12);
  assert.deepEqual(queue.list().map(t => t.id), ['still-queued', 'still-failed']);
  const restarted = createTaskQueue({ filePath, process });
  assert.deepEqual(restarted.list().map(t => t.id), ['still-queued', 'still-failed']);
  assert.equal(restarted.archiveCompleted().archived, 0);
  const replay = restarted.enqueue('https://mp.weixin.qq.com/s/archive-11', 'inbox', false, context);
  assert.equal(replay.id, 'done-11');
  assert.equal((await restarted.wait(replay.id)).title, 'done-11');
  assert.equal(calls, 0);
});

test('failed archive persistence leaves completed records visible', async t => {
  const { filePath } = fixture();
  const queue = createTaskQueue({ filePath, process: async () => result('kept') });
  const task = queue.enqueue('https://mp.weixin.qq.com/s/archive-save-error'); await queue.wait(task.id);
  t.mock.method(fs, 'renameSync', () => { throw new Error('disk full'); });
  assert.throws(() => queue.archiveCompleted(), /disk full/);
  assert.equal(queue.list()[0].id, task.id);
  assert.equal(queue.list()[0].archivedAt, undefined);
});

test('updater maintenance gate refuses enqueue and retry before changing task state', async () => {
  const { filePath } = fixture();
  const queue = createTaskQueue({ filePath, process: async () => { throw new Error('model failed'); } });
  const task = queue.enqueue('https://mp.weixin.qq.com/s/update-lock'); await assert.rejects(queue.wait(task.id));
  setUpdatePending(true);
  try {
    assert.throws(() => queue.enqueue('https://mp.weixin.qq.com/s/blocked-new'), /正在准备更新/);
    assert.throws(() => queue.retry(task.id), /正在准备更新/);
    assert.equal(queue.list().length, 1);
    assert.equal(queue.list()[0].status, 'failed');
  } finally { setUpdatePending(false); }
});

test('same inbox generation and attempt replays a persisted failure after restart without analysis', async () => {
  const { filePath } = fixture(); let calls = 0;
  const process = async () => { calls++; throw new Error('invalid cards'); };
  const queue = createTaskQueue({ filePath, process });
  const context = { id: 'remote', generation: 'round-one', attempt: 1, maxAttempts: 3 };
  const task = queue.enqueue('https://mp.weixin.qq.com/s/crash-before-receipt', 'inbox', false, context);
  await assert.rejects(queue.wait(task.id));
  const restarted = createTaskQueue({ filePath, process });
  const replayed = restarted.enqueue(task.url, 'inbox', false, context);
  assert.equal(replayed.id, task.id);
  await assert.rejects(restarted.wait(replayed.id));
  assert.equal(calls, 1);
  const nextRound = restarted.enqueue(task.url, 'inbox', false, { ...context, generation: 'round-two' });
  assert.notEqual(nextRound.id, task.id);
  await assert.rejects(restarted.wait(nextRound.id));
  assert.equal(calls, 2);
});

test('failure report survives task persistence and wait rejection without exposing secrets', async () => {
  const { filePath } = fixture();
  const report: FailureReport = { version: 1, stage: 'card_validation', articleTitle: 'Article private-key', batch: 2,
    issues: [{ cardIndex: 4, cardTitle: 'Icon', field: 'payload.url', code: 'missing_value' }], issueCount: 1 };
  const queue = createTaskQueue({ filePath, process: async () => { throw new CollectionFailure(report); },
    sanitizeError: error => String(error).replaceAll('private-key', '[hidden]'), sanitizeReport: value => sanitizeFailureReport(value, ['private-key']) });
  const task = queue.enqueue('https://mp.weixin.qq.com/s/structured', 'inbox', false, { id: 'remote', attempt: 3, maxAttempts: 3 });
  await assert.rejects(queue.wait(task.id), error => {
    assert.ok(error instanceof CollectionFailure);
    assert.equal(error.failureReport.issues[0].cardIndex, 4);
    return true;
  });
  assert.doesNotMatch(fs.readFileSync(filePath, 'utf8'), /private-key/);
  const restarted = createTaskQueue({ filePath, process: async () => { throw new Error('must not run'); } });
  await assert.rejects(restarted.wait(task.id), error => {
    assert.ok(error instanceof CollectionFailure);
    assert.equal(error.failureReport.issues[0].field, 'payload.url');
    return true;
  });
  assert.equal(restarted.list()[0].inbox?.attempt, 3);
});

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
