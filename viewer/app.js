/* 灵感收集 · 左列表 + 右详情 */
"use strict";

const TYPE_LABEL = { palette: "配色", website: "网址", repo: "github", prompt: "提示词", note: "笔记" };
const state = { type: "all", q: "", verify: null, items: [], selectedId: null, bootstrap: null,
  loadingItems: false, itemTotal: 0, itemError: "", tasks: [], inbox: null, taskError: "" };
const imgCache = new Map(); // articleId -> Promise<string[]>
const collapsedGroups = new Set(); // 折叠的文章分组
let gallery = { files: [], idx: 0 };

const $ = (sel) => document.querySelector(sel);
const toastEl = $("#toast");
let toastTimer = null;
let itemRequest = 0;
let taskPolling = false;
let taskSnapshot = null;
let remoteFailures = [];
let remoteFailureMessage = "";
let settingsRequest = 0;

function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add("hidden"), 1600);
}

async function copyText(text, label) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  toast(`已复制${label ? " " + label : ""} ✔`);
}

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function safeParse(s, fallback = {}) { try { return JSON.parse(s); } catch { return fallback; } }

function errorText(error) {
  return String(error?.message ?? error ?? "请求失败")
    .replace(/Bearer\s+\S+/gi, "Bearer [已隐藏]")
    .replace(/\bsk-[a-zA-Z0-9_-]+/g, "[已隐藏]")
    .replace(/((?:api[_-]?key|token|authorization)\s*[=:]\s*)[^\s,;]+/gi, "$1[已隐藏]");
}

async function requestJSON(url, options) {
  const r = await fetch(url, options);
  let data;
  try { data = await r.json(); }
  catch { throw new Error(r.ok ? "服务返回了无法读取的数据" : `请求失败（${r.status}）`); }
  if (!r.ok || data?.error) throw new Error(errorText(data?.error || `请求失败（${r.status}）`));
  return data;
}

