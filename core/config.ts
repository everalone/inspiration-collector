import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
}

const DEFAULTS: Config = {
  baseUrl: "https://api.deepseek.com",
  apiKey: "",
  model: "deepseek-flash",
  maxTokens: 12000,
  serverPort: 5178,
  seedTags: ["UI设计", "前端", "AI工具", "提示词工程", "设计理论", "配色", "效率工具", "写作", "方法论"],
};

/** 读取 .env（KEY=VALUE 简单格式，支持 # 注释）；依次查项目根与数据目录（打包态 userData 优先） */
function loadDotEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const dir of [ROOT, BASE_DIR]) {
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
  const merged = { ...DEFAULTS, ...file };
  // 进程环境变量（打包版由 Electron 主进程从 exe 旁 .env 注入）
  if (process.env.API_KEY) merged.apiKey = process.env.API_KEY;
  if (process.env.BASE_URL) merged.baseUrl = process.env.BASE_URL;
  if (process.env.MODEL) merged.model = process.env.MODEL;
  // .env 文件优先：密钥等敏感信息走 .env，不入库
  const env = loadDotEnv();
  if (env.API_KEY) merged.apiKey = env.API_KEY;
  if (env.BASE_URL) merged.baseUrl = env.BASE_URL;
  if (env.MODEL) merged.model = env.MODEL;
  return merged;
}

export function saveConfig(patch: Partial<Config>): Config {
  const merged = { ...loadConfig(), ...patch };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), "utf8");
  return merged;
}
