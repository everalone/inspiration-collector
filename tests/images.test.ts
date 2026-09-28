import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "inspiration-images-test-"));
process.env.INSPIRATION_DATA_DIR = temp;
after(() => {
  assert.ok(temp.startsWith(path.join(os.tmpdir(), "inspiration-images-test-")));
  fs.rmSync(temp, { recursive: true, force: true });
});
test("legacy galleries use numeric image order and ignore other files", async () => {
  const { getArticleImageFiles } = await import("../core/article-images.js");
  const dir = path.join(temp, "assets/legacy");
  fs.mkdirSync(dir, { recursive: true });
  for (let n = 0; n < 12; n++) fs.writeFileSync(path.join(dir, `img-${n}.png`), "test");
  fs.writeFileSync(path.join(dir, "notes.txt"), "not an image");
  assert.deepEqual(getArticleImageFiles("assets\\legacy"), Array.from({ length: 12 }, (_, n) => `img-${n}.png`));
});
test("manifest controls display order and rejects escaping filenames", async () => {
  const { getArticleImageFiles } = await import("../core/article-images.js");
  const dir = path.join(temp, "assets/manifest");
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ["second.png", "first.png", "orphan.png"]) fs.writeFileSync(path.join(dir, name), "test");
  fs.writeFileSync(path.join(dir, "images.json"), JSON.stringify({ version: 1, images: [{ file: "second.png", url: "https://example.invalid/b" }, { file: "first.png", url: "https://example.invalid/a" }] }));
  assert.deepEqual(getArticleImageFiles("manifest"), ["second.png", "first.png"]);
  fs.writeFileSync(path.join(dir, "images.json"), JSON.stringify({ version: 1, images: [{ file: "../escape.png", url: "https://example.invalid" }] }));
  assert.throws(() => getArticleImageFiles("manifest"), /清单/);
  assert.throws(() => getArticleImageFiles("../outside"), /目录/);
});