function jsonPost(body) {
  return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

/* ---------- 数据 ---------- */
async function loadBootstrap() {
  state.bootstrap = await requestJSON("/api/bootstrap");
  renderTabs();
  const b = state.bootstrap;
  const total = Object.values(b.typeCounts).reduce((a, c) => a + c, 0);
  if (!$(".stat")) {
    $(".brand-row").insertAdjacentHTML("beforeend", `<span class="stat">${b.articleCount} 篇文章 · ${total} 张卡片</span>`);
  } else {
    $(".stat").textContent = `${b.articleCount} 篇文章 · ${total} 张卡片`;
  }
}

async function loadItems() {
  const request = ++itemRequest;
  const p = new URLSearchParams();
  if (state.type !== "all") p.set("type", state.type);
  if (state.q) p.set("q", state.q);
  if (state.verify) p.set("verify", state.verify);
  p.set("limit", "200");
  state.loadingItems = true;
  state.itemError = "";
  renderList();
  const items = [];
  const ids = new Set();
  let offset = 0;
  try {
    do {
      p.set("offset", String(offset));
      const data = await requestJSON("/api/items?" + p.toString());
      if (request !== itemRequest) return;
      if (!Array.isArray(data.items) || !Number.isFinite(data.total)) throw new Error("卡片列表返回格式不正确");
      let added = 0;
      for (const item of data.items) {
        if (!ids.has(item.id)) { ids.add(item.id); items.push(item); added++; }
      }
      if (!added && offset < data.total) throw new Error("卡片列表未加载完整，请重新加载");
      offset += data.items.length;
      state.items = [...items];
      state.itemTotal = data.total;
      renderList();
      if (offset >= data.total) break;
    } while (true);
    if (!state.items.some((it) => it.id === state.selectedId)) {
      state.selectedId = state.items[0]?.id ?? null;
    }
    renderDetail();
  } catch (error) {
    if (request !== itemRequest) return;
    state.itemError = errorText(error);
    toast("卡片加载失败：" + state.itemError);
  } finally {
    if (request === itemRequest) {
      state.loadingItems = false;
      renderList();
    }
  }
}

function selectedItem() {
  return state.items.find((it) => it.id === state.selectedId) ?? null;
}

/* ---------- 筛选页签（单层） ---------- */
function renderTabs() {
  const c = state.bootstrap.typeCounts;
  const total = Object.values(c).reduce((a, b) => a + b, 0);
  const tabs = [["all", `全部 ${total}`]];
  for (const [t, label] of Object.entries(TYPE_LABEL)) tabs.push([t, `${label} ${c[t] ?? 0}`]);
  tabs.push(["__unsure", `待核对 ${state.bootstrap.unsureCount}`]);
  $("#tabs").innerHTML = tabs
    .map(([k, label]) => {
      const active = k === "__unsure" ? !!state.verify : state.type === k && !state.verify;
      return `<button class="tab ${active ? "active" : ""}" data-k="${k}">${label}</button>`;
    })
    .join("");
}

/* ---------- 左侧列表 ---------- */
function listPreview(item, payload) {
  if (item.type === "palette") {
    const colors = payload.colors ?? [];
    return `<div class="preview-swatches">${colors.map((c) => `<span style="background:${esc(c.hex)};flex:1"></span>`).join("")}</div>
      <div class="preview-hexes">${colors.map((c) => `<span>${esc(c.hex)}</span>`).join("")}</div>`;
  }
  if (item.type === "website" || item.type === "repo") {
    return `${payload.url ? `<span class="mini-url">${esc(payload.url)}</span>` : ""}${payload.desc ? `<div class="clip2">${esc(payload.desc)}</div>` : ""}`;
  }
  if (item.type === "prompt") {
    return `<div class="gray-box clip2">${esc(payload.text ?? "")}</div>`;
  }
  if (item.type === "note") {
    const s = payload.sections ?? [];
    const text = s.map((x) => [x.heading, ...(x.bullets ?? [])].filter(Boolean).join("：")).join("；");
    return `<div class="clip2">${esc(text || "（空笔记）")}</div>`;
  }
  return "";
}

/* ---------- 左侧列表（按文章分组：父=微信链接，子=卡片） ---------- */
function itemHtml(item) {
  const payload = safeParse(item.payload);
  return `<div class="li ${item.id === state.selectedId ? "selected" : ""}" data-id="${item.id}">
    <div class="li-head">
      <span class="badge t-${item.type}">${TYPE_LABEL[item.type] ?? item.type}</span>
      <span class="li-title" title="${esc(item.title)}">${esc(item.title)}</span>
      ${item.verify_status === "unsure" ? '<span class="warn-badge">待核对</span>' : ""}
      ${item.verify_status === "dead" ? '<span class="warn-badge" style="color:#dc2626;border-color:#fecaca">已失效</span>' : ""}
    </div>
    <div class="li-body">${listPreview(item, payload)}</div>
    <div class="li-foot">
      <button data-edit="${item.id}">编辑</button>
      <button class="del" data-del="${item.id}">删除</button>
    </div>
  </div>`;
}

function renderList() {
  const groups = [];
  const map = new Map();
  for (const it of state.items) {
    if (!map.has(it.article_id)) {
      const g = { id: it.article_id, article: it.article, items: [] };
      map.set(it.article_id, g);
      groups.push(g);
    }
    map.get(it.article_id).items.push(it);
  }
  const notice = state.loadingItems
    ? `<div class="list-status" role="status">正在加载卡片…</div>`
    : state.itemError ? `<div class="list-status load-error" role="status">${esc(state.itemError)} <button class="mini-btn" data-reload-items>重新加载</button></div>` : "";
  $("#list").innerHTML = notice + (
    groups
      .map((g) => {
        const isCollapsed = collapsedGroups.has(g.id);
        const sub = [g.article?.account, `${g.items.length} 张卡片`].filter(Boolean).join(" · ");
        return `<div class="group">
          <div class="group-head" data-gtoggle="${esc(g.id)}" data-article="${esc(g.id)}" title="${esc(g.article?.summary || g.article?.title || "")}">
            <span class="caret ${isCollapsed ? "closed" : ""}">▾</span>
            <div class="group-texts">
              <div class="group-title">${esc(g.article?.title ?? "未知来源")}</div>
              <div class="group-sub">${esc(sub)}</div>
              ${g.article?.summary ? `<div class="group-sum">${esc(g.article.summary)}</div>` : ""}
            </div>
          </div>
          ${isCollapsed ? "" : `<div class="group-items">${g.items.map(itemHtml).join("")}</div>`}
        </div>`;
      })
      .join("") || (state.loadingItems ? "" : `<div class="empty">没有匹配的卡片</div>`));
}

/* ---------- 右侧详情 ---------- */
function articleImages(aid) {
  if (!imgCache.has(aid)) {
    imgCache.set(
      aid,
      fetch(`/api/article-images?id=${encodeURIComponent(aid)}`)
        .then((r) => r.json())
        .then((d) => d.images ?? [])
        .catch(() => [])
    );
  }
  return imgCache.get(aid);
}

function renderDetail() {
  const item = selectedItem();
  const el = $("#detail");
  if (!item) {
    el.innerHTML = `<div class="empty">选择左侧卡片查看详情</div>`;
    return;
  }
  const payload = safeParse(item.payload);
  const head = `
    <div class="d-head">
      <span class="badge t-${item.type}">${TYPE_LABEL[item.type] ?? item.type}</span>
      <h2>${esc(item.title)}</h2>
      ${item.verify_status === "unsure" ? '<span class="warn-badge">待核对</span>' : ""}
      ${item.verify_status === "dead" ? '<span class="warn-badge" style="color:#dc2626;border-color:#fecaca">已失效</span>' : ""}
    </div><hr class="d-hr">`;
  const source = item.article
    ? `<div class="d-foot"><span>来源：</span><a href="${esc(item.article.url)}" target="_blank" rel="noopener">${esc(item.article.title)}（${esc(item.article.account)}）</a>
       <button class="mini-btn" data-edit="${item.id}">编辑</button></div>`
    : "";
  let body = "";

  if (item.type === "palette") {
    const colors = payload.colors ?? [];
    body = `
      ${payload.desc ? `<p class="d-desc">${esc(payload.desc)}</p>` : ""}
      <div class="d-swatches">${colors.map((c) => `<button class="swatch" style="background:${esc(c.hex)}" data-copy="${esc(c.hex)}" data-hex="${esc(c.hex)}"></button>`).join("")}</div>
      <div class="d-hexes">${colors.map((c) => `<button class="hexcode" data-copy="${esc(c.hex)}">${esc(c.hex)}</button>`).join("")}</div>
      <div class="d-actions"><button class="mini-btn" data-copy="${esc(colors.map((c) => c.hex).join(" "))}">复制全部色值</button></div>`;
  } else if (item.type === "website" || item.type === "repo") {
    const detail = safeParse(item.verify_detail);
    const status = detail.status ? `<span class="url-status">${detail.status === 404 || detail.status === 410 ? "已失效" : detail.status}</span>` : "";
    body = `
      ${payload.desc ? `<p class="d-desc">${esc(payload.desc)}</p>` : ""}
      <div class="d-url" data-copy="${esc(payload.url ?? "")}"><span>${esc(payload.url ?? "")}</span>${status}</div>
      <div class="d-actions">
        <a class="mini-btn" href="${esc(payload.url ?? "#")}" target="_blank" rel="noopener">打开 ↗</a>
        <button class="mini-btn" data-copy="${esc(payload.url ?? "")}">复制网址</button>
      </div>`;
  } else if (item.type === "prompt") {
    body = `
      <div class="d-prompt" data-copy="${esc(payload.text ?? "")}">${esc(payload.text ?? "")}</div>
      <div class="d-actions" style="margin-top:10px"><button class="mini-btn" data-copy="${esc(payload.text ?? "")}">复制提示词</button></div>`;
  } else if (item.type === "note") {
    const sections = payload.sections ?? [];
    const outline = sections.length > 1
      ? `<div class="d-note-outline">${sections.map((s, i) => `<button class="chip" data-notejump="${item.id}-${i}">${esc(s.heading || `第${i + 1}节`)}</button>`).join("")}</div>`
      : "";
    const md = sections.map((s) => `## ${s.heading}\n` + (s.bullets ?? []).map((b) => `- ${b}`).join("\n")).join("\n\n");
    body = `
      ${outline}
      ${sections.map((s, i) => `<div class="note-section" id="note-${item.id}-${i}">
        ${s.heading ? `<h4>${esc(s.heading)}</h4>` : ""}
        <ul>${(s.bullets ?? []).map((b) => `<li>${esc(b)}</li>`).join("")}</ul>
      </div>`).join("")}
      <div class="d-actions"><button class="mini-btn" data-copy="${esc(md)}">复制为 Markdown</button></div>`;
  }

  el.innerHTML = `${head}${body}<img id="detail-img" class="detail-img hidden" data-srcimg="${item.article_id}" alt="来源原图（点击放大）">
    <div id="gallery" class="gallery hidden">
      <div class="gallery-title">文章全部轮播图（左右切换，点击放大）</div>
      <div class="gallery-main">
        <button class="g-btn g-prev" title="上一张">‹</button>
        <img id="gallery-img" alt="轮播图">
        <button class="g-btn g-next" title="下一张">›</button>
        <span class="g-counter" id="g-counter"></span>
      </div>
    </div>${source}`;

  // 异步取来源原图；有 bbox 时按区域裁剪，点开放大看完整图
  articleImages(item.article_id).then((files) => {
    if (state.selectedId !== item.id) return;
    const img = document.getElementById("detail-img");
    const gal = document.getElementById("gallery");
    if (!gal) return;
    if (!files.length) { img?.remove(); gal.remove(); return; }
    const idx = Math.min(Number(item.source_image_index ?? 0), files.length - 1);
    const raw = files[idx];
    const bbox = safeParse(item.bbox, null);
    if (img) {
      if (Array.isArray(bbox) && bbox.length === 4 && bbox[2] > bbox[0] && bbox[3] > bbox[1]) {
        img.src = `/api/crop?article=${encodeURIComponent(item.article_id)}&idx=${idx}&x1=${bbox[0]}&y1=${bbox[1]}&x2=${bbox[2]}&y2=${bbox[3]}`;
      } else {
        img.src = raw;
      }
      img.dataset.full = raw;
      img.classList.remove("hidden");
    }
    // 轮播画廊：定位到当前卡对应的那张，可左右切换看全部
    gallery = { files, idx };
    gal.classList.remove("hidden");
    updateGallery();
  });
}

function updateGallery() {
  const img = document.getElementById("gallery-img");
  if (!img || !gallery.files.length) return;
  img.src = gallery.files[gallery.idx];
  const counter = $("#g-counter");
  if (counter) counter.textContent = `${gallery.idx + 1} / ${gallery.files.length}`;
}

function galleryMove(delta) {
  if (!gallery.files.length) return;
  gallery.idx = (gallery.idx + delta + gallery.files.length) % gallery.files.length;
  updateGallery();
}

/* ---------- 编辑弹窗 ---------- */
function colorRow(hex = "#000000", name = "") {
  return `<div class="row">
    <span class="swatch-mini" style="background:${esc(hex)}"></span>
    <input type="text" class="hex" value="${esc(hex)}" maxlength="7">
    <input type="text" class="name" placeholder="色名（可选）" value="${esc(name)}">
    <button class="del" onclick="this.parentElement.remove()">✕</button>
  </div>`;
}
window.addColorRow = () => {
  document.getElementById("color-rows").insertAdjacentHTML("beforeend", colorRow("#CCCCCC", ""));
};

function modalHtml(item) {
  const payload = safeParse(item.payload);
  let body = "";
  if (item.type === "palette") {
    body = `<label>说明（原文对这套配色的解释，可留空）</label><input type="text" id="f-desc" value="${esc(payload.desc ?? "")}">
      <label>颜色</label><div id="color-rows">${(payload.colors ?? []).map((c) => colorRow(c.hex, c.name ?? "")).join("")}</div>
      <button class="add-color" onclick="addColorRow()">＋ 添加颜色</button>`;
  } else if (item.type === "website" || item.type === "repo") {
    body = `<label>网址</label><input type="text" id="f-url" value="${esc(payload.url ?? "")}">
      <label>说明</label><input type="text" id="f-desc" value="${esc(payload.desc ?? "")}">`;
  } else if (item.type === "prompt") {
    body = `<label>提示词全文</label><textarea id="f-text" rows="10">${esc(payload.text ?? "")}</textarea>`;
  } else {
    const md = (payload.sections ?? []).map((s) => `## ${s.heading}\n${(s.bullets ?? []).map((b) => `- ${b}`).join("\n")}`).join("\n\n");
    body = `<label>笔记内容（## 小节标题，- 开头为要点）</label><textarea id="f-md" rows="14">${esc(md)}</textarea>`;
  }
  return `<div class="modal">
    <h3><span class="badge t-${item.type}">${TYPE_LABEL[item.type]}</span>编辑卡片</h3>
    <label>标题</label><input type="text" id="f-title" value="${esc(item.title)}">
    ${body}
    <div class="modal-actions">
      <button class="btn danger" id="m-delete">删除</button>
      <span style="flex:1"></span>
      <button class="btn" id="m-cancel">取消</button>
      <button class="btn primary" id="m-save">保存</button>
    </div>
  </div>`;
}

function openEditModal(id) {
  const item = state.items.find((it) => it.id === id);
  if (!item) return;
  settingsRequest++;
  const modal = $("#modal");
  modal.innerHTML = modalHtml(item);
  modal.classList.remove("hidden");
  modal.querySelector(".hex")?.addEventListener("input", (e) => {
    const row = e.target.closest(".row");
    row.querySelector(".swatch-mini").style.background = e.target.value;
  });
  $("#m-cancel").onclick = closeModal;
  $("#m-save").onclick = () => saveModal(item);
  $("#m-delete").onclick = () => deleteItem(id, true);
}

function closeModal() {
  settingsRequest++;
  const modal = $("#modal");
  modal.classList.add("hidden");
  modal.innerHTML = "";
}

/* ---------- 设置弹窗（API Key / Base URL / Model + 重跑提取） ---------- */
function openSettings(section) {
  const request = ++settingsRequest;
  return Promise.all([requestJSON("/api/config"), requestJSON("/api/articles")]).then(
    ([c, articles]) => {
      if (request !== settingsRequest) return;
      const modal = $("#modal");
      const rows = (Array.isArray(articles) ? articles : [])
        .map(
          (a) => `<label class="rep-row" style="display:flex;gap:8px;align-items:flex-start;font-weight:400;margin:4px 0">
          <input type="checkbox" class="rep-check" data-id="${esc(a.id)}" style="margin-top:4px">
          <span style="flex:1">${esc(a.title || a.id)}<span style="opacity:.6"> · ${esc(a.account || "")}</span></span>
        </label>`
        )
        .join("");
      modal.innerHTML = `<div class="modal">
      <h3>⚙ 设置 · 模型服务</h3>
      <label>API Key ${c.keyMasked ? `（当前 ${esc(c.keyMasked)}）` : "（必填）"}</label>
      <input type="password" id="s-key" placeholder="sk-…" value="">
      <label>Base URL</label>
      <input type="text" id="s-base" value="${esc(c.baseUrl ?? "")}">
      <label>模型</label>
      <input type="text" id="s-model" value="${esc(c.model ?? "")}">
      <div class="modal-hint">配置保存在本机。分析时会将文章文字与图片发给你配置的模型服务商。</div>
      <h3 style="margin-top:18px">手机收集（收件箱）</h3>
      <div class="modal-hint">iPhone 快捷指令 POST 到 VPS，本机自动拉取拆卡。部署见 <code>inbox/README.md</code>。</div>
      <label>收件箱 URL</label>
      <input type="text" id="s-inbox-url" placeholder="https://collect.example.com" value="${esc(c.inboxUrl ?? "")}">
      <label>Inbox Token ${c.inboxTokenSet ? "（已设置，留空则不改）" : "（必填）"}</label>
      <input type="password" id="s-inbox-token" placeholder="与 VPS 的 INBOX_TOKEN 相同" value="">
      <label style="display:flex;gap:8px;align-items:center;font-weight:400;margin-top:8px">
        <input type="checkbox" id="s-inbox-enabled" ${c.inboxEnabled ? "checked" : ""}> 启用手机收集
      </label>
      <label for="s-inbox-interval">检查间隔（秒）</label>
      <input type="number" id="s-inbox-interval" min="10" max="120" step="1" value="${esc(c.inboxIntervalSec ?? 30)}">
      <div id="inbox-status" class="modal-hint" role="status"></div>
      <div class="modal-hint" style="margin-top:12px">iPhone 快捷指令：POST 到收件箱 URL 下的 <code>/collect</code>，Header <code>Authorization: Bearer 你的token</code>，JSON body <code>{"url":"…"}</code>。服务器接收后会等待本机处理，接收成功不等于已经入库。</div>
      <div class="task-heading"><h3>收集任务</h3><button class="mini-btn" id="tasks-refresh" type="button">刷新状态</button></div>
      <div class="modal-hint">任务在后台处理，可关闭设置继续浏览。失败后可重试。</div>
      <div id="tasks-list" class="task-list"></div>
      <div id="inbox-failures" class="task-list"></div>
      <h3 style="margin-top:18px">重跑提取</h3>
      <div class="modal-hint">换模型后可对旧文章重新拆卡。将<strong>整篇替换</strong>该文全部卡片（含手改），需在线重抓原文。</div>
      <div style="max-height:180px;overflow:auto;border:1px solid var(--border,#ddd);border-radius:8px;padding:8px;margin-top:8px">
        ${rows || `<div class="empty">暂无文章</div>`}
      </div>
      <div class="modal-actions">
        <button class="btn" id="rep-select-all" type="button">全选</button>
        <span style="flex:1"></span>
        <button class="btn" id="s-cancel">取消</button>
        <button class="btn" id="rep-run" type="button">重跑选中</button>
        <button class="btn primary" id="s-save">保存</button>
      </div>
    </div>`;
      modal.classList.remove("hidden");
      $("#s-cancel").onclick = closeModal;
      $("#s-save").onclick = saveSettings;
      $("#rep-select-all").onclick = () => {
        const boxes = [...document.querySelectorAll(".rep-check")];
        const all = boxes.every((b) => b.checked);
        boxes.forEach((b) => (b.checked = !all));
      };
      $("#rep-run").onclick = () => {
        const ids = [...document.querySelectorAll(".rep-check:checked")].map((b) => b.dataset.id);
        void confirmAndReprocess(ids);
      };
      $("#tasks-refresh").onclick = () => refreshTaskPanel();
      renderTaskStatus();
      void refreshTaskPanel();
      if (section === "tasks") $("#tasks-list").scrollIntoView({ block: "center" });
      else $("#s-key").focus();
    }
  ).catch((error) => toast("无法打开设置：" + errorText(error)));
}

const TASK_LABEL = { queued: "等待处理", running: "正在处理", done: "已完成", failed: "失败可重试" };

function displayTime(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("zh-CN", { hour12: false });
}

function renderTaskStatus() {
  const active = state.tasks.filter((task) => task.status === "queued" || task.status === "running").length;
  const failed = state.tasks.filter((task) => task.status === "failed").length;
  $("#tasks-btn").textContent = state.taskError ? "任务 · 状态不可用" : active ? `任务 · ${active} 条处理中` : failed ? `任务 · ${failed} 条失败` : "任务";
  const list = $("#tasks-list");
  if (!list) return;
  list.innerHTML = (state.taskError ? `<div class="task-error" role="status">状态更新失败：${esc(state.taskError)}</div>` : "") +
    (state.tasks.map((task) => `<div class="task-row">
      <div class="task-info"><div class="task-title">${esc(task.title || task.url || "收集任务")}</div>
      <div class="task-meta"><span class="task-state ${esc(task.status)}">${esc(TASK_LABEL[task.status] || "状态未知")}</span>${task.result?.skipped ? " · 已收藏，未重复分析" : ""}${task.source === "inbox" ? " · 手机收集" : ""}${task.updatedAt ? " · " + esc(displayTime(task.updatedAt)) : ""}</div>
      ${task.error ? `<div class="task-error">${esc(errorText(task.error))}</div>` : ""}
      ${task.status === "failed" && task.source === "inbox" ? `<div class="task-meta">手机收件箱会自动重试；最终失败后，可在下方重新排队。</div>` : ""}</div>
      ${task.status === "failed" && task.source !== "inbox" ? `<button class="mini-btn" type="button" data-task-retry="${esc(task.id)}">重试</button>` : ""}
    </div>`).join("") || `<div class="task-empty">暂无收集任务</div>`);
  const inbox = state.inbox;
  const connection = $("#inbox-status");
  if (connection && inbox) {
    const labels = { disabled: "未启用", idle: "等待连接", connected: "已连接", error: "连接失败" };
    const status = !inbox.enabled ? "未启用" : !inbox.configured ? "尚未配置完整" : labels[inbox.connection] || "等待检查";
    connection.textContent = `收件箱：${status}` +
      (inbox.lastSuccessAt ? ` · 最近连通 ${displayTime(inbox.lastSuccessAt)}` : "") +
      (inbox.pendingAckCount ? ` · ${inbox.pendingAckCount} 条处理结果等待服务器确认` : "") +
      (inbox.lastError ? ` · ${errorText(inbox.lastError)}` : "");
  }
  const failures = $("#inbox-failures");
  if (failures) failures.innerHTML = remoteFailureMessage ? `<div class="task-error">${esc(remoteFailureMessage)}</div>` :
    remoteFailures.length ? `<div class="task-meta">手机收件箱中的失败条目</div>` + remoteFailures.map((item) => `<div class="task-row">
      <div class="task-info"><div class="task-title">${esc(item.url)}</div><div class="task-error">${esc(errorText(item.error || "处理失败"))}</div></div>
      <button class="mini-btn" type="button" data-inbox-retry="${esc(item.id)}">重新排队</button>
    </div>`).join("") : "";
}

async function refreshTasks() {
  if (taskPolling) return;
  taskPolling = true;
  try {
    const data = await requestJSON("/api/tasks");
    if (!Array.isArray(data.tasks)) throw new Error("任务状态返回格式不正确");
    const nextSnapshot = new Map(data.tasks.map((task) => [task.id, `${task.status}:${task.updatedAt ?? ""}`]));
    const completed = taskSnapshot ? data.tasks.filter((task) => task.status === "done" && taskSnapshot.get(task.id) !== nextSnapshot.get(task.id)) : [];
    state.tasks = data.tasks;
    state.inbox = data.inbox ?? null;
    state.taskError = "";
    renderTaskStatus();
    if (completed.length) {
      imgCache.clear();
      await loadBootstrap();
      await loadItems();
      if (state.itemError) {
        toast("任务已完成，卡片列表刷新失败，稍后会自动重试");
        return;
      }
      toast(completed.every((task) => task.result?.skipped) ? "链接已收藏，无需重复分析" : "收集任务已完成，卡片已更新");
    }
    // A completed revision is consumed only after its cards have refreshed successfully.
    taskSnapshot = nextSnapshot;
  } catch (error) {
    state.taskError = errorText(error);
    renderTaskStatus();
  } finally { taskPolling = false; }
}

async function refreshTaskPanel() {
  const button = $("#tasks-refresh");
  if (button) button.disabled = true;
  await refreshTasks();
  if (state.inbox?.configured) {
    try {
      const data = await requestJSON("/api/inbox/failed");
      remoteFailures = Array.isArray(data.items) ? data.items : [];
      remoteFailureMessage = data.supported === false ? "当前收件箱版本不支持查询失败条目，请更新服务器程序。" : "";
    } catch (error) { remoteFailureMessage = "收件箱失败记录读取失败：" + errorText(error); }
  } else { remoteFailures = []; remoteFailureMessage = ""; }
  renderTaskStatus();
  if (button?.isConnected) button.disabled = false;
}

async function retryTask(id, button, inbox = false) {
  button.disabled = true;
  try {
    if (inbox) await requestJSON("/api/inbox/retry", jsonPost({ id }));
    else await requestJSON(`/api/tasks/${encodeURIComponent(id)}/retry`, jsonPost({}));
    toast(inbox ? "已重新排队，等待本机拉取处理" : "已重新排队，等待处理");
    await refreshTaskPanel();
  } catch (error) { toast("重试未成功：" + errorText(error)); }
  finally { if (button.isConnected) button.disabled = false; }
}

async function confirmAndReprocess(ids) {
  if (!ids.length) {
    toast("请先勾选文章");
    return;
  }
  let cardN = 0;
  try {
    const arts = await fetch("/api/articles").then((r) => r.json());
    const map = new Map((Array.isArray(arts) ? arts : []).map((a) => [a.id, a.itemCount ?? 0]));
    cardN = ids.reduce((s, id) => s + (map.get(id) || 0), 0);
  } catch {
    cardN = 0;
  }
  const msg =
    ids.length === 1
      ? `将删除该文现有 ${cardN} 张卡片并重新提取，手动修改会丢失。确定重跑？`
      : `将删除所选 ${ids.length} 篇文章的现有 ${cardN} 张卡片并重新提取，手动修改会丢失。确定重跑？`;
  if (!confirm(msg)) return;
  let ok = 0,
    fail = 0;
  for (let i = 0; i < ids.length; i++) {
    toast(`重跑中 ${i + 1}/${ids.length}…`);
    try {
      const r = await fetch("/api/articles/reprocess", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [ids[i]] }),
      });
      const data = await r.json();
      const one = data.results?.[0];
      if (r.ok && one?.ok) {
        ok++;
        toast(`✔ ${one.title || ids[i]}（${i + 1}/${ids.length}）`);
      } else {
        fail++;
        toast(`✘ ${one?.error || data.error || "失败"}（${i + 1}/${ids.length}）`);
      }
    } catch (e) {
      fail++;
      toast(`✘ ${e.message || "失败"}（${i + 1}/${ids.length}）`);
    }
  }
  toast(fail ? `完成：成功 ${ok}，失败 ${fail}` : `重跑完成：${ok} 篇 ✔`);
  imgCache.clear();
  await loadBootstrap();
  await loadItems();
}

