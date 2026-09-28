import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../viewer/app.js", import.meta.url), "utf8");
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

// Minimal DOM for browser-independent UI behavior tests. No user database or network is opened.
function harness() {
  const elements = new Map();
  const add = (selector, props = {}) => {
    const classes = new Set();
    const element = { value: "", textContent: "", innerHTML: "", disabled: false, checked: false,
      style: {}, dataset: {}, isConnected: true, addEventListener() {}, focus() {},
      insertAdjacentHTML(_position, text) { this.innerHTML += text; },
      classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name), contains: (name) => classes.has(name) },
      ...props };
    elements.set(selector, element);
    return element;
  };
  for (const id of ["toast", "list", "detail", "tabs", "settings-btn", "tasks-btn", "lightbox", "modal", "splitter", "search", "ingest-btn", "ingest-input"]) add(`#${id}`);
  const context = vm.createContext({
    document: { querySelector: (selector) => elements.get(selector) ?? null,
      getElementById: (id) => elements.get(`#${id}`) ?? null,
      querySelectorAll: () => [], addEventListener() {}, body: { style: {} }, hidden: false },
    window: { addEventListener() {} }, navigator: {}, localStorage: { getItem: () => null, setItem() {} },
    URL, URLSearchParams, setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1,
    confirm: () => true, fetch: () => new Promise(() => {}),
  });
  vm.runInContext(source, context);
  return { context, elements, add, run: (code) => vm.runInContext(code, context) };
}

const card = (id) => ({ id, article_id: "article", type: "note", title: id, payload: "{}" });

test("card pagination loads beyond 500 and preserves filters on every page", async () => {
  const h = harness();
  const cards = Array.from({ length: 603 }, (_, i) => card(String(i)));
  const offsets = [];
  h.context.fetch = async (path) => {
    const params = new URL(path, "http://local.test").searchParams;
    assert.equal(params.get("limit"), "200");
    assert.equal(params.get("q"), "配色");
    assert.equal(params.get("type"), "note");
    assert.equal(params.get("verify"), "unsure");
    const offset = Number(params.get("offset"));
    offsets.push(offset);
    return response({ total: cards.length, items: cards.slice(offset, offset + 200) });
  };
  h.run('renderDetail = () => {}; state.q = "配色"; state.type = "note"; state.verify = "unsure";');
  await h.run("loadItems()");
  assert.deepEqual(offsets, [0, 200, 400, 600]);
  assert.equal(h.run("state.items.length"), 603);
  assert.equal(h.run("state.selectedId"), "0");
  assert.match(h.elements.get("#list").innerHTML, /data-id="602"/);
  assert.equal(h.run("state.loadingItems"), false);
});

test("a late search response cannot overwrite the newest search", async () => {
  const h = harness();
  let finishOld;
  h.context.fetch = (path) => {
    const q = new URL(path, "http://local.test").searchParams.get("q");
    return q === "old" ? new Promise((resolve) => { finishOld = resolve; }) : Promise.resolve(response({ total: 1, items: [card("new")] }));
  };
  h.run('renderDetail = () => {}; state.q = "old";');
  const old = h.run("loadItems()");
  h.run('state.q = "new";');
  await h.run("loadItems()");
  finishOld(response({ total: 1, items: [card("old")] }));
  await old;
  assert.equal(h.run("state.items[0].id"), "new");
});

test("incomplete pagination reports an error rather than silently truncating", async () => {
  const h = harness();
  let calls = 0;
  h.context.fetch = async () => response({ total: 2, items: calls++ ? [] : [card("one")] });
  h.run("renderDetail = () => {};");
  await h.run("loadItems()");
  assert.equal(calls, 2);
  assert.match(h.elements.get("#list").innerHTML, /重新加载/);
  assert.match(h.elements.get("#toast").textContent, /未加载完整/);
});

test("submitting collection returns after queue acceptance and does not announce completion", async () => {
  const h = harness();
  h.elements.get("#ingest-input").value = "https://mp.weixin.qq.com/s/example";
  const calls = [];
  const task = { id: "task-1", status: "queued" };
  h.context.fetch = async (path, options) => {
    calls.push([path, options?.method]);
    return response(options?.method === "POST" ? { task } : { tasks: [task], inbox: { enabled: false } }, options?.method === "POST" ? 202 : 200);
  };
  await h.run("doIngest()");
  assert.equal(h.elements.get("#ingest-btn").disabled, false);
  assert.equal(h.elements.get("#ingest-input").value, "");
  assert.match(h.elements.get("#toast").textContent, /等待处理/);
  assert.doesNotMatch(h.elements.get("#toast").textContent, /已完成|已入库/);
  assert.deepEqual(calls[0], ["/api/tasks", "POST"]);
  assert.ok(calls.every(([path]) => path !== "/api/ingest"));
});

test("failed queue submission retains input and redacts credentials from errors", async () => {
  const h = harness();
  const url = "https://mp.weixin.qq.com/s/example";
  h.elements.get("#ingest-input").value = url;
  h.context.fetch = async () => response({ error: "Bad Bearer my-secret-token sk-private-example" }, 503);
  await h.run("doIngest()");
  assert.equal(h.elements.get("#ingest-input").value, url);
  assert.equal(h.elements.get("#ingest-btn").disabled, false);
  assert.match(h.elements.get("#toast").textContent, /提交失败/);
  assert.doesNotMatch(h.elements.get("#toast").textContent, /my-secret-token|sk-private-example/);
});

