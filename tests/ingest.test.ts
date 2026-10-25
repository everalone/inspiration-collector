import test, { after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "inspiration-ingest-test-"));
process.env.INSPIRATION_DATA_DIR = temp;
fs.mkdirSync(path.join(temp, "data"));
fs.writeFileSync(path.join(temp, "data/config.json"), JSON.stringify({ apiKey: "test-only", baseUrl: "https://model.invalid", model: "test" }));
const { ingest } = await import("../core/ingest.js");
const store = await import("../core/store.js");
const { ASSETS_DIR } = await import("../core/config.js");
const image = await sharp({ create: { width: 80, height: 80, channels: 3, background: "red" } }).png().toBuffer();
let html = "", model: unknown, imageFailure = false;
let requests: string[] = [];
mock.method(globalThis, "fetch", async (input: any) => {
  const url = String(input);
  requests.push(url);
  if (url.startsWith("https://mp.weixin.qq.com/")) return new Response(html);
  if (url.startsWith("https://mmbiz.qpic.cn/")) return imageFailure ? new Response("failed", { status: 404 }) : new Response(image);
  if (url === "https://model.invalid/chat/completions") return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(model) } }] }));
  if (url === "https://dead.invalid/") return new Response("gone", { status: 404 });
  throw new Error(`Unexpected network access: ${url}`);
});
function page(id: string, withImage = true) {
  return `<h1 id="activity-name">new ${id}</h1><div id="js_content">${"正文证据".repeat(20)}${withImage ? '<img data-src="https://mmbiz.qpic.cn/new?wx_fmt=png">' : ""}</div>`;
}
function seed(id: string) {
  store.upsertArticle({ id, url: `https://mp.weixin.qq.com/s/${id}`, title: "old title", account: "old", publishDate: "", description: "", imagesDir: id, processed: true });
  store.replaceItems(id, [{ type: "prompt", title: "hand edited", payload: { text: "keep me" } }], new Map());
  fs.mkdirSync(path.join(ASSETS_DIR, id), { recursive: true });
  fs.writeFileSync(path.join(ASSETS_DIR, id, "img-0.png"), image);
}
beforeEach(() => {
  requests = [];
  imageFailure = false;
  model = { article_type: "website", article_summary: "new", tags: [], items: [{ type: "website", title: "dead", payload: { url: "https://dead.invalid/" }, source_image_index: 0 }] };
});
after(() => {
  store.getDb().close();
  mock.restoreAll();
  assert.ok(temp.startsWith(path.join(os.tmpdir(), "inspiration-ingest-test-")));
  fs.rmSync(temp, { recursive: true, force: true });
});

test("ordinary ingest skips an existing article without network calls or edited-card replacement", async () => {
  seed("skip-existing");
  html = page("skip-existing");
  const result = await ingest("https://mp.weixin.qq.com/s/skip-existing");
  assert.equal(result.skipped, true);
  assert.equal(result.title, "old title", "the inbox completion receipt must identify articles already in the library");
  assert.deepEqual(requests, []);
  assert.equal(store.getArticle("skip-existing")?.title, "old title");
});

test("refresh downloads current images and stores a dead-link status", async () => {
  seed("refresh-images");
  html = page("refresh-images");
  await ingest("https://mp.weixin.qq.com/s/refresh-images", { refresh: true });
  assert.ok(requests.some((url) => url.startsWith("https://mmbiz.qpic.cn/")));
  const row = store.listItems().find((r) => r.article_id === "refresh-images");
  assert.equal(row?.verify_status, "dead");
});

test("failed image download preserves previous article, cards, and image directory", async () => {
  seed("missing-image");
  html = page("missing-image").replace("wx_fmt=png", "wx_fmt=jpg");
  imageFailure = true;
  await assert.rejects(ingest("https://mp.weixin.qq.com/s/missing-image", { refresh: true }), /图片/);
  assert.equal(store.getArticle("missing-image")?.title, "old title");
  assert.equal(store.listItems().find((r) => r.article_id === "missing-image")?.title, "hand edited");
  assert.ok(fs.existsSync(path.join(ASSETS_DIR, "missing-image/img-0.png")));
});