/* ---------- 文章右键菜单：重跑 / 删除 ---------- */
function closeArticleMenu() {
  $("#article-menu")?.remove();
}

async function confirmDeleteArticle(articleId) {
  let cardN = 0;
  let title = articleId;
  try {
    const arts = await fetch("/api/articles").then((r) => r.json());
    const a = (Array.isArray(arts) ? arts : []).find((x) => x.id === articleId);
    cardN = a?.itemCount ?? 0;
    title = a?.title || articleId;
  } catch {
    /* 用默认文案 */
  }
  if (!confirm(`将删除「${title}」的全部 ${cardN} 张卡片及文章记录，不可恢复。确定删除？`)) return;
  try {
    const r = await fetch(`/api/articles/${encodeURIComponent(articleId)}`, { method: "DELETE" });
    const data = await r.json();
    if (!r.ok) {
      toast(data.error || "删除失败");
      return;
    }
    toast("已删除该篇全部内容");
    imgCache.clear();
    await loadBootstrap();
    await loadItems();
  } catch (e) {
    toast(e.message || "删除失败");
  }
}

document.addEventListener("contextmenu", (e) => {
  closeArticleMenu();
  const head = e.target.closest?.("[data-article]");
  if (!head) return;
  e.preventDefault();
  const id = head.dataset.article;
  const menu = document.createElement("div");
  menu.id = "article-menu";
  menu.style.cssText = `position:fixed;z-index:1000;min-width:120px;background:var(--bg,#fff);border:1px solid var(--border,#ddd);border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.12);padding:4px`;
  menu.innerHTML = `
    <button type="button" data-menu="reprocess" style="display:block;width:100%;text-align:left;padding:8px 12px;border:0;background:none;cursor:pointer;border-radius:6px">重跑</button>
    <button type="button" data-menu="delete" style="display:block;width:100%;text-align:left;padding:8px 12px;border:0;background:none;cursor:pointer;border-radius:6px;color:#c0392b">删除</button>`;
  document.body.appendChild(menu);
  const x = Math.min(e.clientX, window.innerWidth - 140);
  const y = Math.min(e.clientY, window.innerHeight - 90);
  menu.style.left = x + "px";
  menu.style.top = y + "px";
  menu.querySelector('[data-menu="reprocess"]').onclick = () => {
    closeArticleMenu();
    void confirmAndReprocess([id]);
  };
  menu.querySelector('[data-menu="delete"]').onclick = () => {
    closeArticleMenu();
    void confirmDeleteArticle(id);
  };
});

