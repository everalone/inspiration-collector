/* Desktop chrome is optional: the same viewer also runs in a normal browser. */
(() => {
  "use strict";
  const bridge = window.desktopAPI;
  if (!bridge || typeof bridge.windowAction !== "function") return;
  const byId = (id) => document.getElementById(id);
  const controls = byId("desktop-controls");
  const titlebar = byId("window-titlebar");
  const updateButton = byId("update-btn");
  const updateLabel = byId("update-label");
  const panel = byId("update-panel");
  const actionButton = byId("update-action");
  const description = byId("update-description");
  const versionLabel = byId("update-version");
  const progress = byId("update-progress");
  const errorLabel = byId("update-error");
  const maximize = byId("window-maximize");
  const allowedPhases = new Set(["idle", "checking", "available", "downloading", "ready", "installing", "error", "unsupported"]);
  let update = { phase: "idle", currentVersion: "", version: "", progress: 0, error: "", checkedAt: null };
  let windowVersion = "";
  let pendingAction = false;
  let actionError = "";
  const disposers = [];

  function safeText(value, max = 240) {
    return String(value ?? "").replace(/Bearer\s+\S+/gi, "Bearer [已隐藏]")
      .replace(/\bsk-[\w-]+/g, "[已隐藏]")
      .replace(/((?:api[_-]?key|token|authorization)\s*[=:]\s*)[^\s,;]+/gi, "$1[已隐藏]")
      .replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max);
  }
  function setPanel(open, returnFocus = false) {
    panel.hidden = !open;
    updateButton.setAttribute("aria-expanded", String(open));
    if (!open && returnFocus && !updateButton.disabled) updateButton.focus();
  }
  function displayError(error) {
    actionError = safeText(error?.message || error || "操作未完成，请重试。");
    renderUpdate();
    setPanel(true);
  }
  function renderWindow(value) {
    if (!value || typeof value !== "object") return;
    const maximized = value.maximized === true;
    document.body.classList.toggle("window-maximized", maximized);
    maximize.title = maximized ? "还原" : "最大化";
    maximize.setAttribute("aria-label", maximize.title);
    if (value.version) windowVersion = safeText(value.version, 40);
    renderUpdate();
  }
  function acceptUpdate(value) {
    if (!value || typeof value !== "object") return;
    update = {
      phase: allowedPhases.has(value.phase) ? value.phase : "error",
      currentVersion: safeText(value.currentVersion, 40), version: safeText(value.version, 40),
      progress: Number.isFinite(value.progress) ? Math.max(0, Math.min(100, value.progress)) : 0,
      error: safeText(value.error), checkedAt: value.checkedAt || null,
    };
    if (value.phase !== "ready") actionError = "";
    renderUpdate();
  }
  function renderUpdate() {
    const current = update.currentVersion || windowVersion;
    const target = update.version ? `v${update.version.replace(/^v/, "")}` : "新版本";
    const percent = Math.round(update.progress);
    const phase = update.phase;
    const busy = pendingAction || ["checking", "downloading", "installing"].includes(phase);
    const labels = {
      idle: update.checkedAt ? "已是最新" : "检查更新", checking: "检查中…", available: "下载更新",
      downloading: `下载 ${percent}%`, ready: "重启更新", installing: "正在更新…", error: "重试更新", unsupported: "更新说明",
    };
    const descriptions = {
      idle: update.checkedAt ? "当前已是最新版本，会自动检查后续更新。" : "应用会自动检查更新，也可以在这里手动检查。",
      checking: "正在检查 GitHub 上的新版本…",
      available: `发现 ${target}。下载期间可以继续使用，下载完成后再重启更新。`,
      downloading: `正在下载 ${target}（${percent}%），可以继续浏览和收集。`,
      ready: `${target} 已下载并校验。点击“重启更新”后应用会关闭并重新启动，已有文章与设置会保留。`,
      installing: "正在准备更新并重启应用…",
      error: "更新暂未完成，当前版本可以继续使用。",
      unsupported: "此运行方式不支持应用内更新。请使用 Windows 安装版或便携版。",
    };
    updateLabel.textContent = labels[phase];
    updateButton.dataset.phase = phase;
    updateButton.disabled = busy;
    updateButton.title = phase === "ready" ? "重启并安装已校验的更新" : phase === "available" ? `下载 ${target}` : "检查应用更新";
    updateButton.setAttribute("aria-busy", String(busy));
    const hasTarget = ["available", "downloading", "ready", "installing"].includes(phase) && update.version && update.version !== current;
    versionLabel.textContent = current ? `当前 v${current.replace(/^v/, "")}${hasTarget ? `  →  ${target}` : ""}` : "灵感收集";
    description.textContent = descriptions[phase];
    progress.hidden = phase !== "downloading";
    progress.value = percent;
    errorLabel.textContent = actionError || (phase === "unsupported" ? "" : update.error);
    errorLabel.hidden = !errorLabel.textContent;
    actionButton.textContent = phase === "idle" && update.checkedAt ? "再次检查" : phase === "unsupported" ? "关闭" : labels[phase];
    actionButton.disabled = busy;
  }
  async function updateAction() {
    setPanel(true);
    if (pendingAction) return;
    if (update.phase === "unsupported") { setPanel(false, true); return; }
    if (["checking", "downloading", "installing"].includes(update.phase)) return;
    const method = update.phase === "available" ? "downloadUpdate" : update.phase === "ready" ? "installUpdate" : "checkUpdate";
    if (typeof bridge[method] !== "function") { displayError("当前版本未提供该更新操作。"); return; }
    pendingAction = true;
    actionError = "";
    renderUpdate();
    try { acceptUpdate(await bridge[method]()); }
    catch (error) { displayError(error); }
    finally { pendingAction = false; renderUpdate(); }
  }
  async function windowAction(action) {
    try { renderWindow(await bridge.windowAction(action)); }
    catch (error) { displayError(error); }
  }

  document.body.classList.add("desktop");
  controls.hidden = false;
  updateButton.addEventListener("click", () => update.phase === "unsupported" ? setPanel(true) : updateAction());
  actionButton.addEventListener("click", updateAction);
  byId("update-dismiss").addEventListener("click", () => setPanel(false, true));
  byId("window-minimize").addEventListener("click", () => windowAction("minimize"));
  maximize.addEventListener("click", () => windowAction("toggle-maximize"));
  byId("window-close").addEventListener("click", () => windowAction("close"));
  titlebar.addEventListener("dblclick", (event) => {
    if (!event.target.closest("button, input, a, select, textarea")) void windowAction("toggle-maximize");
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !panel.hidden) { setPanel(false, true); event.preventDefault(); }
  });
  document.addEventListener("pointerdown", (event) => {
    if (!panel.hidden && !panel.contains(event.target) && !updateButton.contains(event.target)) setPanel(false);
  });
  for (const [method, callback] of [["onWindowState", renderWindow], ["onUpdateState", acceptUpdate]]) {
    if (typeof bridge[method] === "function") {
      const dispose = bridge[method](callback);
      if (typeof dispose === "function") disposers.push(dispose);
    }
  }
  window.addEventListener("beforeunload", () => disposers.forEach((dispose) => dispose()));
  renderUpdate();
  if (typeof bridge.getWindowState === "function") Promise.resolve().then(() => bridge.getWindowState()).then(renderWindow).catch(displayError);
  if (typeof bridge.getUpdateState === "function") Promise.resolve().then(() => bridge.getUpdateState()).then(acceptUpdate).catch(displayError);
})();
