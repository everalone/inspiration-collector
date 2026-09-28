// Optional manual UI check: npm run build:core && node scripts/smoke-server.mjs
// Uses an isolated temporary library and mocked article/model responses only.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "inspiration-ui-smoke-"));
process.env.INSPIRATION_DATA_DIR = temp;
fs.mkdirSync(path.join(temp, "data"));
fs.writeFileSync(path.join(temp, "data/config.json"), JSON.stringify({ apiKey: "smoke-placeholder", baseUrl: "https://model.invalid/v1", model: "smoke", inboxEnabled: false, inboxUrl: "", inboxToken: "" }));
const imageDir = path.join(temp, "assets/gallery");
fs.mkdirSync(imageDir, { recursive: true });
for (let i = 0; i < 11; i++) {
  await sharp({ create: { width: 600, height: 300, channels: 3, background: { r: 35 + i * 15, g: 100, b: 170 } } }).png().toFile(path.join(imageDir, `img-${i}.png`));
}
globalThis.fetch = async (input) => {
  const url = String(input);
  if (url === "https://mp.weixin.qq.com/s/qa-success") return new Response(`<h1 id="activity-name">界面验收：新文章</h1><div id="js_name">测试公众号</div><div id="js_content">${"这是一段本地模拟的文章内容，用于验证任务、提取和卡片展示。".repeat(8)}</div>`);
  if (url === "https://mp.weixin.qq.com/s/qa-failure") return new Response("环境异常");
  if (url === "https://model.invalid/v1/chat/completions") return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ article_type: "note", article_summary: "模拟提取验收", tags: [], items: [{ type: "note", title: "后台收集验收通过", payload: { sections: [{ heading: "结果", bullets: ["任务完成后自动刷新卡片。"] }] } }] }) } }] });
  throw new Error(`Smoke test blocks external request: ${url}`);
};
const store = await import("../dist/core/store.js");
store.upsertArticle({ id: "gallery", url: "https://mp.weixin.qq.com/s/gallery", title: "603 张卡片与 11 张图片验收", account: "测试公众号", publishDate: "", description: "临时测试数据", articleType: "note", imagesDir: "gallery", processed: true });
store.replaceItems("gallery", Array.from({ length: 603 }, (_, i) => ({ type: "note", title: `测试卡片 ${String(i + 1).padStart(3, "0")}`, source_image_index: i % 11, payload: { sections: [{ heading: "测试笔记", bullets: [`第 ${i + 1} 张卡片`] }] } })), new Map());
const { startServer } = await import("../dist/core/server.js");
const server = await startServer(Number(process.env.INSPIRATION_PORT) || 5198);
console.log(`Isolated UI fixture: ${temp}`);
function close() {
  server.closeAllConnections();
  server.close(() => {
    store.getDb().close();
    if (!temp.startsWith(path.join(os.tmpdir(), "inspiration-ui-smoke-"))) throw new Error("Unexpected cleanup target");
    fs.rmSync(temp, { recursive: true, force: true });
    process.exit();
  });
}
process.once("SIGINT", close);
process.once("SIGTERM", close);
