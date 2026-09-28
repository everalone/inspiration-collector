import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "inspiration-store-test-"));
process.env.INSPIRATION_DATA_DIR = temp;
const store = await import("../core/store.js");
after(() => {
  store.getDb().close();
  assert.ok(temp.startsWith(path.join(os.tmpdir(), "inspiration-store-test-")));
  fs.rmSync(temp, { recursive: true, force: true });
});
test("failed article deletion preserves its cards in the same transaction", () => {
  store.upsertArticle({ id: "delete-fail", url: "https://example.invalid", title: "old", account: "", publishDate: "", description: "" });
  store.replaceItems("delete-fail", [{ type: "prompt", title: "keep", payload: { text: "old" } }], new Map());
  store.getDb().exec("CREATE TRIGGER fail_article_delete BEFORE DELETE ON articles BEGIN SELECT RAISE(ABORT, 'cannot delete'); END");
  assert.throws(() => store.deleteArticle("delete-fail"), /cannot delete/);
  assert.equal(store.listItems().length, 1);
  assert.ok(store.getArticle("delete-fail"));
});
