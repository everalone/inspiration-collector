import { app, BrowserWindow, Tray, Menu, clipboard, Notification, nativeImage, ipcMain, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClipboardCollector } from "./collection-controller.mjs";
import { createUpdater } from "./updater.mjs";
import { registerDesktopIpc } from "./desktop-ipc.mjs";
import { toReleaseVersion } from "./version.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.INSPIRATION_PORT) || 5178;
const BASE = `http://127.0.0.1:${PORT}`;
const VERSION = toReleaseVersion(app.getVersion());

app.setAppUserModelId("com.p016.inspiration-collector");

const icon = nativeImage.createFromPath(path.join(ROOT, "src-electron", "icon.png"));
const startHidden = process.argv.includes("--hidden");
// Isolated package checks exercise real startup without consuming the user's clipboard.
const runtimeCheck = process.argv.includes("--runtime-check");

let tray = null;
let win = null;
let lastCoreError = null;
let autoCollect = !runtimeCheck;
let clipboardTimer = null;
let notificationTimer = null;
let updateTimer = null;
let updateStartupTimer = null;
let updater = null;
let desktopIpc = null;
let coreRuntime = null;
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
  if (win.isMinimized()) win.restore();
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
    const tasksModule = await import("../dist/core/tasks.js");
    const inboxModule = await import("../dist/core/inbox-client.js");
    const maintenance = await import("../dist/core/maintenance.js");
    coreRuntime = { tasks: tasksModule.getTaskQueue(), inbox: inboxModule, maintenance };
    updater = createUpdater({
      currentVersion: VERSION, isPackaged: app.isPackaged, platform: process.platform, arch: process.arch,
      portableExecutable: process.env.PORTABLE_EXECUTABLE_FILE, exePath: app.getPath("exe"), userDataDir,
      onChange: state => {
        if (win && !win.isDestroyed()) win.webContents.send("desktop:update-state-changed", state);
      },
      canInstall: () => {
        // A synchronous idle check + gate keeps later async input from racing the updater.
        if (coreRuntime.tasks.list().some(task => ["queued", "running"].includes(task.status))) {
          return "还有收集任务正在处理，请完成后再重启更新";
        }
        if (coreRuntime.inbox.isInboxBusy()) return "正在同步手机收件箱，请稍后再点重启更新";
        if (coreRuntime.inbox.getInboxStatus().pendingAckCount) return "还有收集回执等待确认，请恢复收件箱连接后再更新";
        coreRuntime.maintenance.setUpdatePending(true);
        return true;
      },
      onBeforeQuit: () => { app.isQuiting = true; app.quit(); },
    });
    desktopIpc = registerDesktopIpc({ ipcMain, getWindow: () => win, updater, version: VERSION, baseUrl: BASE,
      releaseInstallGate: () => coreRuntime.maintenance.setUpdatePending(false) });
    createWindow();
    createTray();
    if (!runtimeCheck) {
      watchClipboard();
      watchTaskNotifications();
    }
    if (app.isPackaged && !runtimeCheck) {
      const check = () => void updater.check().catch(() => {});
      updateStartupTimer = setTimeout(check, 10_000);
      updateTimer = setInterval(check, 6 * 60 * 60 * 1000);
    }
    if (!runtimeCheck) new Notification({ title: "灵感收集已启动", body: "复制微信文章链接即可自动收集", icon }).show();
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
    minWidth: 980,
    minHeight: 640,
    show: false,
    title: "灵感收集",
    icon,
    autoHideMenuBar: true,
    frame: false,
    titleBarStyle: "hidden",
    roundedCorners: true,
    thickFrame: true,
    backgroundColor: "#00000000",
    ...(process.platform === "win32" ? { backgroundMaterial: "acrylic" } : {}),
    webPreferences: { preload: path.join(ROOT, "src-electron", "preload.cjs"),
      contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.setMenu(null);
  win.webContents.setWindowOpenHandler(({ url }) => {
    try { if (["https:", "http:"].includes(new URL(url).protocol)) void shell.openExternal(url).catch(() => {}); } catch { /* Invalid link. */ }
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    try { if (new URL(url).origin !== BASE) event.preventDefault(); }
    catch { event.preventDefault(); }
  });
  const publishWindowState = () => {
    if (!win.isDestroyed()) win.webContents.send("desktop:window-state-changed", desktopIpc.windowState());
  };
  win.on("maximize", publishWindowState);
  win.on("unmaximize", publishWindowState);
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
    if (coreRuntime?.maintenance.isUpdatePending()) return;
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
      // Notifications read the durable queue; the UI intentionally limits completed history to ten rows.
      const tasks = coreRuntime.tasks.list({ includeArchived: true });
      for (const task of tasks) {
        if (!["done", "failed"].includes(task.status) || task.resolvedAt || task.archivedAt || Date.parse(task.updatedAt) < launchedAt) continue;
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
  app.isQuiting = true;
  clearInterval(clipboardTimer);
  clearInterval(notificationTimer);
  clearInterval(updateTimer);
  clearTimeout(updateStartupTimer);
  updater?.dispose();
  desktopIpc?.dispose();
  coreRuntime?.inbox.stopInboxPoller();
});
app.on("window-all-closed", () => {
  // 托盘常驻，不随窗口关闭退出
});
