import test from "node:test";
import assert from "node:assert/strict";
import { CollectionFailure, sanitizeFailureReport, formatFailureReport, type FailureReport } from "../core/failure-report.js";

const report: FailureReport = { version: 1, stage: "card_validation", articleTitle: "文章", batch: 2, imageStart: 9, imageEnd: 15,
  issues: [{ cardIndex: 3, cardTitle: "图标库", cardType: "website", field: "payload.url", code: "invalid_url" }], issueCount: 1 };

test("diagnostic metadata identifies batch, card and field without retaining arbitrary raw output", () => {
  const safe = sanitizeFailureReport({ ...report, raw: "PRIVATE RESPONSE", apiKey: "SECRET", issues: [{ ...report.issues[0], cardTitle: "SECRET\n图标库", raw: "PRIVATE" }] }, ["SECRET"])!;
  assert.equal(safe.issues[0].cardTitle, "[已隐藏] 图标库");
  assert.doesNotMatch(JSON.stringify(safe), /SECRET|PRIVATE/);
  assert.match(formatFailureReport(safe), /第2批/);
  assert.match(formatFailureReport(safe), /第3张卡.*payload.url/);
  assert.match(new CollectionFailure(safe).message, /无效卡片/);
});

test("invalid or excessive diagnostics are bounded and unknown field/code payloads are rejected", () => {
  assert.equal(sanitizeFailureReport({ ...report, issues: [{ ...report.issues[0], field: "<script>" }] }), undefined);
  assert.equal(sanitizeFailureReport({ ...report, issues: [{ ...report.issues[0], code: "raw secret response" }] }), undefined);
  const safe = sanitizeFailureReport({ ...report, articleTitle: "🎨".repeat(300), issues: Array.from({ length: 15 }, () => report.issues[0]), issueCount: 15 })!;
  assert.equal(Array.from(safe.articleTitle!).length, 200);
  assert.equal(safe.issues.length, 10);
  assert.match(formatFailureReport(safe), /另有5项/);
});
