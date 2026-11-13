import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../viewer/app.js", import.meta.url), "utf8");
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

// Minimal DOM for browser-independent UI behavior tests. No user database or network is opened.
function harness(options = {}) {
  const elements = new Map();
  const documentEvents = new Map();
  const windowEvents = new Map();
  const add = (selector, props = {}) => {
    const classes = new Set();
    const attributes = new Map();
    const events = new Map();
    const element = { value: "", disabled: false, checked: false,
      style: {}, dataset: {}, children: [], isConnected: true, scrollTop: 0, scrollHeight: 1000, clientHeight: 500,
      addEventListener(name, listener) { events.set(name, listener); }, focus() {},
      setAttribute(name, value) { attributes.set(name, String(value)); },
      getAttribute(name) { return attributes.get(name) ?? null; },
      removeAttribute(name) { attributes.delete(name); },
      scrollTo(options) { this.scrollTop = typeof options === 'object' ? options.top || 0 : 0; }, scrollIntoView() {},
      querySelector() { return null; }, querySelectorAll() { return []; },
      appendChild() {}, remove() { this.isConnected = false; }, contains(node) { return node === this; },
      getBoundingClientRect() { return { width: 900, height: this.clientHeight, top: 0, left: 0 }; },
      insertAdjacentHTML(position, text) { this.innerHTML = position === 'afterbegin' ? text + this.innerHTML : this.innerHTML + text; },
      classList: { add: (...names) => names.forEach(name => classes.add(name)), remove: (...names) => names.forEach(name => classes.delete(name)), contains: (name) => classes.has(name),
        toggle(name, force) { if (force ?? !classes.has(name)) classes.add(name); else classes.delete(name); } },
      events };
    let text = '', html = '';
    Object.defineProperty(element, 'innerHTML', { get: () => html, set(value) { html = String(value); text = html.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'); } });
    Object.defineProperty(element, 'textContent', { get: () => text, set(value) { text = String(value); html = text; } });
    Object.assign(element, props);
    elements.set(selector, element);
    return element;
  };
  for (const id of ["toast", "list", "detail", "tabs", "settings-btn", "tasks-btn", "lightbox", "modal", "splitter", "search", "ingest-btn", "ingest-input", "reading-progress", "reading-progress-fill"]) add(`#${id}`);
  for (const selector of options.selectors || []) add(selector);
  const context = vm.createContext({
    document: { querySelector: (selector) => elements.get(selector) ?? null,
      getElementById: (id) => elements.get(`#${id}`) ?? null,
      querySelectorAll: () => [], addEventListener(name, listener) { documentEvents.set(name, listener); },
      createElement: name => add(`__created-${name}-${elements.size}`), body: { style: {} }, hidden: false },
    window: { addEventListener(name, listener) { windowEvents.set(name, listener); }, matchMedia: () => ({matches:false}) }, navigator: {}, localStorage: { getItem: () => null, setItem() {} },
    requestAnimationFrame: callback => { callback(); return 1; }, cancelAnimationFrame() {},
    ResizeObserver: class { observe() {} disconnect() {} },
    URL, URLSearchParams, setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1,
    confirm: () => true, fetch: options.fetch || (() => new Promise(() => {})),
  });
  vm.runInContext(source, context);
  return { context, elements, add, documentEvents, windowEvents, run: (code) => vm.runInContext(code, context) };
}

const card = (id) => ({ id, article_id: "article", type: "note", title: id, payload: "{}" });

test('each failed task offers record deletion and deleting updates rows and failure count', async () => {
  const h = harness(); h.add('#tasks-list');
  const button = h.add('#delete-fixture');
  h.run(`state.tasks=[{id:'phone',url:'a',source:'inbox',status:'failed'}, {id:'manual',url:'b',status:'failed'}, {id:'busy',url:'c',status:'running'}]; renderTaskStatus();`);
  const markup = h.elements.get('#tasks-list').innerHTML;
  assert.equal((markup.match(/data-task-delete=/g) || []).length, 2);
  assert.doesNotMatch(markup, /data-task-delete="busy"/);
  const calls = [];
  h.context.fetch = async (url, options) => { calls.push([url, options?.method]); return response(url === '/api/tasks/phone' ? {archived:3} : {tasks:[]}); };
  await h.run(`deleteTaskRecord('phone', document.querySelector('#delete-fixture'))`);
  assert.deepEqual(calls[0], ['/api/tasks/phone', 'DELETE']);
  assert.doesNotMatch(h.elements.get('#tasks-btn').textContent, /失败/);
  assert.match(h.elements.get('#tasks-list').innerHTML, /暂无收集任务/);
  assert.equal(button.disabled, false);
});

test('failed deletion retains the row and allows another click', async () => {
  const h = harness(); h.add('#tasks-list'); const button = h.add('#delete-fixture');
  h.run(`state.tasks=[{id:'failed',url:'a',status:'failed'}]; renderTaskStatus();`);
  h.context.fetch = async () => response({error:'disk full'}, 500);
  await h.run(`deleteTaskRecord('failed', document.querySelector('#delete-fixture'))`);
  assert.match(h.elements.get('#tasks-list').innerHTML, /data-task-delete="failed"/);
  assert.match(h.elements.get('#toast').textContent, /删除记录失败/);
  assert.equal(button.disabled, false);
});

test("failure panel identifies card fields, escapes titles, and stops promising retries at the limit", () => {
  const h = harness();
  h.add('#tasks-list'); h.add('#inbox-failures');
  h.run(`state.tasks = [{ id:'task', url:'article', source:'inbox', status:'failed', updatedAt:'2026-10-25T10:00:00Z', inbox:{id:'remote',attempt:3,maxAttempts:3},
    failureReport:{version:1,stage:'card_validation',batch:2,imageStart:9,imageEnd:15,issueCount:1,issues:[{cardIndex:4,cardTitle:'<script>bad</script>',cardType:'website',field:'payload.url',code:'invalid_url'}]}}]; renderTaskStatus();`);
  const markup = h.elements.get('#tasks-list').innerHTML;
  assert.match(markup, /第 2 批/);
  assert.match(markup, /第 4 张卡/);
  assert.match(markup, /payload.url/);
  assert.match(markup, /已停止自动重试/);
  assert.doesNotMatch(markup, /<script>|等待自动重试/);
  h.run(`state.tasks.push({id:'success',url:'article',status:'done',updatedAt:'2026-10-25T10:01:00Z'}); renderTaskStatus();`);
  assert.doesNotMatch(h.elements.get('#tasks-list').innerHTML, /失败报告|后续已成功导入|bad/);
  assert.match(h.elements.get('#tasks-btn').textContent, /已完成/);
});

test("two failed attempts followed by success disappear from task rows and failure badge", () => {
  const h = harness(); h.add('#tasks-list');
  h.run(`state.tasks = [
    {id:'success',url:'same',status:'done',title:'completed',updatedAt:'2026-11-01T10:02:00Z'},
    {id:'fail-two',url:'same',status:'failed',error:'old second error',updatedAt:'2026-11-01T10:01:00Z'},
    {id:'fail-one',url:'same',status:'failed',error:'old first error',updatedAt:'2026-11-01T10:00:00Z'}
  ]; renderTaskStatus();`);
  assert.match(h.elements.get('#tasks-btn').textContent, /已完成/);
  assert.doesNotMatch(h.elements.get('#tasks-list').innerHTML, /old first error|old second error|先前尝试失败/);
  assert.match(h.elements.get('#tasks-list').innerHTML, /completed/);
});

test("task badge counts unresolved articles instead of attempts and retains newer refresh failure", () => {
  const h = harness(); h.add('#tasks-list');
  h.run(`state.tasks = [
    {id:'duplicate',url:'same',status:'done',updatedAt:'2026-11-01T10:04:00Z',result:{skipped:true}},
    {id:'refresh',url:'same',refresh:true,status:'failed',error:'refresh is still failed',updatedAt:'2026-11-01T10:03:00Z'},
    {id:'fail-two',url:'another',status:'failed',error:'current failure',updatedAt:'2026-11-01T10:02:00Z'},
    {id:'fail-one',url:'another',status:'failed',error:'outdated failure',updatedAt:'2026-11-01T10:01:00Z'},
    {id:'saved',url:'same',status:'done',updatedAt:'2026-11-01T10:00:00Z'},
    {id:'unrelated-active',url:'third',status:'running'}
  ]; renderTaskStatus();`);
  assert.match(h.elements.get('#tasks-btn').textContent, /1 条处理中/);
  assert.match(h.elements.get('#tasks-btn').textContent, /2 条失败/);
  assert.match(h.elements.get('#tasks-list').innerHTML, /refresh is still failed|current failure/);
  assert.doesNotMatch(h.elements.get('#tasks-list').innerHTML, /outdated failure/);
});

test("durably archived failures do not revive when their success no longer appears in history", () => {
  const h = harness(); h.add('#tasks-list');
  h.run(`state.tasks = [{id:'archived',url:'old',status:'failed',error:'archived failure',resolvedBy:'pruned-success',resolvedAt:'2026-11-01T10:01:00Z'}]; renderTaskStatus();`);
  assert.equal(h.elements.get('#tasks-btn').textContent, '任务');
  assert.doesNotMatch(h.elements.get('#tasks-list').innerHTML, /archived failure/);
});

test("task history shows ten completions while preserving unresolved failures", () => {
  const h = harness(); h.add('#tasks-list');
  h.run(`state.tasks = [{id:'failed',url:'bad',status:'failed',error:'unresolved',updatedAt:'2026-11-01T11:00:00Z'},
    ...Array.from({length:14}, (_,i) => ({id:'done-'+i,url:'done-'+i,status:'done',title:'Completion '+i,updatedAt:new Date(Date.UTC(2026,10,1,10,i)).toISOString()}))]; renderTaskStatus();`);
  const html = h.elements.get('#tasks-list').innerHTML;
  assert.equal((html.match(/Completion /g) || []).length, 10);
  assert.match(html, /unresolved/);
  assert.doesNotMatch(html, /Completion 3<|Completion 0</);
});

test("clear completed records uses archive endpoint and preserves current failures", async () => {
  const h = harness(); h.add('#tasks-list'); h.add('#tasks-archive');
  const calls = [];
  h.context.fetch = async (path, options) => {
    calls.push([path, options?.method]);
    return response(path === '/api/tasks/archive' ? {archived:2} : {tasks:[{id:'failed',url:'bad',status:'failed',error:'still needs help'}]});
  };
  await h.run('archiveCompletedTasks()');
  assert.deepEqual(calls[0], ['/api/tasks/archive', 'POST']);
  assert.match(h.elements.get('#tasks-list').innerHTML, /still needs help/);
  assert.match(h.elements.get('#toast').textContent, /文章和卡片仍保留/);
  assert.equal(h.elements.get('#tasks-archive').disabled, false);
});

test("failed history clearing leaves existing rows and reports the error", async () => {
  const h = harness(); h.add('#tasks-list', {innerHTML:'existing history'}); h.add('#tasks-archive');
  h.context.fetch = async () => response({error:'cannot save'}, 500);
  await h.run('archiveCompletedTasks()');
  assert.equal(h.elements.get('#tasks-list').innerHTML, 'existing history');
  assert.match(h.elements.get('#toast').textContent, /清空记录失败/);
  assert.equal(h.elements.get('#tasks-archive').disabled, false);
});

test("card pagination loads beyond 500 and preserves filters on every page", async () => {
  const h = harness();
  const cards = Array.from({ length: 603 }, (_, i) => ({ ...card(String(i)), verify_status: 'unsure' }));
  const offsets = [];
  h.context.fetch = async (path) => {
    const params = new URL(path, "http://local.test").searchParams;
    assert.equal(params.get("limit"), "200");
    assert.equal(params.get("q"), "配色");
    assert.equal(params.get("type"), "note");
    assert.equal(params.get("verify"), "unsure");
    assert.equal(params.get("articleId"), "article");
    const offset = Number(params.get("offset"));
    offsets.push(offset);
    return response({ total: cards.length, items: cards.slice(offset, offset + 200) });
  };
  h.run('renderDetail = () => {}; state.articleScopeId = "article"; state.selectedArticleId = "article"; state.q = "配色"; state.type = "note"; state.verify = "unsure";');
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
  assert.match(tasks, /已停止自动重试/);
  assert.match(h.elements.get("#inbox-failures").innerHTML, /data-inbox-retry="remote-id"/);
});

// Deliberately fictional data exercises article navigation without reading a user profile.
function navigationFixture() {
  const h = harness();
  h.add('.stat');
  const counts = (overrides = {}) => ({ palette: 0, website: 0, repo: 0, prompt: 0, note: 0, ...overrides });
  const articles = [
    { id: 'spring', title: '春日 <配色>', account: '示例作者 A', summary: '轻盈、清晰的视觉笔记', itemCount: 3, typeCounts: counts({ note: 2, palette: 1 }), processed_at: '2026-11-02T08:00:00Z', fetched_at: '2026-11-01T08:00:00Z', url: 'https://mp.weixin.qq.com/s/fixture_spring' },
    { id: 'hierarchy', title: '信息层次', account: '示例作者 B', summary: '阅读与查找', itemCount: 2, typeCounts: counts({ note: 1, website: 1 }), processed_at: '2026-11-01T08:00:00Z', url: 'https://mp.weixin.qq.com/s/fixture_hierarchy' },
    { id: 'empty', title: '暂无卡片的文章', account: '', summary: '', itemCount: 0, typeCounts: counts(), fetched_at: '2026-10-31T08:00:00Z', url: 'https://mp.weixin.qq.com/s/fixture_empty' },
  ];
  const make = (id, article, type = 'note') => ({ id, article_id: article.id, type, title: `卡片 ${id}`, payload: JSON.stringify(type === 'note' ? { sections: [{ heading: '示例内容', bullets: ['第一条', '第二条'] }] } : type === 'palette' ? { colors: [{hex:'#6FAEE0'}] } : {url:'https://example.com'}), article });
  const data = { articles, items: [make('spring-note-1', articles[0]), make('spring-note-2', articles[0]), make('spring-palette', articles[0], 'palette'), make('hierarchy-note', articles[1]), make('hierarchy-website', articles[1], 'website')] };
  const bootstrap = { articles, typeCounts: counts({ note: 3, palette: 1, website: 1 }), articleCount: articles.length, unsureCount: 0 };
  h.run(`state.bootstrap = ${JSON.stringify(bootstrap)}; state.articles = ${JSON.stringify(articles)};`);
  const calls = [];
  h.context.fetch = async path => {
    calls.push(path);
    const url = new URL(path, 'http://local.test');
    if (url.pathname === '/api/bootstrap') return response({ ...bootstrap, articles: data.articles });
    if (url.pathname === '/api/article-images') return response({ images: [] });
    if (url.pathname === '/api/items') {
      const q = url.searchParams;
      const filtered = data.items.filter(item => (!q.get('articleId') || item.article_id === q.get('articleId')) && (!q.get('type') || item.type === q.get('type')) && (!q.get('q') || JSON.stringify(item).includes(q.get('q'))) && (!q.get('verify') || item.verify_status === q.get('verify')));
      const offset = Number(q.get('offset') || 0), limit = Number(q.get('limit') || 200);
      return response({ total: filtered.length, items: filtered.slice(offset, offset + limit) });
    }
    throw new Error(`unexpected fixture request: ${path}`);
  };
  return { ...h, data, calls };
}

test('all starts with only parent cards and an article overview with author, import time and type totals', async () => {
  const h = navigationFixture();
  await h.run('loadItems()');
  const list = h.elements.get('#list').innerHTML;
  assert.equal((list.match(/data-select-article=/g) || []).length, 3);
  assert.doesNotMatch(list, /data-id=|data-collapsed=/);
  assert.match(list, /示例作者 A/);
  assert.match(list, /3 张卡片/);
  assert.match(list, /轻盈、清晰的视觉笔记/);
  assert.equal(h.run('state.selectedId'), null);
  assert.equal(h.run('state.articleScopeId'), null);
  assert.equal(h.run('state.selectedArticleId'), 'spring');
  const detail = h.elements.get('#detail').innerHTML;
  assert.match(detail, /春日 &lt;配色&gt;/);
  assert.match(detail, /article-author">示例作者 A/);
  assert.ok(detail.includes(h.run(`displayTime('2026-11-02T08:00:00Z')`)));
  assert.match(detail, /data-article-type="note"[^>]*aria-label="查看本篇笔记 2 张卡片"/);
  await h.run(`selectArticle('empty')`);
  assert.equal(h.run('state.articleScopeId'), null);
  assert.match(h.elements.get('#detail').innerHTML, /暂无提取卡片/);
  assert.doesNotMatch(h.elements.get('#list').innerHTML, /data-id=/);
});

test('top type tabs keep parents on single click and scope children on double click', async () => {
  const h = navigationFixture();
  await h.run(`selectTopTab('note')`);
  assert.equal(h.run('state.articleScopeId'), null);
  assert.equal(h.elements.get('#toast').textContent, '单击预览卡片，双击可进入');
  let list = h.elements.get('#list').innerHTML;
  assert.equal((list.match(/data-select-article=/g) || []).length, 2);
  assert.doesNotMatch(list, /data-id=|data-article="empty"/);
  await h.run(`selectArticle('hierarchy')`);
  assert.equal(h.run('state.articleScopeId'), null);
  assert.equal(h.run('state.selectedId'), null);
  assert.equal(h.run('state.selectedArticleId'), 'hierarchy');
  assert.equal(h.elements.get('#list').innerHTML, list, 'preview must preserve DOM for native dblclick');
  assert.match(h.elements.get('#detail').innerHTML, /article-overview/);
  assert.ok(!h.calls.some(path => path.includes('articleId=hierarchy')));
  await h.documentEvents.get('dblclick')({target:{closest:()=>({dataset:{selectArticle:'hierarchy'}})},preventDefault(){}});
  assert.equal(h.run('state.articleScopeId'), 'hierarchy');
  assert.equal(h.run('state.selectedId'), 'hierarchy-note');
  list = h.elements.get('#list').innerHTML;
  assert.match(list, /data-id="hierarchy-note"/);
  assert.doesNotMatch(list, /data-id="spring|data-id="hierarchy-website"|data-select-article=/);
  assert.ok(h.calls.some(path => path.includes('articleId=hierarchy')));
  await h.run('backToArticles()');
  assert.equal(h.run('state.type'), 'note');
  assert.equal(h.run('state.articleScopeId'), null);
  assert.equal(h.run('state.selectedArticleId'), 'hierarchy');
  assert.doesNotMatch(h.elements.get('#list').innerHTML, /data-id=/);
  await h.run(`selectTopTab('all')`);
  assert.equal(h.run('state.articleScopeId'), null);
  assert.equal((h.elements.get('#list').innerHTML.match(/data-select-article=/g) || []).length, 3);
});

test('overview type cards enter only the selected article and clear stale searches', async () => {
  const h = navigationFixture();
  h.run(`state.q='old query'; state.articleScopeId='hierarchy'; state.selectedArticleId='hierarchy';`);
  h.elements.get('#search').value = 'old query';
  await h.run(`enterArticleType('spring', 'note')`);
  assert.equal(h.run('state.articleScopeId'), 'spring');
  assert.equal(h.run('state.selectedArticleId'), 'spring');
  assert.equal(h.run('state.q'), '');
  assert.equal(h.elements.get('#search').value, '');
  const list = h.elements.get('#list').innerHTML;
  assert.equal((list.match(/data-id=/g) || []).length, 2);
  assert.match(list, /data-id="spring-note-1"/);
  assert.doesNotMatch(list, /data-id="hierarchy|data-id="spring-palette"|data-select-article=/);
});

test('refresh preserves a valid selected child and scope, including empty search results', async () => {
  const h = navigationFixture();
  await h.run(`enterArticleType('spring', 'note')`);
  h.run(`state.selectedId='spring-note-2'`);
  await h.run('loadItems()');
  assert.equal(h.run('state.selectedId'), 'spring-note-2');
  h.data.items = h.data.items.filter(item => item.id !== 'spring-note-2');
  await h.run('loadItems()');
  assert.equal(h.run('state.selectedId'), 'spring-note-1');
  h.run(`state.q='no-such-text'`);
  await h.run('loadItems()');
  assert.equal(h.run('state.articleScopeId'), 'spring');
  assert.equal(h.run('state.selectedArticleId'), 'spring');
  assert.equal(h.run('state.selectedId'), null);
  assert.match(h.elements.get('#list').innerHTML, /当前文章没有匹配的笔记/);
  assert.doesNotMatch(h.elements.get('#list').innerHTML, /data-id="hierarchy/);
});

test('a late child response cannot move selection back to an article the reader has left', async () => {
  const h = navigationFixture();
  const fixtureFetch = h.context.fetch;
  let finishOld;
  h.context.fetch = path => path.startsWith('/api/items') && new URL(path, 'http://local.test').searchParams.get('articleId') === 'spring'
    ? new Promise(resolve => { finishOld = resolve; }) : fixtureFetch(path);
  const old = h.run(`enterArticleType('spring', 'note')`);
  await h.run(`enterArticleType('hierarchy', 'note')`);
  finishOld(response({ total: 2, items: h.data.items.filter(item => item.article_id === 'spring' && item.type === 'note') }));
  await old;
  assert.equal(h.run('state.articleScopeId'), 'hierarchy');
  assert.equal(h.run('state.selectedArticleId'), 'hierarchy');
  assert.equal(h.run('state.selectedId'), 'hierarchy-note');
  assert.match(h.elements.get('#list').innerHTML, /data-id="hierarchy-note"/);
  assert.doesNotMatch(h.elements.get('#list').innerHTML, /data-id="spring/);
});

test('a late bootstrap cannot restore an article removed by a newer catalogue refresh', async () => {
  const h = harness(); h.add('.stat');
  const pending = [];
  h.context.fetch = () => new Promise(resolve => pending.push(resolve));
  const older = h.run('loadBootstrap()'), newer = h.run('loadBootstrap()');
  pending[1](response({ articles: [], articleCount: 0, typeCounts: { note: 0 }, unsureCount: 0 }));
  await newer;
  pending[0](response({ articles: [{id:'removed',title:'Removed article',itemCount:1,typeCounts:{note:1}}], articleCount: 1, typeCounts: { note: 1 }, unsureCount: 0 }));
  await older;
  assert.equal(h.run('state.articles.length'), 0);
  assert.equal(h.run('state.bootstrap.typeCounts.note'), 0);
  assert.match(h.elements.get('.stat').textContent, /0 篇文章 · 0 张卡片/);
});

test('deleting the currently scoped article returns to remaining parents of the same category', async () => {
  const h = navigationFixture();
  await h.run(`enterArticleType('spring', 'note')`);
  const fixtureFetch = h.context.fetch;
  h.context.fetch = async (path, options) => {
    if (path === '/api/articles') return response(h.data.articles);
    if (path === '/api/articles/spring' && options?.method === 'DELETE') {
      h.data.articles = h.data.articles.filter(article => article.id !== 'spring');
      h.data.items = h.data.items.filter(item => item.article_id !== 'spring');
      return response({ok:true});
    }
    return fixtureFetch(path, options);
  };
  await h.run(`confirmDeleteArticle('spring')`);
  assert.equal(h.run('state.type'), 'note');
  assert.equal(h.run('state.articleScopeId'), null);
  assert.equal(h.run('state.selectedId'), null);
  assert.equal(h.run('state.selectedArticleId'), 'hierarchy');
  assert.match(h.elements.get('#list').innerHTML, /data-select-article="hierarchy"/);
  assert.doesNotMatch(h.elements.get('#list').innerHTML, /data-article="spring"|data-back-articles/);
});

test('an explicit article overview stays open during refresh until a child or category is selected', async () => {
  const h = navigationFixture();
  await h.run(`enterArticleType('spring', 'note')`);
  const overviewButton = {dataset:{articleOverview:'spring'}};
  await h.documentEvents.get('click')({target:{closest:selector=>selector === '[data-article-overview]' ? overviewButton : null}});
  assert.equal(h.run('state.selectedId'), null);
  assert.match(h.elements.get('#detail').innerHTML, /article-overview/);
  await h.run('loadItems()');
  assert.equal(h.run('state.articleScopeId'), 'spring');
  assert.equal(h.run('state.selectedId'), null);
  assert.match(h.elements.get('#detail').innerHTML, /article-overview/);
  const child = {dataset:{id:'spring-note-2'}};
  await h.documentEvents.get('click')({target:{closest:selector=>selector === '.li' ? child : null}});
  await h.run('loadItems()');
  assert.equal(h.run('state.selectedId'), 'spring-note-2');
  assert.doesNotMatch(h.elements.get('#detail').innerHTML, /class="article-overview"/);
  await h.run(`enterArticleType('spring', 'palette')`);
  assert.equal(h.run('state.selectedId'), 'spring-palette');
});

test('changing category does not display old category cards while the scoped request is pending', async () => {
  const h = navigationFixture();
  await h.run(`enterArticleType('spring', 'note')`);
  const fixtureFetch = h.context.fetch;
  let finish, requestedPath;
  h.context.fetch = path => path.startsWith('/api/items')
    ? new Promise(resolve => { finish = resolve; requestedPath = path; }) : fixtureFetch(path);
  const pending = h.run(`enterArticleType('spring', 'palette')`);
  const loadingList = h.elements.get('#list').innerHTML;
  assert.match(loadingList, /正在加载卡片/);
  assert.doesNotMatch(loadingList, /data-id="spring-note/);
  finish(await fixtureFetch(requestedPath));
  await pending;
  assert.match(h.elements.get('#list').innerHTML, /data-id="spring-palette"/);
});

test('parent search handles metadata and no results without retaining a hidden selection', async () => {
  const h = navigationFixture();
  h.run(`state.q='示例作者 B'`);
  await h.run('loadItems()');
  assert.equal(h.run('state.selectedArticleId'), 'hierarchy');
  assert.equal((h.elements.get('#list').innerHTML.match(/data-select-article=/g) || []).length, 1);
  h.run(`state.q='no-such-text'`);
  await h.run('loadItems()');
  assert.equal(h.run('state.selectedArticleId'), null);
  assert.match(h.elements.get('#list').innerHTML, /没有匹配的文章/);
  assert.match(h.elements.get('#detail').innerHTML, /选择左侧文章/);
});

test('article image lists accept local assets only and failed reads can be retried', async () => {
  const h = harness();
  let calls = 0;
  h.context.fetch = async () => ++calls === 1 ? response({ error: 'temporarily unavailable' }, 503) : response({ images: ['/assets/a/1.png', 'https://example.com/1.png', '//example.com/2.png', '/api/config', '/assets/a/" onload="bad', null, '/assets/a/2.svg'] });
  await assert.rejects(h.run(`articleImages('a')`), /temporarily unavailable/);
  const files = await h.run(`articleImages('a')`);
  assert.deepEqual(Array.from(files), ['/assets/a/1.png', '/assets/a/2.svg']);
  await h.run(`articleImages('a')`);
  assert.equal(calls, 2, 'successful images stay cached but failed requests do not');
});

test('an old article image response cannot overwrite the newly selected article gallery', async () => {
  const h = navigationFixture();
  h.add('#gallery'); h.add('#gallery-message'); h.add('#gallery-img'); h.add('#g-counter');
  const pending = new Map();
  h.context.fetch = path => new Promise(resolve => pending.set(new URL(path, 'http://local.test').searchParams.get('id'), resolve));
  h.run(`state.selectedArticleId='spring'; renderDetail()`);
  h.run(`state.selectedArticleId='hierarchy'; renderDetail()`);
  pending.get('hierarchy')(response({ images: ['/assets/hierarchy/current.png'] }));
  await new Promise(resolve => setImmediate(resolve));
  pending.get('spring')(response({ images: ['/assets/spring/obsolete.png'] }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.elements.get('#gallery-img').src, '/assets/hierarchy/current.png');
  assert.equal(h.run('gallery.files[0]'), '/assets/hierarchy/current.png');
  assert.match(h.elements.get('#detail').innerHTML, /信息层次/);
});

test('detached or replaced image callbacks cannot change the current gallery error or progress', () => {
  const h = harness();
  const oldImage = h.add('#gallery-img');
  const message = h.add('#gallery-message', {textContent:'current gallery'});
  h.run(`gallery={files:['/assets/old.png'],idx:0,busy:false};updateGallery()`);
  const staleError = oldImage.onerror, staleLoad = oldImage.onload;
  oldImage.isConnected = false;
  const currentImage = h.add('#gallery-img');
  h.run(`detailRevision++;gallery={files:['/assets/current.png','/assets/next.png'],idx:0,busy:false};updateGallery()`);
  const detail = h.elements.get('#detail');
  const fill = h.elements.get('#reading-progress-fill');
  detail.scrollTop = 250;
  staleError(); staleLoad();
  assert.equal(message.textContent, 'current gallery');
  assert.equal(fill.style.width, '0%');
  const previousSourceError = currentImage.onerror;
  h.run(`gallery.idx=1;updateGallery()`);
  message.textContent = 'new image';
  previousSourceError();
  assert.equal(message.textContent, 'new image');
  currentImage.onerror();
  assert.match(message.textContent, /这张图片暂时无法显示/);
  currentImage.onload();
  assert.equal(fill.style.width, '50%');
});

test('reading progress follows only the detail pane, clamps at its ends, and resets on selection', () => {
  const h = navigationFixture();
  const detail = h.elements.get('#detail'), fill = h.elements.get('#reading-progress-fill');
  detail.scrollHeight = 1500; detail.clientHeight = 500;
  detail.scrollTop = 500;
  assert.equal(h.run('updateReadingProgress()'), 50);
  assert.equal(fill.style.width, '50%');
  h.elements.get('#list').scrollTop = 5000;
  assert.equal(h.run('updateReadingProgress()'), 50);
  detail.scrollTop = 1000;
  assert.equal(h.run('updateReadingProgress()'), 100);
  assert.equal(h.elements.get('#reading-progress').getAttribute('aria-valuenow'), '100');
  detail.scrollTop = 5000;
  assert.equal(h.run('updateReadingProgress()'), 100);
  detail.scrollTop = -1;
  assert.equal(h.run('updateReadingProgress()'), 0);
  detail.scrollTop = 800;
  h.run(`state.selectedArticleId='spring'; renderDetail()`);
  assert.equal(detail.scrollTop, 0);
  assert.equal(fill.style.width, '0%');
  detail.scrollHeight = detail.clientHeight;
  assert.equal(h.run('updateReadingProgress()'), 0);
});

test('task pill shows processing, success and failure while the task panel remains accessible', () => {
  const h = harness(), button = h.elements.get('#tasks-btn');
  h.run(`state.tasks=[{id:'1',url:'a',status:'running'}]; renderTaskStatus()`);
  assert.equal(button.dataset.phase, 'processing');
  assert.match(button.innerHTML, /task-spinner/);
  assert.equal(button.getAttribute('aria-busy'), 'true');
  assert.equal(button.disabled, false);
  h.run(`var requestedSection; openSettings=(section)=>{requestedSection=section};`);
  button.events.get('click')();
  assert.equal(h.run('requestedSection'), 'tasks');
  h.run(`state.tasks=[{id:'1',url:'a',status:'done'}]; renderTaskStatus()`);
  assert.equal(button.dataset.phase, 'success');
  assert.match(button.textContent, /✓.*已完成/);
  h.run(`state.tasks=[{id:'1',url:'a',status:'failed'}]; renderTaskStatus()`);
  assert.equal(button.dataset.phase, 'failed');
  assert.match(button.textContent, /1 条失败/);
  assert.equal(button.disabled, false);
});

test('concurrent collect actions and an already queued link produce only one submission', async () => {
  const h = harness();
  const url = 'https://mp.weixin.qq.com/s/test_duplicate';
  const task = { id: 'pending', url, status: 'queued' };
  let finishPost, posts = 0;
  h.context.fetch = (path, options) => {
    if (options?.method === 'POST') { posts++; return new Promise(resolve => { finishPost = resolve; }); }
    return Promise.resolve(response({ tasks: [task], inbox: {enabled:false} }));
  };
  h.elements.get('#ingest-input').value = url;
  const first = h.run('doIngest()');
  await h.run('doIngest()');
  assert.equal(posts, 1);
  assert.equal(h.elements.get('#ingest-btn').disabled, true);
  assert.equal(h.elements.get('#tasks-btn').dataset.phase, 'processing');
  finishPost(response({task}, 202));
  await first;
  h.elements.get('#ingest-input').value = url + '?from=share#wechat_redirect';
  await h.run('doIngest()');
  assert.equal(posts, 1);
  assert.equal(h.elements.get('#ingest-btn').disabled, true);
  assert.match(h.elements.get('#ingest-btn').textContent, /已在处理中/);
  h.elements.get('#ingest-input').value = 'https://mp.weixin.qq.com/s/different_article';
  h.run('syncSubmitButton()');
  assert.equal(h.elements.get('#ingest-btn').disabled, false);
});

test('without an API key startup still loads saved articles, opens settings, and sends no collect request', async () => {
  const calls = [];
  const article = {id:'saved',title:'本机已保存文章',account:'示例作者',itemCount:0,typeCounts:{note:0}};
  const h = harness({
    selectors: ['.stat', '#s-cancel', '#s-save', '#s-key', '#rep-select-all', '#rep-run', '#tasks-refresh', '#tasks-archive', '#tasks-list'],
    fetch: async (path, options) => {
      calls.push([path, options?.method || 'GET']);
      if (path === '/api/bootstrap') return response({articles:[article],typeCounts:{note:0},articleCount:1,unsureCount:0});
      if (path.startsWith('/api/items')) return response({items:[],total:0});
      if (path.startsWith('/api/article-images')) return response({images:[]});
      if (path === '/api/tasks') return response({tasks:[],inbox:{enabled:false}});
      if (path === '/api/config') return response({hasKey:false,baseUrl:'http://127.0.0.1:1',model:'isolated'});
      if (path === '/api/articles') return response([article]);
      throw new Error(`unexpected startup request: ${path}`);
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(h.elements.get('#list').innerHTML, /本机已保存文章/);
  assert.match(h.elements.get('#modal').innerHTML, /设置 · 模型服务/);
  assert.equal(h.run('state.selectedArticleId'), 'saved');
  assert.equal(h.run('state.selectedId'), null);
  assert.ok(calls.every(([, method]) => method === 'GET'));
  assert.doesNotMatch(h.elements.get('#toast').textContent, /失败|无法打开/);
});
