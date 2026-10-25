import test, { after, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "inspiration-extract-test-"));
process.env.INSPIRATION_DATA_DIR = temp;
fs.mkdirSync(path.join(temp, "data"));
fs.writeFileSync(path.join(temp, "data/config.json"), JSON.stringify({ apiKey: "test-only", baseUrl: "https://model.invalid", model: "test" }));
const { extractBatch, extractCards } = await import("../core/extract.js");
const meta = { title: "离线测试文章", account: "test", publishDate: "", description: "", text: "正文证据".repeat(20), url: "https://mp.weixin.qq.com/s/test-only" };
let output: unknown;
let finishReason = "stop";
let requestBodies: any[] = [];
let responses: unknown[] = [];
mock.method(globalThis, "fetch", async (input: unknown, init: RequestInit) => {
  assert.equal(String(input), "https://model.invalid/chat/completions", "test must not access real network");
  requestBodies.push(JSON.parse(String(init.body)));
  const response = responses.length ? responses.shift() : output;
  return Response.json({ choices: [{ finish_reason: finishReason, message: { content: typeof response === "string" ? response : JSON.stringify(response) } }] });
});
after(() => {
  mock.restoreAll();
  assert.ok(temp.startsWith(path.join(os.tmpdir(), "inspiration-extract-test-")));
  fs.rmSync(temp, { recursive: true, force: true });
});
function setItems(items: unknown[]) {
  output = { article_type: "note", items };
  finishReason = "stop";
  responses = [];
  requestBodies = [];
}
async function rejectsWithReport(items: unknown[], field: string, code: string) {
  setItems(items);
  await assert.rejects(extractBatch(meta, [], 0), (error: any) => {
    assert.match(error.message, /无效卡片/);
    assert.equal(error.failureReport.stage, "card_validation");
    assert.equal(error.failureReport.articleTitle, meta.title);
    assert.ok(error.failureReport.issues.some((issue: any) => issue.field === field && issue.code === code));
    return true;
  });
  assert.equal(requestBodies.length, 1, "validation does not retry the model");
}

test("equivalent palette and top-level payload fields preserve source content", async () => {
  setItems([
    { type: "palette", title: "legacy", colors: [{ hex: "#abc", name: "原名" }], desc: "原说明" },
    { type: "palette", title: "canonical", payload: { colors: ["#def", "112233"], desc: "新说明" } },
    { type: "website", title: "site", url: "HTTPS://example.invalid/path", desc: "原文" },
    { type: "prompt", title: "prompt", text: "完整提示词" },
    { type: "note", title: "note", sections: [{ heading: "原标题", bullets: ["原要点"] }] },
  ]);
  const result = await extractBatch(meta, [], 0);
  assert.equal(result.items.length, 5);
  assert.deepEqual(result.items[0].payload, { colors: [{ hex: "#AABBCC", name: "原名" }], desc: "原说明" });
  assert.deepEqual(result.items[1].payload?.colors, [{ hex: "#DDEEFF" }, { hex: "#112233" }]);
  assert.equal(result.items[2].payload?.url, "HTTPS://example.invalid/path");
  assert.equal(result.items[3].payload?.text, "完整提示词");
  assert.deepEqual(result.items[4].payload?.sections, [{ heading: "原标题", bullets: ["原要点"] }]);
  assert.equal(requestBodies[0].temperature, 0);
});

test("source URLs without a protocol become notes without inventing a URL", async () => {
  setItems([{ type: "website", title: "原站名", payload: { url: "example.com/path?a=1", desc: "原站说明" } }]);
  const result = await extractBatch(meta, [], 0);
  assert.equal(result.items[0].type, "note");
  assert.equal(result.items[0].payload?.url, undefined);
  assert.deepEqual(result.items[0].payload?.sections, [{ heading: "原文链接", bullets: ["example.com/path?a=1", "原站说明"] }]);
});

test("one invalid card rejects the batch with its position and safe identifying fields", async () => {
  setItems([{ type: "prompt", title: "valid", payload: { text: "ready" } }, { type: "unknown", title: "问题卡" }]);
  await assert.rejects(extractBatch(meta, [], 0), (error: any) => {
    assert.match(error.message, /无效卡片/);
    assert.equal(error.failureReport.issueCount, 1);
    assert.deepEqual(error.failureReport.issues[0], { cardIndex: 2, cardTitle: "问题卡", cardType: undefined, field: "type", code: "invalid_type" });
    return true;
  });
});