document.addEventListener("click", (e) => {
  if (!e.target.closest?.("#article-menu")) closeArticleMenu();
});
window.addEventListener("blur", closeArticleMenu);

async function saveSettings() {
  const button = $("#s-save");
  if (button.disabled) return;
  const apiKey = $("#s-key").value.trim();
  const baseUrl = $("#s-base").value.trim();
  const model = $("#s-model").value.trim();
  const inboxUrl = $("#s-inbox-url").value.trim();
  const inboxToken = $("#s-inbox-token").value.trim();
  const inboxEnabled = $("#s-inbox-enabled").checked;
  const inboxIntervalSec = Number($("#s-inbox-interval").value);
  if (!Number.isInteger(inboxIntervalSec) || inboxIntervalSec < 10 || inboxIntervalSec > 120) {
    toast("检查间隔需为 10–120 秒的整数");
    return;
  }
  const patch = {
    baseUrl,
    model,
    inboxUrl,
    inboxEnabled,
    inboxIntervalSec,
  };
  if (apiKey) patch.apiKey = apiKey;
  if (inboxToken) patch.inboxToken = inboxToken;
  button.disabled = true;
  try {
    const saved = await requestJSON("/api/config", jsonPost(patch));
    closeModal();
    toast(saved.hasKey ? "已保存 ✔" : "已保存，但 API Key 为空");
    void refreshTasks();
  } catch (error) { toast("保存失败：" + errorText(error)); }
  finally { if (button.isConnected) button.disabled = false; }
}