test("lookalike collection domains are rejected before making requests", async () => {
  const h = harness();
  h.elements.get("#ingest-input").value = "https://mp.weixin.qq.com.evil.test/s/example";
  h.context.fetch = () => { throw new Error("must not fetch"); };
  await h.run("doIngest()");
  assert.match(h.elements.get("#toast").textContent, /请粘贴/);
});

test("failed config save keeps the settings and entered values", async () => {
  const h = harness();
  for (const field of ["key", "base", "model", "inbox-url", "inbox-token", "inbox-enabled", "inbox-interval", "save"]) h.add(`#s-${field}`);
  h.elements.get("#s-key").value = "my-unchanged-key";
  h.elements.get("#s-inbox-interval").value = "45";
  h.elements.get("#modal").innerHTML = "settings";
  h.context.fetch = async (_path, options) => {
    assert.equal(JSON.parse(options.body).inboxIntervalSec, 45);
    return response({ error: "配置无法写入" }, 500);
  };
  await h.run("saveSettings()");
  assert.equal(h.elements.get("#modal").innerHTML, "settings");
  assert.equal(h.elements.get("#s-key").value, "my-unchanged-key");
  assert.equal(h.elements.get("#s-save").disabled, false);
  assert.match(h.elements.get("#toast").textContent, /保存失败/);
  assert.doesNotMatch(h.elements.get("#toast").textContent, /已保存/);
});

test("failed card update keeps the edit modal open", async () => {
  const h = harness();
  h.add("#m-save"); h.add("#f-title", { value: "edited title" }); h.add("#f-text", { value: "edited text" });
  h.elements.get("#modal").innerHTML = "edit form";
  h.context.fetch = async () => response({ error: "卡片不存在" }, 404);
  await h.run('saveModal({id: "missing", type: "prompt"})');
  assert.equal(h.elements.get("#modal").innerHTML, "edit form");
  assert.match(h.elements.get("#toast").textContent, /保存失败/);
});

test("completed tasks refresh cards exactly once per completed revision", async () => {
  const h = harness();
  h.run("var refreshCount = 0; loadBootstrap = async () => {}; loadItems = async () => { refreshCount++; };");
  let status = "queued";
  h.context.fetch = async () => response({ tasks: [{ id: "task", status, updatedAt: status }], inbox: { enabled: false } });
  await h.run("refreshTasks()");
  status = "done";
  await h.run("refreshTasks()");
  await h.run("refreshTasks()");
  assert.equal(h.run("refreshCount"), 1);
  assert.match(h.elements.get("#toast").textContent, /卡片已更新/);
});

for (const failingEndpoint of ["/api/bootstrap", "/api/items"]) {
  test(`completed task refresh retries after a temporary ${failingEndpoint} failure`, async () => {
    const h = harness();
    h.add(".stat");
    h.run("renderDetail = () => {};");
    let status = "running";
    let hasFailed = false;
    let cardRequests = 0;
    h.context.fetch = async (path) => {
      if (path === "/api/tasks") return response({ tasks: [{ id: "task", status, updatedAt: status }] });
      if (!hasFailed && path.startsWith(failingEndpoint)) {
        hasFailed = true;
        return response({ error: "临时不可用" }, 503);
      }
      if (path === "/api/bootstrap") return response({ typeCounts: { note: 1 }, articleCount: 1, unsureCount: 0 });
      if (path.startsWith("/api/items")) {
        cardRequests++;
        return response({ total: 1, items: [card("collected-card")] });
      }
      throw new Error(`unexpected request: ${path}`);
    };
    await h.run("refreshTasks()");
    status = "done";
    await h.run("refreshTasks()");
    assert.equal(hasFailed, true);
    assert.equal(h.run("state.items.length"), 0);
    await h.run("refreshTasks()");
    assert.equal(h.run("state.items[0].id"), "collected-card");
    assert.match(h.elements.get("#toast").textContent, /卡片已更新/);
    await h.run("refreshTasks()");
    assert.equal(cardRequests, 1, "successful refresh must not repeat on every poll");
  });
}

test("inbox acknowledgement pending is shown separately from processing failure", () => {
  const h = harness();
  h.add("#tasks-list"); h.add("#inbox-status"); h.add("#inbox-failures");
  h.run('state.inbox = {enabled: true, configured: true, connection: "connected", pendingAckCount: 2}; renderTaskStatus();');
  assert.match(h.elements.get("#inbox-status").textContent, /2 条处理结果等待服务器确认/);
  assert.doesNotMatch(h.elements.get("#inbox-status").textContent, /处理失败|已入库/);
});

test("inbox failures can only be retried through the inbox, while manual failures offer direct retry", () => {
  const h = harness();
  h.add("#tasks-list"); h.add("#inbox-failures");
  h.run(`state.tasks = [
    {id: "inbox-task", source: "inbox", status: "failed", url: "https://mp.weixin.qq.com/s/inbox"},
    {id: "manual-task", source: "manual", status: "failed", url: "https://mp.weixin.qq.com/s/manual"}
  ]; remoteFailures = [{id: "remote-id", url: "https://mp.weixin.qq.com/s/inbox"}]; renderTaskStatus();`);
  const tasks = h.elements.get("#tasks-list").innerHTML;
  assert.doesNotMatch(tasks, /data-task-retry="inbox-task"/);
  assert.match(tasks, /data-task-retry="manual-task"/);
  assert.match(tasks, /手机收件箱会自动重试/);
  assert.match(h.elements.get("#inbox-failures").innerHTML, /data-inbox-retry="remote-id"/);
});