test("missing items is invalid model output and cannot clear saved cards", async () => {
  seed("invalid-result");
  html = page("invalid-result", false);
  model = { article_type: "note", article_summary: "broken" };
  await assert.rejects(ingest("https://mp.weixin.qq.com/s/invalid-result", { refresh: true }), /items/);
  assert.equal(store.getArticle("invalid-result")?.title, "old title");
  assert.equal(store.listItems().find((r) => r.article_id === "invalid-result")?.title, "hand edited");
});

test("card insertion failure rolls back article metadata together with cards", async () => {
  seed("transaction-failure");
  html = page("transaction-failure", false);
  store.getDb().exec("CREATE TRIGGER fail_replacement BEFORE INSERT ON items WHEN NEW.article_id = 'transaction-failure' BEGIN SELECT RAISE(ABORT, 'forced failure'); END");
  try {
    await assert.rejects(ingest("https://mp.weixin.qq.com/s/transaction-failure", { refresh: true }), /forced failure/);
    assert.equal(store.getArticle("transaction-failure")?.title, "old title");
    assert.equal(store.listItems().find((r) => r.article_id === "transaction-failure")?.title, "hand edited");
  } finally { store.getDb().exec("DROP TRIGGER fail_replacement"); }
});

test("explicit empty items remains a valid deliberate whole-article replacement", async () => {
  seed("empty-valid");
  html = page("empty-valid", false);
  model = { article_type: "note", article_summary: "nothing to collect", tags: [], items: [] };
  const result = await ingest("https://mp.weixin.qq.com/s/empty-valid", { refresh: true });
  assert.deepEqual(result.items, []);
  assert.equal(store.listItems({ articleId: "empty-valid" }).length, 0);
  assert.equal(store.getArticle("empty-valid")?.title, "new empty-valid");
});

test("concurrent ordinary submissions perform one extraction and then skip", async () => {
  html = page("concurrent", false);
  const results = await Promise.all([ingest("https://mp.weixin.qq.com/s/concurrent"), ingest("https://mp.weixin.qq.com/s/concurrent")]);
  assert.equal(requests.filter((url) => url.includes("/chat/completions")).length, 1);
  assert.equal(results.filter((r) => r.skipped).length, 1);
});

test("failed incomplete model output releases the article lock and preserves the previous images", async () => {
  seed("retry-result");
  const dirsBefore = fs.readdirSync(ASSETS_DIR).sort();
  html = page("retry-result");
  model = { items: [{ type: "unknown" }] };
  await assert.rejects(ingest("https://mp.weixin.qq.com/s/retry-result", { refresh: true }), /无效卡片/);
  assert.deepEqual(fs.readdirSync(ASSETS_DIR).sort(), dirsBefore);
  assert.equal(store.getArticle("retry-result")?.images_dir, "retry-result");
  model = { article_type: "prompt", items: [{ type: "prompt", title: "valid", payload: { text: "ready" } }] };
  await ingest("https://mp.weixin.qq.com/s/retry-result", { refresh: true });
  assert.equal(store.listItems({ articleId: "retry-result" })[0]?.title, "valid");
  assert.notEqual(store.getArticle("retry-result")?.images_dir, "retry-result");
});

test("mixed valid and malformed cards reject the whole refresh and preserve the saved article", async () => {
  seed("mixed-invalid");
  const dirsBefore = fs.readdirSync(ASSETS_DIR).sort();
  html = page("mixed-invalid");
  model = { article_type: "palette", items: [
    { type: "prompt", title: "valid candidate", payload: { text: "must not replace saved cards" } },
    { type: "palette", title: "incomplete palette", colors: [{ hex: "#123" }, { hex: "red" }] },
  ] };
  await assert.rejects(ingest("https://mp.weixin.qq.com/s/mixed-invalid", { refresh: true }), (error: any) => {
    assert.equal(error.failureReport.stage, "card_validation");
    assert.equal(error.failureReport.issues[0].cardIndex, 2);
    assert.equal(error.failureReport.issues[0].field, "payload.colors[1].hex");
    return true;
  });
  assert.equal(store.getArticle("mixed-invalid")?.title, "old title");
  assert.equal(store.getArticle("mixed-invalid")?.images_dir, "mixed-invalid");
  assert.equal(store.listItems({ articleId: "mixed-invalid" })[0]?.title, "hand edited");
  assert.deepEqual(fs.readdirSync(ASSETS_DIR).sort(), dirsBefore);
  assert.equal(requests.filter(url => url.includes("/chat/completions")).length, 1);
});