test("empty values and invalid shapes identify the offending payload field", async () => {
  await rejectsWithReport([{ type: "prompt", payload: { text: "   " } }], "payload.text", "missing_value");
  await rejectsWithReport([{ type: "note", payload: { sections: [] } }], "payload.sections", "missing_value");
  await rejectsWithReport([{ type: "note", payload: { sections: ["wrong shape"] } }], "payload.sections[0]", "invalid_shape");
  await rejectsWithReport([null], "item", "invalid_shape");
});

test("partly invalid color lists reject the batch instead of silently removing colors", async () => {
  await rejectsWithReport([{ type: "palette", payload: { colors: ["#123", "red"] } }], "payload.colors[1].hex", "invalid_color");
  await rejectsWithReport([{ type: "palette", colors: [{ hex: "#123" }, { hex: "red" }] }], "payload.colors[1].hex", "invalid_color");
});

test("unsafe or malformed URLs fail without being repaired or downgraded", async () => {
  for (const url of ["javascript:alert(1)", "data:text/plain,hello", "ftp://example.invalid", "https:example.invalid", "https:///example.invalid", "https://", "https://example.invalid/a b"]) {
    await rejectsWithReport([{ type: "website", payload: { url } }], "payload.url", "invalid_url");
  }
});

test("invalid optional coordinates remain tolerant and empty extraction is deliberate", async () => {
  setItems([{ type: "prompt", payload: { text: "valid" }, bbox: [-1, 0, 10, 10], source_image_index: 999 }]);
  const result = await extractBatch(meta, [], 0);
  assert.equal(result.items[0].bbox, undefined);
  assert.equal(result.items[0].title, "未命名");
  setItems([]);
  assert.deepEqual((await extractBatch(meta, [], 0)).items, []);
});

test("object coordinates cannot throw during numeric conversion or lose the collection report", async () => {
  setItems([{ type: "prompt", payload: { text: "valid" },
    source_image_index: { toString: "not callable" }, bbox: [{ toString: "not callable" }, 0, 10, 10] }]);
  const result = await extractBatch(meta, [], 0);
  assert.equal(result.items[0].source_image_index, 0);
  assert.equal(result.items[0].bbox, undefined);
});

test("summary and tags reject non-string values instead of manufacturing object text", async () => {
  for (const fixture of [
    { metadata: { article_summary: {} }, field: "article_summary" },
    { metadata: { article_summary: { toString: "not callable" } }, field: "article_summary" },
    { metadata: { tags: "not an array" }, field: "tags" },
    { metadata: { tags: ["valid", null, {}] }, field: "tags[1]" },
  ]) {
    setItems([]); output = { items: [], ...fixture.metadata };
    await assert.rejects(extractBatch(meta, [], 0), (error: any) => {
      assert.equal(error.failureReport.stage, "model_response");
      assert.ok(error.failureReport.issues.some((issue: any) => issue.field === fixture.field && issue.code === "invalid_shape"));
      return true;
    });
  }
});

test("invalid JSON, missing items and truncation yield structured response errors without echoing raw content", async () => {
  for (const fixture of [
    { output: "sensitive raw response", finish: "stop", code: "invalid_json" },
    { output: { article_type: "note" }, finish: "stop", code: "invalid_shape" },
    { output: "sensitive partial response", finish: "length", code: "truncated" },
  ]) {
    setItems([]); output = fixture.output; finishReason = fixture.finish;
    await assert.rejects(extractBatch(meta, [], 0), (error: any) => {
      assert.equal(error.failureReport.stage, "model_response");
      assert.equal(error.failureReport.issues[0].cardIndex, 0);
      assert.equal(error.failureReport.issues[0].code, fixture.code);
      assert.equal(error.message.includes("sensitive"), false);
      assert.equal(JSON.stringify(error.failureReport).includes("sensitive"), false);
      return true;
    });
  }
});

test("failure reports identify the batch and one-based image range", async () => {
  setItems([]);
  responses = [{ items: [] }, { items: [{ type: "prompt", title: "第二批", payload: { text: "" } }] }];
  const image = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).png().toBuffer();
  await assert.rejects(extractCards(meta, Array(9).fill(image)), (error: any) => {
    assert.equal(error.failureReport.batch, 2);
    assert.equal(error.failureReport.imageStart, 9);
    assert.equal(error.failureReport.imageEnd, 9);
    return true;
  });
  assert.equal(requestBodies.length, 2, "validation must not trigger another model call");
});
