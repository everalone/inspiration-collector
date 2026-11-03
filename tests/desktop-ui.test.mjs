import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const script = readFileSync(new URL("../viewer/desktop.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../viewer/index.html", import.meta.url), "utf8");
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

function harness(bridge) {
  const elements = new Map();
  const classes = new Set();
  const documentEvents = new Map();
  const windowEvents = new Map();
  for (const id of [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1])) {
    const events = new Map();
    const attrs = new Map();
    elements.set(id, { id, hidden: ["desktop-controls", "update-panel", "update-progress", "update-error"].includes(id),
      textContent: "", innerHTML: "", disabled: false, dataset: {}, events, attrs, focused: false,
      addEventListener: (name, callback) => events.set(name, callback),
      setAttribute: (key, value) => attrs.set(key, value),
      focus() { this.focused = true; },
      contains(target) { return target === this; },
    });
  }
  const body = { classList: {
    add(name) { classes.add(name); },
    toggle(name, active) { if (active) classes.add(name); else classes.delete(name); },
  } };
  vm.runInNewContext(script, {
    document: { body, getElementById: id => elements.get(id), addEventListener: (name, callback) => documentEvents.set(name, callback) },
    window: { desktopAPI: bridge, addEventListener: (name, callback) => windowEvents.set(name, callback) },
  });
  return { elements, classes, documentEvents, windowEvents,
    click: async id => { await elements.get(id).events.get("click")?.({ target: elements.get(id) }); await flush(); },
  };
}

function desktopBridge(initial = { phase: "idle", currentVersion: "0.2.3" }) {
  const listeners = {};
  const calls = [];
  let disposed = 0;
  const api = {
    getWindowState: async () => ({ maximized: false, version: "0.2.3" }),
    getUpdateState: async () => initial,
    onWindowState: fn => { listeners.window = fn; return () => disposed++; },
    onUpdateState: fn => { listeners.update = fn; return () => disposed++; },
    windowAction: async action => { calls.push(action); return { maximized: action === "toggle-maximize", version: "0.2.3" }; },
    checkUpdate: async () => { calls.push("check"); return { phase: "available", currentVersion: "0.2.3", version: "0.2.4" }; },
    downloadUpdate: async () => { calls.push("download"); return { phase: "ready", currentVersion: "0.2.3", version: "0.2.4" }; },
    installUpdate: async () => { calls.push("install"); return { phase: "installing", currentVersion: "0.2.3", version: "0.2.4" }; },
  };
  return { api, calls, listeners, disposed: () => disposed };
}

test("normal browser keeps native window and updater controls hidden", () => {
  const h = harness(undefined);
  assert.equal(h.elements.get("desktop-controls").hidden, true);
  assert.equal(h.elements.get("update-panel").hidden, true);
  assert.equal(h.classes.has("desktop"), false);
});

test("one titlebar contains existing controls and places update immediately before window buttons", () => {
  const chrome = html.slice(html.indexOf('id="window-titlebar"'), html.indexOf('class="collection-toolbar"'));
  for (const id of ["settings-btn", "tasks-btn", "update-btn", "window-minimize", "window-maximize", "window-close"]) assert.ok(chrome.includes(`id="${id}"`));
  assert.ok(chrome.indexOf('id="update-btn"') < chrome.indexOf('id="window-minimize"'));
  assert.match(chrome, /class="stat"/);
});

test("update actions check, download, and restart through the bridge without opening a website", async () => {
  const b = desktopBridge();
  const h = harness(b.api);
  await flush();
  assert.equal(h.elements.get("desktop-controls").hidden, false);
  assert.equal(h.elements.get("update-label").textContent, "检查更新");
  await h.click("update-btn");
  assert.equal(h.elements.get("update-label").textContent, "下载更新");
  assert.match(h.elements.get("update-description").textContent, /发现 v0.2.4/);
  assert.equal(h.elements.get("update-panel").hidden, false);
  await h.click("update-action");
  assert.equal(h.elements.get("update-label").textContent, "重启更新");
  await h.click("update-btn");
  assert.deepEqual(b.calls, ["check", "download", "install"]);
  assert.equal(h.elements.get("update-label").textContent, "正在更新…");
});

