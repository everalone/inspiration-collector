#!/usr/bin/env node
import { ingest, reprocess } from "./core/ingest.js";
import { listArticles, countItems } from "./core/store.js";
import { startServer } from "./core/server.js";
import { loadConfig, saveConfig } from "./core/config.js";

const [, , cmd, ...rest] = process.argv;

async function main() {
  switch (cmd) {
    case "ingest": {
      const urls = rest.filter((a) => !a.startsWith("--"));
      const offline = rest.includes("--offline");
      for (const u of urls) {
        console.log(`▶ ${u}`);
        try {
          const r = await ingest(u, { offline: offline && !u.startsWith("http") });
          console.log(`✔ ${r.title}（${r.account}）: ${Object.entries(r.counts).map(([k, v]) => `${k}=${v}`).join(" ") || "0 卡片"}${r.unsureCount ? `，${r.unsureCount} 待核对` : ""}`);
          for (const it of r.items) console.log(`   · [${it.type}] ${it.title} — ${it.detail}`);
        } catch (e) {
          console.error(`✘ ${(e as Error).message}`);
          process.exitCode = 1;
        }
      }
      break;
    }
    case "reprocess": {
      for (const id of rest) {
        try {
          const r = await reprocess(id);
          console.log(`✔ ${r.title}: ${JSON.stringify(r.counts)}`);
        } catch (e) {
          console.error(`✘ ${id}: ${(e as Error).message}`);
          process.exitCode = 1;
        }
      }
      break;
    }
    case "checkurls": {
      const { listItems, updateItem } = await import("./core/store.js");
      const { checkUrl } = await import("./core/verify.js");
      const rows = listItems({ limit: 100000 }).filter((r) => r.type === "website" || r.type === "repo");
      let dead = 0;
      for (const r of rows) {
        const url = JSON.parse(r.payload)?.url;
        if (!url) continue;
        const c = await checkUrl(url);
        if (!c.alive) dead++;
        updateItem(r.id, { verifyStatus: c.alive ? "ok" : "dead", verifyDetail: c });
        console.log(`  ${c.alive ? "●" : "✘"} [${r.type}] ${r.title} ${c.note || c.status || ""}`);
      }
      console.log(`共 ${rows.length} 个链接，失效 ${dead} 个`);
      break;
    }
    case "list": {
      const articles = listArticles();
      for (const a of articles) {
        console.log(`${a.status === "ok" ? "✔" : "✘"} ${a.id}  ${a.title}（${a.account}，${a.processed_at ? "已处理" : "未处理"}）`);
      }
      console.log(`共 ${articles.length} 篇文章，${countItems()} 张卡片`);
      break;
    }
    case "config": {
      // usage: config set apiKey=xxx model=deepseek-flash
      if (rest[0] === "set") {
        const patch: Record<string, unknown> = {};
        for (const kv of rest.slice(1)) {
          const [k, v] = kv.split("=");
          patch[k] = k === "seedTags" ? v.split(",") : (k === "serverPort" ? Number(v) : v);
        }
        const c = saveConfig(patch);
        console.log("已保存:", { ...c, apiKey: c.apiKey ? c.apiKey.slice(0, 6) + "…" : "" });
      } else {
        const c = loadConfig();
        console.log({ ...c, apiKey: c.apiKey ? c.apiKey.slice(0, 6) + "…" : "(未设置)" });
      }
      break;
    }
    case "serve": {
      const port = Number(rest.find((a) => a.startsWith("--port="))?.split("=")[1]) || loadConfig().serverPort;
      await startServer(port);
      break;
    }
    default:
      console.log(`用法:
  npm run ingest -- <url>... [--offline <本地html路径>]   收集文章（--offline 后跟本地保存的 html）
  node cli.ts reprocess <articleId>                       重跑提取
  node cli.ts list                                        列出已入库文章
  node cli.ts config [set k=v ...]                        查看/修改配置
  node cli.ts serve [--port=5178]                         启动卡片墙`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
