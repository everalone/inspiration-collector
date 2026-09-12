import { app, BrowserWindow, Tray, Menu, clipboard, Notification, nativeImage } from "electron";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 5178;
const BASE = `http://127.0.0.1:${PORT}`;
const WX_URL_RE = /https?:\/\/mp\.weixin\.qq\.com\/s\/[A-Za-z0-9_-]+/;

app.setAppUserModelId("com.p016.inspiration-collector");

const icon = nativeImage.createFromPath(path.join(ROOT, "src-electron", "icon.png"));
const startHidden = process.argv.includes("--hidden");

let tray = null;
let win = null;
let serverProc = null;
let lastClipboard = "";
let autoCollect = true;
let ingesting = false;

app.isQuiting = false;

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
    startServer();
    const ok = await waitForServer();
    if (!ok) {
      dialogError("核心服务启动失败，请检查 Node 环境后重试。");
      app.quit();
      return;
    }
    createWindow();
    createTray();
    watchClipboard();
    new Notification({ title: "灵感收集已启动", body: "复制微信文章链接即可自动收集", icon }).show();
  } catch (e) {
    dialogError(`启动异常: ${String(e).slice(0, 100)}`);
    app.quit();
  }
}

function startServer() {
  serverProc = spawn("npx", ["tsx", "cli.ts", "serve"], {
    cwd: ROOT,
    stdio: "ignore",
    windowsHide: true,
    shell: process.platform === "win32", // Windows 上 npx 是 .cmd，必须走 shell
  });
  serverProc.on("exit", () => {
    serverProc = null;
  });
}

function stopServer() {
  if (!serverProc) return;
  if (process.platform === "win32" && serverProc.pid) {
    spawn("taskkill", ["/T", "/F", "/PID", String(serverProc.pid)], { windowsHide: true });
  } else {
    serverProc.kill();
  }
  serverProc = null;
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
  setInterval(async () => {
    let text = "";
    try {
      text = String(clipboard.readText() ?? "").trim();
    } catch {
      return;
    }
    if (!text || text === lastClipboard) return;
    lastClipboard = text;
    if (!autoCollect || ingesting) return;
    const url = text.match(WX_URL_RE)?.[0];
    if (!url) return;
    try {
      const articles = await (await fetch(`${BASE}/api/articles`)).json();
      if (articles.some((a) => a.id === url.split("/s/")[1] || a.url === url)) {
        new Notification({ title: "灵感收集", body: "这篇文章已在库里了", icon }).show();
        return;
      }
    } catch {
      return;
    }
    await ingest(url);
  }, 1500);
}

async function ingest(url) {
  ingesting = true;
  new Notification({ title: "开始收集", body: "正在抓取并提取卡片，约 1~2 分钟…", icon }).show();
  try {
    const r = await fetch(`${BASE}/api/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const data = await r.json();
    if (data.error) {
      new Notification({ title: "收集失败", body: String(data.error).slice(0, 120), icon }).show();
    } else {
      const counts = Object.entries(data.counts)
        .map(([k, v]) => ({ palette: "配色", website: "网址", repo: "项目", prompt: "提示词", note: "笔记" }[k] + `×${v}`))
        .join("，");
      const n = new Notification({
        title: "✔ 收集完成",
        body: `${counts || "未提取到卡片"}${data.unsureCount ? `（${data.unsureCount} 待核对）` : ""}`,
        icon,
      });
      n.on("click", () => showWindow());
      n.show();
    }
  } catch (e) {
    new Notification({ title: "收集失败", body: String(e).slice(0, 120), icon }).show();
  } finally {
    ingesting = false;
  }
}

app.on("before-quit", () => {
  stopServer();
});
app.on("window-all-closed", () => {
  // 托盘常驻，不随窗口关闭退出
});
