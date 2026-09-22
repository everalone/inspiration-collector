/* 灵感收集 · 左列表 + 右详情 */
"use strict";

const TYPE_LABEL = { palette: "配色", website: "网址", repo: "github", prompt: "提示词", note: "笔记" };
const state = { type: "all", q: "", verify: null, items: [], selectedId: null, bootstrap: null };
const imgCache = new Map(); // articleId -> Promise<string[]>
const collapsedGroups = new Set(); // 折叠的文章分组
let gallery = { files: [], idx: 0 };

const $ = (sel) => document.querySelector(sel);
const toastEl = $("#toast");
let toastTimer = null;

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

/* ---------- 数据 ---------- */
async function loadBootstrap() {
  const r = await fetch("/api/bootstrap");
  state.bootstrap = await r.json();
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
  const p = new URLSearchParams();
  if (state.type !== "all") p.set("type", state.type);
  if (state.q) p.set("q", state.q);
  if (state.verify) p.set("verify", state.verify);
  const r = await fetch("/api/items?" + p.toString());
  const data = await r.json();
  state.items = data.items;
  if (!state.items.some((it) => it.id === state.selectedId)) {
    state.selectedId = state.items[0]?.id ?? null;
  }
  renderList();
  renderDetail();
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
  $("#list").innerHTML =
    groups
      .map((g) => {
        const isCollapsed = collapsedGroups.has(g.id);
        const sub = [g.article?.account, `${g.items.length} 张卡片`].filter(Boolean).join(" · ");
        return `<div class="group">
          <div class="group-head" data-gtoggle="${esc(g.id)}" title="${esc(g.article?.summary || g.article?.title || "")}">
            <span class="caret ${isCollapsed ? "closed" : ""}">▾</span>
            <div class="group-texts">
              <div class="group-title">${esc(g.article?.title ?? "未知来源")}</div>
              <div class="group-sub">${esc(sub)}</div>
              ${g.article?.summary ? `<div class="group-sum">${esc(g.article.summary)}</div>` : ""}
            </div>
            <button type="button" class="btn rep-one" data-rep="${esc(g.id)}" title="重新提取本篇" style="margin-left:8px;flex-shrink:0">重跑</button>
          </div>
          ${isCollapsed ? "" : `<div class="group-items">${g.items.map(itemHtml).join("")}</div>`}
        </div>`;
      })
      .join("") || `<div class="empty">没有匹配的卡片</div>`;
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
  const modal = $("#modal");
  modal.innerHTML = modalHtml(item);
  modal.classList.remove("hidden");
  modal.querySelector(".hex")?.addEventListener("input", (e) => {
    const row = e.target.closest(".row");
    row.querySelector(".swatch-mini").style.background = e.target.value;
  });
  $("#m-cancel").onclick = closeModal;
  $("#m-save").onclick = () => saveModal(item);
  $("#m-delete").onclick = async () => {
    if (!confirm("确定删除这张卡片？")) return;
    await fetch(`/api/items/${id}`, { method: "DELETE" });
    closeModal();
    toast("已删除");
    loadBootstrap().then(loadItems);
  };
}

function closeModal() {
  const modal = $("#modal");
  modal.classList.add("hidden");
  modal.innerHTML = "";
}

/* ---------- 设置弹窗（API Key / Base URL / Model + 重跑提取） ---------- */
function openSettings() {
  Promise.all([fetch("/api/config").then((r) => r.json()), fetch("/api/articles").then((r) => r.json())]).then(
    ([c, articles]) => {
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
      <div class="modal-hint">保存在本机配置文件中，不会上传。任何 OpenAI 兼容的多模态模型服务均可。</div>
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
      $("#s-key").focus();
    }
  );
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

async function saveSettings() {
  const apiKey = $("#s-key").value.trim();
  const baseUrl = $("#s-base").value.trim();
  const model = $("#s-model").value.trim();
  const patch = { baseUrl, model };
  if (apiKey) patch.apiKey = apiKey;
  const r = await fetch("/api/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  const saved = await r.json();
  closeModal();
  toast(saved.hasKey ? "已保存 ✔" : "已保存，但 API Key 为空");
}

$("#settings-btn").addEventListener("click", openSettings);

async function saveModal(item) {
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
  await fetch(`/api/items/${item.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, payload }),
  });
  closeModal();
  toast("已保存 ✔");
  loadItems();
}

async function deleteItem(id) {
  if (!confirm("确定删除这张卡片？")) return;
  await fetch(`/api/items/${id}`, { method: "DELETE" });
  toast("已删除");
  loadBootstrap().then(loadItems);
}

/* ---------- 事件 ---------- */
document.addEventListener("click", async (e) => {
  const t = e.target;

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
  const repOne = t.closest("[data-rep]");
  if (repOne) {
    e.stopPropagation();
    await confirmAndReprocess([repOne.dataset.rep]);
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
  if (!url.includes("mp.weixin.qq.com")) { toast("请粘贴微信公众号文章链接"); return; }
  btn.disabled = true;
  btn.textContent = "提取中…";
  try {
    const r = await fetch("/api/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const data = await r.json();
    if (data.error) toast("✘ " + data.error);
    else {
      const counts = Object.entries(data.counts).map(([k, v]) => `${TYPE_LABEL[k]}×${v}`).join("，");
      toast(`✔ ${counts || "未提取到卡片"}${data.unsureCount ? `（${data.unsureCount} 待核对）` : ""}`);
      input.value = "";
      imgCache.clear();
      await loadBootstrap();
      await loadItems();
    }
  } catch (err) {
    toast("✘ " + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "收集";
  }
}

loadBootstrap().then(() => {
  loadItems();
  // 首次使用：未配置 key 时自动弹出设置
  fetch("/api/config").then((r) => r.json()).then((c) => {
    if (!c.hasKey) { openSettings(); toast("请先配置 API Key"); }
  });
});
