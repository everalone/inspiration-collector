import assert from "node:assert/strict";
import { test } from "node:test";
import { createInboxClient } from "../core/inbox-client.js";
import { assertCollectionAvailable, isUpdatePending, setUpdatePending } from "../core/maintenance.js";

test("update gate stops new inbox pulls and releases after a failed install", async () => {
  let requests = 0;
  const client = createInboxClient({
    readConfig: () => ({ inboxUrl: "https://example.invalid", inboxToken: "test", inboxEnabled: true, inboxIntervalSec: 30 }),
    fetch: (async () => { requests++; return Response.json({ items: [] }); }) as typeof fetch,
    dataDir: "nonexistent-test-maintenance-dir",
  });
  try {
    setUpdatePending(true);
    assert.equal(isUpdatePending(), true);
    assert.throws(assertCollectionAvailable, /正在准备更新/);
    assert.deepEqual(await client.drain(), { ok: 0, fail: 0, titles: [], cards: 0 });
    assert.equal(requests, 0);
    setUpdatePending(false);
    assert.doesNotThrow(assertCollectionAvailable);
    await client.drain();
    assert.equal(requests, 1);
  } finally { setUpdatePending(false); }
});

test("in-flight pull is busy and stopping before collection does not report an analysis failure", async () => {
  let resolvePull!: (response: Response) => void;
  let analyses = 0;
  const client = createInboxClient({
    readConfig: () => ({ inboxUrl: "https://example.invalid", inboxToken: "test", inboxEnabled: true, inboxIntervalSec: 30 }),
    fetch: (() => new Promise<Response>(resolve => { resolvePull = resolve; })) as typeof fetch,
    collect: async () => { analyses++; throw new Error("must not process during update"); },
    dataDir: "nonexistent-test-maintenance-dir",
  });
  try {
    const pending = client.drain();
    assert.equal(client.isBusy(), true);
    setUpdatePending(true);
    resolvePull(Response.json({ items: [{ id: "test-id", url: "https://mp.weixin.qq.com/s/test" }] }));
    const result = await pending;
    assert.equal(result.fail, 0);
    assert.equal(analyses, 0);
    assert.equal(client.isBusy(), false);
  } finally { setUpdatePending(false); }
});
