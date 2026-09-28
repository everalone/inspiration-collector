import test from 'node:test';
import assert from 'node:assert/strict';
import { createClipboardCollector } from '../src-electron/collection-controller.mjs';

test('a second copied URL is retained while the first submission is outstanding', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const urls = [];
  const controller = createClipboardCollector({ submit: async url => { urls.push(url); await gate; } });
  const first = controller.accept('https://mp.weixin.qq.com/s/first');
  controller.accept('https://mp.weixin.qq.com/s/second');
  controller.accept('https://mp.weixin.qq.com/s/second');
  release(); await first;
  assert.deepEqual(urls, ['https://mp.weixin.qq.com/s/first', 'https://mp.weixin.qq.com/s/second']);
});

test('failed submission stays pending and is retried even if clipboard no longer changes', async () => {
  let calls = 0, errors = 0;
  const controller = createClipboardCollector({ submit: async () => { if (++calls === 1) throw new Error('offline'); }, onError: () => errors++ });
  await controller.accept('https://mp.weixin.qq.com/s/keep');
  assert.equal(controller.pendingCount(), 1);
  await controller.accept('https://mp.weixin.qq.com/s/keep');
  assert.equal(calls, 2); assert.equal(errors, 1); assert.equal(controller.pendingCount(), 0);
});

test('disabled collection and ordinary clipboard text do not submit anything', async () => {
  let calls = 0;
  const controller = createClipboardCollector({ submit: async () => { calls++; } });
  await controller.accept('https://mp.weixin.qq.com/s/ignored', false);
  await controller.accept('a normal paragraph');
  assert.equal(calls, 0);
});
