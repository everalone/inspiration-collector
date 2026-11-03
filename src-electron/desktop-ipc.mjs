/** Only the local app's top-level frame can operate its window or updater. */
export function registerDesktopIpc({ ipcMain, getWindow, updater, version, baseUrl, releaseInstallGate = () => {} }) {
  const channels = [];
  const windowState = () => ({ maximized: !!getWindow()?.isMaximized(), version });
  const handle = (channel, callback) => {
    channels.push(channel);
    ipcMain.handle(channel, async (event, ...args) => {
      const win = getWindow();
      const frame = event.senderFrame;
      let trusted = false;
      try {
        const url = new URL(frame?.url);
        trusted = !!win && !win.isDestroyed() && event.sender === win.webContents &&
          frame === win.webContents.mainFrame && url.origin === baseUrl &&
          ["/", "/index.html"].includes(url.pathname);
      } catch { /* Unknown frames have no desktop privileges. */ }
      if (!trusted) throw new Error("此页面无法操作桌面窗口");
      return callback(...args);
    });
  };
  handle("desktop:window-state", windowState);
  handle("desktop:window-action", action => {
    const win = getWindow();
    if (action === "minimize") win.minimize();
    else if (action === "toggle-maximize") win.isMaximized() ? win.unmaximize() : win.maximize();
    else if (action === "close") win.close();
    else throw new Error("未知窗口操作");
    return windowState();
  });
  handle("desktop:update-state", () => updater.getState());
  handle("desktop:update-check", () => updater.check());
  handle("desktop:update-download", () => updater.download());
  handle("desktop:update-install", async () => {
    try { return await updater.install(); }
    catch (error) { releaseInstallGate(); throw error; }
  });
  return { windowState, dispose: () => channels.forEach(channel => ipcMain.removeHandler(channel)) };
}
