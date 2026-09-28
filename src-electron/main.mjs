import { app, BrowserWindow, Tray, Menu, clipboard, Notification, nativeImage } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClipboardCollector } from "./collection-controller.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.INSPIRATION_PORT) || 5178;
const BASE = `http://127.0.0.1:${PORT}`;

app.setAppUserModelId("com.p016.inspiration-collector");

const icon = nativeImage.createFromPath(path.join(ROOT, "src-electron", "icon.png"));
const startHidden = process.argv.includes("--hidden");

let tray = null;
let win = null;
let lastCoreError = null;
let autoCollect = true;
let clipboardTimer = null;
let notificationTimer = null;
const launchedAt = Date.now();

app.isQuiting = false;

// Select the data directory before locking, keeping development and packaged instances separate.
const userDataDir = path.resolve(process.env.INSPIRATION_DATA_DIR || (app.isPackaged
  ? path.join(app.getPath("appData"), "灵感收集") : ROOT));
app.setPath("userData", userDataDir);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());
  app.whenReady().then(boot);
}

function showWindow() {
  if (!win) return;
  win.show();
  win.focus();
}

async function boot() {
  try {
    // 数据目录固定为 %AppData%/灵感收集（Electron 默认用 package.json 的 name，重装/改名也不变）
    fs.mkdirSync(userDataDir, { recursive: true });
    // 数据写入用户目录（安装目录只读）
    process.env.INSPIRATION_DATA_DIR = userDataDir;
    // 应用根目录（asar 内），供核心服务定位 viewer 静态文件
    process.env.INSPIRATION_APP_ROOT = ROOT;
    // 支持把 .env 放在安装目录（exe 旁），便于打包版配置 key
    const exeEnv = path.join(path.dirname(app.getPath("exe")), ".env");
    if (fs.existsSync(exeEnv)) {
      for (const line of fs.readFileSync(exeEnv, "utf8").split(/\r?\n/)) {
        if (line.trim().startsWith("#")) continue;
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
      }
    }
    await startCore();
    const ok = await waitForServer();
    if (!ok) {
      dialogError(`核心服务启动失败${lastCoreError ? "：" + String(lastCoreError).slice(0, 80) : ""}，请重新安装或反馈日志。`);
      app.quit();
      return;
    }
    createWindow();
    createTray();
    watchClipboard();
    watchTaskNotifications();
    new Notification({ title: "灵感收集已启动", body: "复制微信文章链接即可自动收集", icon }).show();
  } catch (e) {
    dialogError(`启动异常: ${String(e).slice(0, 100)}`);
    app.quit();
  }
}

async function startCore() {
  // Both development and packaged launches use the freshly built core.
  try {
    const { startServer } = await import("../dist/core/server.js");
    await startServer(PORT);
    return;
  } catch (e) {
    if (String(e).includes("EADDRINUSE")) {
      throw new Error(`本机端口 ${PORT} 已被占用，请退出旧版灵感收集或开发服务后重试。`);
    }
    lastCoreError = e;
    throw e;
  }
}

async function waitForServer(retries = 40) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(`${BASE}/api/bootstrap`);
      if (r.ok) return true;
    } catch {
      /* 未就绪 */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function dialogError(msg) {
  // app 模块 dialog 需要延迟引入，这里用 Notification 兜底
  new Notification({ title: "灵感收集", body: msg, icon }).show();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 960,
    show: false,
    title: "灵感收集",
    icon,
    autoHideMenuBar: true,
    backgroundColor: "#f4f4f5",
  });
  win.loadURL(`${BASE}/`);
  win.once("ready-to-show", () => {
    if (startHidden) win.hide();
    else win.show();
  });
  win.on("close", (e) => {
    if (!app.isQuiting) {
      e.preventDefault();
      win.hide(); // 关闭即最小化到托盘
    }
  });
}

function createTray() {
  tray = new Tray(icon);
  tray.setToolTip("灵感收集");
  const menu = Menu.buildFromTemplate([
    { label: "显示卡片墙", click: () => showWindow() },
    { type: "separator" },
    {
      label: "自动收集剪贴板链接",
      type: "checkbox",
      checked: autoCollect,
      click: (item) => { autoCollect = item.checked; },
    },
    {
      label: "开机自启",
      type: "checkbox",
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, args: ["--hidden"] }),
    },
    { type: "separator" },
    {
      label: "退出",
      click: () => {
        app.isQuiting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
  tray.on("click", () => {
    if (win.isVisible() && win.isFocused()) win.hide();
    else showWindow();
  });
}

function watchClipboard() {
  const collector = createClipboardCollector({
    submit: async (url) => {
      const response = await fetch(`${BASE}/api/tasks`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, source: "clipboard" }), signal: AbortSignal.timeout(10000),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "未能加入任务队列");
    },
    onQueued: () => new Notification({ title: "已加入收集队列", body: "可以继续复制下一篇，完成后会通知你。", icon }).show(),
    onError: () => new Notification({ title: "暂时无法提交收集", body: "链接已暂存，连接恢复后自动重试。", icon }).show(),
  });
  clipboardTimer = setInterval(() => {
    try { void collector.accept(clipboard.readText(), autoCollect); } catch { /* clipboard temporarily unavailable */ }
  }, 1500);
}

/** Core owns collection and inbox polling; Electron only observes results. */
function watchTaskNotifications() {
  const seen = new Set();
  let polling = false;
  const tick = async () => {
    if (polling) return;
    polling = true;
    try {
      const response = await fetch(`${BASE}/api/tasks`, { signal: AbortSignal.timeout(10000) });
      if (!response.ok) return;
      const { tasks = [] } = await response.json();
      for (const task of tasks) {
        if (!["done", "failed"].includes(task.status) || Date.parse(task.updatedAt) < launchedAt) continue;
        const key = `${task.id}:${task.attempts}:${task.status}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const skipped = task.result?.skipped;
        const cards = Object.values(task.result?.counts || {}).reduce((sum, value) => sum + Number(value), 0);
        const notification = new Notification({
          title: task.status === "failed" ? "收集失败" : skipped ? "这篇文章已在库中" : "✔ 收集完成",
          body: task.status === "failed" ? "可在任务列表查看原因并重试。" : `${task.title || "文章"}${skipped ? " · 已保留现有卡片" : ` · ${cards} 张卡片`}`,
          icon,
        });
        notification.on("click", showWindow);
        notification.show();
      }
    } catch { /* The core may be restarting; the next snapshot catches up. */ }
    finally { polling = false; }
  };
  notificationTimer = setInterval(tick, 3000);
  void tick();
}

app.on("before-quit", () => {
  clearInterval(clipboardTimer);
  clearInterval(notificationTimer);
});
app.on("window-all-closed", () => {
  // 托盘常驻，不随窗口关闭退出
});
