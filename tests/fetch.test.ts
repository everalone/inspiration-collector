import test, { after, afterEach, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fetchHtml, downloadImage } from "../core/fetch.js";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "inspiration-fetch-test-"));
process.env.INSPIRATION_DATA_DIR = temp;
type Timer = { callback: () => void; cleared: boolean; fired: boolean };
let timers: Timer[];
let calls: number;
let bodyReads: number;
let signals: AbortSignal[];

beforeEach(() => {
  timers = []; calls = 0; bodyReads = 0; signals = [];
  mock.method(globalThis, "setTimeout", (callback: () => void) => {
    const timer = { callback, cleared: false, fired: false };
    timers.push(timer);
    return timer;
  });
  mock.method(globalThis, "clearTimeout", (timer: Timer) => { if (timer) timer.cleared = true; });
});
afterEach(() => mock.restoreAll());
after(() => {
  assert.ok(temp.startsWith(path.join(os.tmpdir(), "inspiration-fetch-test-")));
  fs.rmSync(temp, { recursive: true, force: true });
});

function stalledResponse(signal: AbortSignal, bodyType: "text" | "arrayBuffer") {
  return {
    ok: true,
    status: 200,
    [bodyType]: () => {
      bodyReads++;
      return new Promise((_resolve, reject) => {
        const abort = () => reject(new DOMException("Body read aborted", "AbortError"));
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      });
    },
  } as unknown as Response;
}

async function driveTimers<T>(promise: Promise<T>) {
  let outcome: { status: "fulfilled"; value: T } | { status: "rejected"; error: Error } | undefined;
  void promise.then(value => { outcome = { status: "fulfilled", value }; }, error => { outcome = { status: "rejected", error }; });
  for (let turn = 0; turn < 60 && !outcome; turn++) {
    // Let headers resolve and body reading start before advancing the virtual clock.
    for (let microtask = 0; microtask < 8; microtask++) await Promise.resolve();
    for (const timer of [...timers]) {
      if (!timer.cleared && !timer.fired) { timer.fired = true; timer.callback(); }
    }
  }
  assert.ok(outcome, "response body remained pending after every timeout/retry deadline");
  return outcome;
}

test("HTML timeout covers a stalled body and exhausts the three attempts", async () => {
  mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
    calls++;
    const signal = options.signal as AbortSignal;
    signals.push(signal);
    return stalledResponse(signal, "text");
  });
  const outcome = await driveTimers(fetchHtml("https://article.invalid/"));
  assert.equal(outcome.status, "rejected");
  if (outcome.status === "rejected") assert.match(outcome.error.message, /重试3次/);
  assert.equal(calls, 3);
  assert.equal(bodyReads, 3);
  assert.ok(signals.every(signal => signal.aborted));
});

test("image timeout aborts a stalled body without writing an incomplete file", async () => {
  mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
    calls++;
    const signal = options.signal as AbortSignal;
    signals.push(signal);
    return stalledResponse(signal, "arrayBuffer");
  });
  const destination = path.join(temp, "never-written.png");
  const outcome = await driveTimers(downloadImage("https://image.invalid/", destination));
  assert.equal(outcome.status, "rejected");
  if (outcome.status === "rejected") assert.equal(outcome.error.name, "AbortError");
  assert.equal(calls, 1);
  assert.equal(bodyReads, 1);
  assert.ok(signals[0].aborted);
  assert.equal(fs.existsSync(destination), false);
});

test("a timed-out HTML body retries successfully and cancels the successful deadline", async () => {
  mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
    calls++;
    const signal = options.signal as AbortSignal;
    signals.push(signal);
    return calls === 1 ? stalledResponse(signal, "text") : { ok: true, status: 200, text: async () => "complete body" } as Response;
  });
  const outcome = await driveTimers(fetchHtml("https://article.invalid/"));
  assert.equal(outcome.status, "fulfilled");
  if (outcome.status === "fulfilled") assert.equal(outcome.value, "complete body");
  assert.equal(calls, 2);
  assert.equal(signals[1].aborted, false);
});
