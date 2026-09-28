import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createInboxClient } from "../core/inbox-client.js";
import type { IngestResult } from "../core/ingest.js";

const item = { id: "pending-article", url: "https://mp.weixin.qq.com/s/inbox-client-regression", received_at: "2026-01-01T00:00:00.000Z" };
const readConfig = () => ({ inboxUrl: "http://127.0.0.1:8787", inboxToken: "test-only", inboxEnabled: true, inboxIntervalSec: 30 });
const collected = { title: "Test article", counts: { note: 2 } } as IngestResult;

test("ACK network failure is not an analysis failure and restart retries only ACK", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "inbox-client-test-"));
  let analyses = 0;
  let networkDown = true;
  let done = false;
  const acknowledgements: any[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    if (String(input).includes("/pull")) return Response.json({ items: done ? [] : [item] });
    const ack = JSON.parse(String(init?.body));
    acknowledgements.push(ack);
    if (networkDown) throw new Error("simulated network outage");
    done = true;
    return Response.json({ ok: true });
  };
  const options = { dataDir, readConfig, fetch: fakeFetch, collect: async () => { analyses++; return collected; } };
  try {
    const firstClient = createInboxClient(options);
    const result = await firstClient.drain();
    assert.equal(result.ok, 1);
    assert.equal(result.fail, 0);
    assert.equal(firstClient.status().pendingAckCount, 1);
    assert.equal((await fs.readFile(path.join(dataDir, "inbox-receipts.json"), "utf8")).includes("test-only"), false, "pending receipts must not persist the inbox token");
    assert.equal(acknowledgements.some((ack) => ack.ok === false), false);
    networkDown = false;
    const restartedClient = createInboxClient({ ...options, now: () => Date.now() + 60_000 });
    await restartedClient.drain();
    assert.equal(analyses, 1, "a persisted successful result must never be sent to the paid model again");
    assert.equal(restartedClient.status().pendingAckCount, 0);
    assert.equal(done, true);
  } finally { await fs.rm(dataDir, { recursive: true, force: true }); }
});

test("legacy server ACK 404 clears a persisted receipt without repeating analysis", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "inbox-legacy-test-"));
  let processed = 0;
  let serverDone = false;
  const fakeFetch: typeof fetch = async (input) => {
    if (String(input).includes("/pull")) return Response.json({ items: serverDone ? [] : [item] });
    if (String(input).endsWith("/failed")) return Response.json({ error: "unknown" }, { status: 404 });
    if (!serverDone) { serverDone = true; throw new Error("ACK accepted but response lost"); }
    return Response.json({ error: "not found" }, { status: 404 });
  };
  const options = { dataDir, readConfig, fetch: fakeFetch, collect: async () => { processed++; return collected; } };
  try {
    await createInboxClient(options).drain();
    const restarted = createInboxClient({ ...options, now: () => Date.now() + 60_000 });
    await restarted.drain();
    assert.equal(processed, 1);
    assert.equal(restarted.status().pendingAckCount, 0);
    assert.deepEqual(await restarted.failures(), { items: [], supported: false });
  } finally { await fs.rm(dataDir, { recursive: true, force: true }); }
});

test("corrupted acknowledgement state stops processing instead of silently losing the deduplication record", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "inbox-corrupt-test-"));
  let processed = 0;
  try {
    await fs.writeFile(path.join(dataDir, "inbox-receipts.json"), "broken-json", "utf8");
    const client = createInboxClient({ dataDir, readConfig, collect: async () => { processed++; return collected; } });
    await assert.rejects(client.drain(), /回执文件损坏/);
    assert.equal(processed, 0);
    assert.equal(client.status().connection, "error");
    assert.equal(await fs.readFile(path.join(dataDir, "inbox-receipts.json"), "utf8"), "broken-json");
  } finally { await fs.rm(dataDir, { recursive: true, force: true }); }
});

test("inbox request timeout covers the response body and releases the drain lock", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "inbox-timeout-test-"));
  let stall = true;
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write('{"items":');
    if (stall) setTimeout(() => res.end("[]}"), 150);
    else res.end("[]}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const inboxUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = createInboxClient({ dataDir, timeoutMs: 30, readConfig: () => ({ ...readConfig(), inboxUrl }), collect: async () => collected });
  try {
    await assert.rejects(client.drain(), /超时/);
    assert.equal(client.status().connection, "error");
    stall = false;
    assert.equal((await client.drain()).ok, 0);
    assert.equal(client.status().connection, "connected");
    assert.equal(client.status().lastError, null);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("server errors redact configured secrets before throwing or exposing inbox status", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "inbox-redaction-test-"));
  const cfg = { ...readConfig(), inboxToken: "private-inbox-value", apiKey: "private-model-value" };
  try {
    const client = createInboxClient({ dataDir, readConfig: () => cfg,
      fetch: async () => Response.json({ error: `unstructured reply ${cfg.inboxToken} and ${cfg.apiKey}` }, { status: 500 }),
      collect: async () => collected });
    await assert.rejects(client.drain(), (error: Error) => {
      assert.equal(error.message.includes(cfg.inboxToken), false);
      assert.equal(error.message.includes(cfg.apiKey), false);
      return true;
    });
    assert.equal(JSON.stringify(client.status()).includes(cfg.inboxToken), false);
    assert.equal(JSON.stringify(client.status()).includes(cfg.apiKey), false);
  } finally { await fs.rm(dataDir, { recursive: true, force: true }); }
});

test("failure list and outgoing failure receipts apply redaction without reading real configuration", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "inbox-redaction-failed-test-"));
  const cfg = { ...readConfig(), inboxToken: "private-inbox-value", apiKey: "private-model-value" };
  const rawError = `failure ${cfg.inboxToken} / ${cfg.apiKey} / custom-sensitive-value`;
  let outgoing: any;
  try {
    const client = createInboxClient({ dataDir, readConfig: () => cfg,
      sanitizeError: (error: unknown) => String(error instanceof Error ? error.message : error).replaceAll("custom-sensitive-value", "[已隐藏]"),
      fetch: async (input, init) => {
        if (String(input).includes("/failed")) return Response.json({ items: [{ ...item, attempts: 3, error: rawError }] });
        if (String(input).includes("/pull")) return Response.json({ items: [item] });
        outgoing = JSON.parse(String(init?.body));
        return Response.json({ ok: true });
      }, collect: async () => { throw new Error(rawError); } });
    const failed = await client.failures();
    assert.equal(failed.items[0].error?.includes(cfg.inboxToken), false);
    assert.equal(failed.items[0].error?.includes(cfg.apiKey), false);
    assert.equal(failed.items[0].error?.includes("custom-sensitive-value"), false);
    assert.equal((await client.drain()).fail, 1);
    assert.equal(outgoing.error.includes(cfg.inboxToken), false);
    assert.equal(outgoing.error.includes(cfg.apiKey), false);
    assert.equal(outgoing.error.includes("custom-sensitive-value"), false);
  } finally { await fs.rm(dataDir, { recursive: true, force: true }); }
});
