/* Applies the saved UI skin and light/dark mode before first paint.
 * skin: paper | glass | slate   mode preference: "light" | "dark" | absent (follow system)
 */
(() => {
  const KEY = "uiTheme";
  const root = document.documentElement;
  const skins = ["paper", "glass", "slate"];
  const mq = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

  const read = () => {
    try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; }
  };
  let pref = read();

  const resolvedMode = () =>
    pref.mode === "light" || pref.mode === "dark" ? pref.mode : (mq?.matches ? "dark" : "light");

  const apply = () => {
    root.dataset.skin = skins.includes(pref.skin) ? pref.skin : "paper";
    root.dataset.mode = resolvedMode();
  };

  apply();
  mq?.addEventListener?.("change", () => {
    if (pref.mode !== "light" && pref.mode !== "dark") apply();
  });

  window.setUiTheme = patch => {
    pref = { ...pref, ...patch };
    if (pref.mode === null || pref.mode === "auto") delete pref.mode;
    try { localStorage.setItem(KEY, JSON.stringify(pref)); } catch { /* storage may be unavailable */ }
    apply();
  };

  window.getUiTheme = () => ({
    skin: root.dataset.skin,
    mode: pref.mode === "light" || pref.mode === "dark" ? pref.mode : "auto",
  });
})();