$("#settings-btn").addEventListener("click", openSettings);
$("#tasks-btn").addEventListener("click", () => openSettings("tasks"));

async function saveModal(item) {
  const button = $("#m-save");
  if (button.disabled) return;
  const title = $("#f-title").value.trim();
  let payload;
  if (item.type === "palette") {
    const colors = [...document.querySelectorAll("#color-rows .row")]
      .map((row) => {
        let hex = row.querySelector(".hex").value.trim().replace(/^#*/, "").toUpperCase();
        if (/^[0-9A-F]{3}$/.test(hex)) hex = hex.split("").map((c) => c + c).join("");
        if (!/^[0-9A-F]{6}$/.test(hex)) return null;
        return { hex: "#" + hex, name: row.querySelector(".name").value.trim() || undefined };
      })
      .filter(Boolean);
    payload = { colors, desc: $("#f-desc").value.trim() };
  } else if (item.type === "website" || item.type === "repo") {
    payload = { url: $("#f-url").value.trim(), desc: $("#f-desc").value.trim() };
  } else if (item.type === "prompt") {
    payload = { text: $("#f-text").value };
  } else {
    const sections = [];
    for (const block of $("#f-md").value.split(/\n(?=## )/)) {
      const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
      if (!lines.length) continue;
      const heading = lines[0].replace(/^##\s*/, "").trim();
      const bullets = lines.slice(1).map((l) => l.replace(/^-\s*/, "").trim()).filter(Boolean);
      if (heading || bullets.length) sections.push({ heading, bullets });
    }
    payload = { sections };
  }
  button.disabled = true;
  try {
    await requestJSON(`/api/items/${encodeURIComponent(item.id)}`, { ...jsonPost({ title, payload }), method: "PATCH" });
    closeModal();
    toast("已保存 ✔");
    await loadItems();
  } catch (error) { toast("保存失败：" + errorText(error)); }
  finally { if (button.isConnected) button.disabled = false; }
}

async function deleteItem(id, fromModal = false) {
  if (!confirm("确定删除这张卡片？")) return;
  try {
    await requestJSON(`/api/items/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (fromModal) closeModal();
    toast("已删除");
    await loadBootstrap();
    await loadItems();
  } catch (error) { toast("删除失败：" + errorText(error)); }
}

/* ---------- 事件 ---------- */
document.addEventListener("click", async (e) => {
  const t = e.target;

  const retry = t.closest("[data-task-retry], [data-inbox-retry]");
  if (retry) { await retryTask(retry.dataset.taskRetry || retry.dataset.inboxRetry, retry, !!retry.dataset.inboxRetry); return; }
  if (t.closest("[data-reload-items]")) { await loadItems(); return; }

  const copyEl = t.closest("[data-copy]");
  if (copyEl) {
    e.stopPropagation();
    await copyText(copyEl.dataset.copy, "内容");
    return;
  }
  const gprev = t.closest(".g-prev");
  if (gprev) { galleryMove(-1); return; }
  const gnext = t.closest(".g-next");
  if (gnext) { galleryMove(1); return; }
  if (t.closest("#gallery-img")) {
    $("#lightbox-img").src = t.src;
    $("#lightbox").classList.remove("hidden");
    return;
  }
  const ghead = t.closest("[data-gtoggle]");
  if (ghead) {
    const id = ghead.dataset.gtoggle;
    if (collapsedGroups.has(id)) collapsedGroups.delete(id);
    else collapsedGroups.add(id);
    renderList();
    return;
  }
  const jump = t.closest("[data-notejump]");
  if (jump) {
    e.stopPropagation();
    document.getElementById(`note-${jump.dataset.notejump}`)?.scrollIntoView({ block: "start" });
    return;
  }
  const thumb = t.closest("#detail-img[data-srcimg]");
  if (thumb) {
    $("#lightbox-img").src = thumb.dataset.full || thumb.src;
    $("#lightbox").classList.remove("hidden");
    return;
  }
  const editBtn = t.closest("[data-edit]");
  if (editBtn) {
    e.stopPropagation();
    openEditModal(editBtn.dataset.edit);
    return;
  }
  const delBtn = t.closest("[data-del]");
  if (delBtn) {
    e.stopPropagation();
    await deleteItem(delBtn.dataset.del);
    return;
  }
  const tab = t.closest(".tab");
  if (tab) {
    const k = tab.dataset.k;
    if (k === "__unsure") state.verify = state.verify ? null : "unsure";
    else { state.type = k; state.verify = null; }
    renderTabs();
    loadItems();
    return;
  }
  const li = t.closest(".li");
  if (li) {
    state.selectedId = li.dataset.id;
    renderList();
    renderDetail();
    return;
  }
});

$("#lightbox").addEventListener("click", () => $("#lightbox").classList.add("hidden"));
$("#modal").addEventListener("click", (e) => { if (e.target.id === "modal") closeModal(); });

// 轮播图支持键盘左右切换
document.addEventListener("keydown", (e) => {
  const g = document.getElementById("gallery");
  if (!g || g.classList.contains("hidden")) return;
  if (e.key === "ArrowLeft") galleryMove(-1);
  if (e.key === "ArrowRight") galleryMove(1);
});

/* ---------- 左右栏宽拖拽 ---------- */
const aside = $("#list");
const savedW = Number(localStorage.getItem("listWidth"));
if (savedW >= 240 && savedW <= 720) aside.style.width = savedW + "px";

let dragging = false;
$("#splitter").addEventListener("mousedown", (e) => {
  dragging = true;
  document.body.style.userSelect = "none";
  e.preventDefault();
});
window.addEventListener("mousemove", (e) => {
  if (!dragging) return;
  aside.style.width = Math.min(720, Math.max(240, e.clientX)) + "px";
});
window.addEventListener("mouseup", () => {
  if (!dragging) return;
  dragging = false;
  document.body.style.userSelect = "";
  localStorage.setItem("listWidth", parseInt(aside.style.width, 10));
});

let searchTimer = null;
$("#search").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.q = e.target.value.trim(); loadItems(); }, 300);
});

/* ---------- 收集入口 ---------- */
$("#ingest-btn").addEventListener("click", () => doIngest());
$("#ingest-input").addEventListener("keydown", (e) => { if (e.key === "Enter") doIngest(); });

async function doIngest() {
  const input = $("#ingest-input");
  const btn = $("#ingest-btn");
  const url = input.value.trim();
  if (btn.disabled) return;
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "mp.weixin.qq.com" || !["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error();
  } catch { toast("请粘贴微信公众号文章链接"); return; }
  btn.disabled = true;
  btn.textContent = "提交中…";
  try {
    const data = await requestJSON("/api/tasks", jsonPost({ url }));
    if (!data.task?.id) throw new Error("服务未返回收集任务，请刷新任务状态确认");
    if (input.value.trim() === url) input.value = "";
    toast(data.task.status === "done" ? (data.task.result?.skipped ? "链接已收藏，无需重复分析" : "该收集任务已完成") : data.task.status === "running" ? "该链接正在处理，可继续浏览" : "已加入队列，等待处理");
    void refreshTasks();
  } catch (err) {
    toast("提交失败：" + errorText(err));
  } finally {
    btn.disabled = false;
    btn.textContent = "收集";
  }
}

loadBootstrap().then(async () => {
  await refreshTasks();
  await loadItems();
  setInterval(() => { if (!document.hidden) void refreshTasks(); }, 3000);
  // 首次使用：未配置 key 时自动弹出设置
  requestJSON("/api/config").then((c) => {
    if (!c.hasKey) { openSettings(); toast("请先配置 API Key"); }
  }).catch((error) => toast("配置读取失败：" + errorText(error)));
}).catch((error) => toast("启动加载失败：" + errorText(error)));
