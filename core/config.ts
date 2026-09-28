import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = path.basename(MODULE_ROOT) === "dist" ? path.dirname(MODULE_ROOT) : MODULE_ROOT;
export const ROOT_DIR = ROOT;
// 打包运行时由 Electron 设置 INSPIRATION_DATA_DIR 指向用户数据目录；开发态用项目根
const BASE_DIR = process.env.INSPIRATION_DATA_DIR ?? ROOT;
export const DATA_DIR = path.join(BASE_DIR, "data");
export const RAW_DIR = path.join(DATA_DIR, "raw");
export const ASSETS_DIR = path.join(BASE_DIR, "assets");
export const DB_PATH = path.join(DATA_DIR, "inspiration.db");
export const CONFIG_PATH = path.join(DATA_DIR, "config.json");

export interface Config {
  baseUrl: string;
  apiKey: string;
  model: string; // 多模态提取模型
  maxTokens: number;
  serverPort: number;
  seedTags: string[];
  /** 手机收件箱：公网 HTTPS 地址，如 https://collect.example.com */
  inboxUrl: string;
  inboxToken: string;
  inboxEnabled: boolean;
  /** 收件箱轮询间隔秒，10–120 */
  inboxIntervalSec: number;
}

const DEFAULTS: Config = {
  baseUrl: "https://api.deepseek.com",
  apiKey: "",
  model: "deepseek-flash",
  maxTokens: 12000,
  serverPort: 5178,
  seedTags: ["UI设计", "前端", "AI工具", "提示词工程", "设计理论", "配色", "效率工具", "写作", "方法论"],
  inboxUrl: "",
  inboxToken: "",
  inboxEnabled: false,
  inboxIntervalSec: 30,
};

/** 显式指定数据目录时仅使用该目录的 .env，避免开发/测试/正式库串用配置。 */
function loadDotEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const dir of [BASE_DIR]) {
    const p = path.join(dir, ".env");
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      if (line.trim().startsWith("#")) continue;
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
    }
  }
  return out;
}

export function loadConfig(): Config {
  let file: Partial<Config> = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      file = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    } catch {
      // 配置损坏时回退默认值
    }
  }
  // 优先级：设置界面保存的 config.json > .env 文件 > 进程环境变量 > 默认值
  const env = loadDotEnv();
  return {
    ...DEFAULTS,
    apiKey: file.apiKey ?? env.API_KEY ?? process.env.API_KEY ?? DEFAULTS.apiKey,
    baseUrl: file.baseUrl || env.BASE_URL || process.env.BASE_URL || DEFAULTS.baseUrl,
    model: file.model || env.MODEL || process.env.MODEL || DEFAULTS.model,
    maxTokens: file.maxTokens ?? DEFAULTS.maxTokens,
    serverPort: file.serverPort ?? DEFAULTS.serverPort,
    seedTags: file.seedTags ?? DEFAULTS.seedTags,
    inboxUrl: file.inboxUrl ?? env.INBOX_URL ?? process.env.INBOX_URL ?? DEFAULTS.inboxUrl,
    inboxToken: file.inboxToken ?? env.INBOX_TOKEN ?? process.env.INBOX_TOKEN ?? DEFAULTS.inboxToken,
    inboxEnabled: file.inboxEnabled ?? DEFAULTS.inboxEnabled,
    inboxIntervalSec: Number.isFinite(file.inboxIntervalSec)
      ? Math.min(120, Math.max(10, Number(file.inboxIntervalSec))) : DEFAULTS.inboxIntervalSec,
  };
}

export function saveConfig(patch: Partial<Config>): Config {
  const merged = { ...loadConfig(), ...patch };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(`${CONFIG_PATH}.tmp`, JSON.stringify(merged, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(`${CONFIG_PATH}.tmp`, CONFIG_PATH);
  return merged;
}