test("automatic checks stay quiet and download progress disables duplicate update commands", async () => {
  const b = desktopBridge();
  const h = harness(b.api);
  await flush();
  b.listeners.update({ phase: "available", currentVersion: "0.2.3", version: "0.2.4" });
  assert.equal(h.elements.get("update-panel").hidden, true);
  b.listeners.update({ phase: "downloading", progress: 41.4, currentVersion: "0.2.3", version: "0.2.4" });
  assert.equal(h.elements.get("update-label").textContent, "下载 41%");
  assert.equal(h.elements.get("update-progress").value, 41);
  assert.equal(h.elements.get("update-btn").disabled, true);
  await h.click("update-btn");
  assert.deepEqual(b.calls, []);
  b.listeners.update({ phase: "idle", checkedAt: "2026-11-01T12:00:00Z", currentVersion: "0.2.3", version: "0.2.2" });
  assert.equal(h.elements.get("update-label").textContent, "已是最新");
  assert.equal(h.elements.get("update-version").textContent, "当前 v0.2.3");
});

test("a busy installer keeps the ready update, displays safe text, and can be retried", async () => {
  const b = desktopBridge({ phase: "ready", currentVersion: "0.2.3", version: "0.2.4" });
  b.api.installUpdate = async () => { throw new Error('收集任务处理中，请完成后重试。 <img src=x> token=secret'); };
  const h = harness(b.api);
  await flush();
  await h.click("update-btn");
  assert.equal(h.elements.get("update-label").textContent, "重启更新");
  assert.equal(h.elements.get("update-btn").disabled, false);
  assert.match(h.elements.get("update-error").textContent, /收集任务处理中/);
  assert.doesNotMatch(h.elements.get("update-error").textContent, /secret/);
  assert.equal(h.elements.get("update-error").innerHTML, "");
  assert.equal(h.elements.get("update-error").hidden, false);
  b.api.installUpdate = async () => ({ phase: "installing", currentVersion: "0.2.3", version: "0.2.4" });
  await h.click("update-action");
  assert.equal(h.elements.get("update-error").hidden, true);
});

test("window controls preserve minimize, maximize, and close-to-tray actions", async () => {
  const b = desktopBridge();
  const h = harness(b.api);
  await flush();
  await h.click("window-minimize");
  await h.click("window-maximize");
  assert.equal(h.classes.has("window-maximized"), true);
  assert.equal(h.elements.get("window-maximize").attrs.get("aria-label"), "还原");
  await h.click("window-close");
  assert.deepEqual(b.calls, ["minimize", "toggle-maximize", "close"]);
  b.listeners.window({ maximized: false });
  assert.equal(h.classes.has("window-maximized"), false);
  await h.elements.get("window-titlebar").events.get("dblclick")({ target: { closest: () => ({}) } });
  assert.equal(b.calls.length, 3, "double clicking a titlebar button must not maximize");
});

test("update popover supports Escape and subscription cleanup", async () => {
  const b = desktopBridge();
  const h = harness(b.api);
  await flush();
  await h.click("update-btn");
  let prevented = false;
  h.documentEvents.get("keydown")({ key: "Escape", preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(h.elements.get("update-panel").hidden, true);
  assert.equal(h.elements.get("update-btn").focused, true);
  h.windowEvents.get("beforeunload")();
  assert.equal(b.disposed(), 2);
});

test("unsupported runtime explains the limitation instead of dispatching an updater action", async () => {
  const b = desktopBridge({ phase: "unsupported", currentVersion: "0.2.3" });
  const h = harness(b.api);
  await flush();
  await h.click("update-btn");
  assert.equal(h.elements.get("update-panel").hidden, false);
  assert.match(h.elements.get("update-description").textContent, /Windows 安装版或便携版/);
  await h.click("update-action");
  assert.equal(h.elements.get("update-panel").hidden, true);
  assert.deepEqual(b.calls, []);
});
