import assert from "node:assert/strict";
import { test } from "node:test";
import { registerDesktopIpc } from "../src-electron/desktop-ipc.mjs";

function fixture() {
  const handlers = new Map(), calls = [];
  const frame = { url: "http://127.0.0.1:5178/" };
  const contents = { mainFrame: frame };
  const win = { webContents: contents, isDestroyed: () => false, isMaximized: () => false,
    close: () => calls.push("close"), minimize: () => calls.push("minimize"), maximize: () => calls.push("maximize") };
  const ipcMain = { handle: (name, handler) => handlers.set(name, handler), removeHandler: name => handlers.delete(name) };
  const updater = { getState: () => ({ phase: "ready" }), check: () => calls.push("check"), download: () => calls.push("download"),
    install: async () => { throw new Error("busy"); } };
  const controller = registerDesktopIpc({ ipcMain, getWindow: () => win, updater, version: "0.2.3", baseUrl: "http://127.0.0.1:5178",
    releaseInstallGate: () => calls.push("release-gate") });
  return { handlers, calls, contents, frame, controller, event: { sender: contents, senderFrame: frame } };
}

test("desktop IPC accepts only the owned local main frame and fixed actions", async () => {
  const h = fixture();
  const action = h.handlers.get("desktop:window-action");
  await action(h.event, "minimize");
  await action(h.event, "toggle-maximize");
  await action(h.event, "close");
  assert.deepEqual(h.calls, ["minimize", "maximize", "close"]);
  await assert.rejects(action(h.event, "execute"), /未知窗口操作/);
  for (const event of [
    { sender: {}, senderFrame: h.frame },
    { sender: h.contents, senderFrame: { url: h.frame.url } },
    { sender: h.contents, senderFrame: null },
  ]) await assert.rejects(h.handlers.get("desktop:update-install")(event), /此页面无法/);
  for (const url of ["https://example.com/", "http://127.0.0.1:51780/", "http://127.0.0.1:5178/assets/a.html"]) {
    h.frame.url = url;
    await assert.rejects(h.handlers.get("desktop:update-check")(h.event), /此页面无法/);
  }
  h.controller.dispose();
  assert.equal(h.handlers.size, 0);
});

test("an unsuccessful installation releases the collection gate without quitting", async () => {
  const h = fixture();
  await assert.rejects(h.handlers.get("desktop:update-install")(h.event), /busy/);
  assert.deepEqual(h.calls, ["release-gate"]);
});
