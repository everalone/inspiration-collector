// Run with Electron, not Node. Isolated visual checks; no API, DB or model calls.
//   node_modules/.bin/electron scripts/verify-components.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'data/ui-check-20261124');
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'p016-components-')));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-device-scale-factor', '1');

const SKINS = ['paper', 'glass', 'slate'];
const MODES = ['light', 'dark'];

const articles = [
  { id: 'sample', title: '把日常风景，变成一组温柔的配色', account: '设计观察室',
    summary: '从街角、天空与植物中提取颜色，把灵感整理成随时可复用的设计笔记。',
    article_summary: '从街角、天空与植物中提取颜色，把灵感整理成随时可复用的设计笔记。',
    url: 'https://mp.weixin.qq.com/s/fixture', created_at: '2026-11-12T00:00:00Z',
    itemCount: 10, typeCounts: { palette: 2, website: 2, repo: 2, prompt: 2, note: 2 } },
  { id: 'second', title: '38 个让界面变高级的微交互细节', account: '交互笔记',
    summary: '从按钮回弹到列表错峰入场，这些 200 毫秒里发生的事决定了产品的质感。',
    article_summary: '从按钮回弹到列表错峰入场，这些 200 毫秒里发生的事决定了产品的质感。',
    url: 'https://mp.weixin.qq.com/s/second', created_at: '2026-11-11T00:00:00Z',
    itemCount: 4, typeCounts: { website: 2, note: 2 } },
];

const items = [
  { id: 'palette-one', article_id: 'sample', type: 'palette', title: '海岸线的五种蓝',
    payload: JSON.stringify({ colors: [{ hex: '#173D57' }, { hex: '#6FAEE0' }, { hex: '#C6E4F5' }] }) },
  { id: 'note-one', article_id: 'sample', type: 'note', title: '版式节奏笔记',
    payload: JSON.stringify({ sections: [] }) },
];

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1440, height: 960, useContentSize: true, show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
  win.webContents.on('console-message', event => {
    if (event.level === 'error') console.log('[console]', event.message);
  });
  win.webContents.session.webRequest.onBeforeRequest((details, callback) =>
    callback({ cancel: !details.url.startsWith('file:') && !details.url.startsWith('data:') }));

  let html = fs.readFileSync(path.join(root, 'viewer/index.html'), 'utf8')
    .replace(/<script[^>]*src=[^>]*><\/script>/g, '')
    .replace('<head>', `<head><base href="${pathToFileURL(path.join(root, 'viewer/')).href}">`);
  const fixture = path.join(out, 'fixture.html');
  fs.writeFileSync(fixture, html);
  await win.loadFile(fixture);
  await win.webContents.executeJavaScript(`
    ${fs.readFileSync(path.join(root, 'viewer/theme-init.js'), 'utf8')}
    window.fetch = async (url) => {
      const u = String(url);
      let data = { tasks: [], items: [], articles: [] };
      if (u.includes('/api/bootstrap')) data = { articles: ${JSON.stringify(articles)}, typeCounts: { palette: 2, website: 2, repo: 2, prompt: 2, note: 2 }, articleCount: 2, unsureCount: 0 };
      if (u.includes('/api/config')) data = { hasKey: true };
      if (u.includes('/api/items')) data = { items: [], total: 0 };
      if (u.includes('/api/article-images')) data = { images: [] };
      return { ok: true, status: 200, json: async () => data };
    };
    ${fs.readFileSync(path.join(root, 'viewer/app.js'), 'utf8')}
  `);
  await win.webContents.executeJavaScript(`new Promise(r=>setTimeout(r,100))`);

  const fixtureCode = skin => `
    document.documentElement.dataset.skin = '${skin}';
    document.documentElement.dataset.mode = 'light';
    state.articles = ${JSON.stringify(articles)};
    state.bootstrap = { articles: state.articles, typeCounts: { palette: 2, website: 2, repo: 2, prompt: 2, note: 2 }, unsureCount: 0 };
    state.selectedArticleId = 'sample'; state.loadingItems = false;
    renderTabs(); renderList(); renderDetail();
    document.body.classList.add('desktop'); document.querySelector('#desktop-controls').hidden = false;
  `;

  const results = [];
  for (const skin of SKINS) {
    for (const mode of MODES) {
      await win.webContents.executeJavaScript(fixtureCode(skin));
      await win.webContents.executeJavaScript(`document.documentElement.dataset.mode = '${mode}'`);
      for (const [width, height] of [[1440, 960], [980, 640]]) {
        win.setContentSize(width, height);
        await new Promise(r => setTimeout(r, 620));
        const m = await win.webContents.executeJavaScript(`(() => {
          const box = s => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect();
            return { w: Math.round(r.width), h: Math.round(r.height) }; };
          const list = document.querySelector('#list');
          const cs = getComputedStyle(list);
          const grid = document.querySelector('.article-type-grid');
          const cards = [...document.querySelectorAll('.type-summary-card')];
          return {
            header: box('header'), list: box('#list'), detail: box('#detail'),
            card: box('.article-card'), type: box('.type-summary-card'),
            input: box('#ingest-input'), collect: box('#ingest-btn'), search: box('#search'), settings: box('#settings-btn'),
            contentWidth: list.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
            listScrollX: list.scrollWidth - list.clientWidth,
            pageScrollX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            gridWidth: grid ? Math.round(grid.getBoundingClientRect().width) : 0,
            columns: cards.length ? cards.filter(e => e.offsetTop === cards[0].offsetTop).length : 0,
            titleFont: getComputedStyle(document.querySelector('.article-detail-title')).fontFamily,
            bodyBg: getComputedStyle(document.body).backgroundColor,
            listBg: getComputedStyle(list).backgroundColor,
          };
        })()`);
        assert.ok(m.header.h >= 120 && m.header.h <= 180, `header height ${m.header.h} ${skin}/${mode}/${width}`);
        assert.ok(Math.abs(m.card.w - m.contentWidth) < 2, `article card should fill list content: ${m.card.w} vs ${m.contentWidth}`);
        assert.ok(m.card.h >= 90 && m.card.h <= 240, `article height ${m.card.h}`);
        assert.equal(m.listScrollX, 0, `list horizontal overflow ${skin}/${mode}/${width}`);
        assert.equal(m.pageScrollX, 0, `page horizontal overflow ${skin}/${mode}/${width}`);
        assert.ok(m.columns >= 2, `type columns ${m.columns}`);
        assert.ok(m.type.w >= 110, `type card width ${m.type.w}`);
        assert.ok(m.type.h >= 50 && m.type.h <= 120, `type card height ${m.type.h}`);
        assert.ok(m.input.h >= 36 && m.input.h <= 38, `ingest height ${m.input.h}`);
        assert.ok(m.collect.h >= 36 && m.collect.h <= 38, `collect height ${m.collect.h}`);
        assert.ok(m.search.h >= 36 && m.search.h <= 38, `search height ${m.search.h}`);
        assert.equal(m.settings.h, 30);
        if (skin === 'paper') assert.match(m.titleFont, /Noto Serif SC/);
        if (mode === 'dark') assert.notEqual(m.bodyBg, 'rgb(247, 244, 236)');
        results.push({ skin, mode, width, height, ...m });
        fs.writeFileSync(path.join(out, `overview-${skin}-${mode}-${width}.png`), (await win.webContents.capturePage()).toPNG());
      }
    }
  }

  // Back to the default skin for interaction checks.
  await win.webContents.executeJavaScript(fixtureCode('paper'));
  win.setContentSize(980, 640);
  await win.webContents.executeJavaScript(`new Promise(r=>setTimeout(r,120))`);

  // Theme picker: switch skin and mode from the settings modal.
  const themeUi = await win.webContents.executeJavaScript(`(async () => {
    await openSettings();
    await new Promise(r => setTimeout(r, 60));
    const buttons = [...document.querySelectorAll('[data-skin-choice]')];
    const before = document.documentElement.dataset.skin;
    buttons.find(b => b.dataset.skinChoice === 'glass')?.click();
    const after = document.documentElement.dataset.skin;
    const pressed = buttons.map(b => [b.dataset.skinChoice, b.getAttribute('aria-pressed')]);
    const mode = document.querySelector('#s-ui-mode');
    mode.value = 'dark'; mode.dispatchEvent(new Event('change'));
    const darkMode = document.documentElement.dataset.mode;
    closeModal();
    return { count: buttons.length, before, after, pressed, darkMode };
  })()`);
  assert.equal(themeUi.count, 3);
  assert.equal(themeUi.before, 'paper'); assert.equal(themeUi.after, 'glass');
  assert.deepEqual(themeUi.pressed, [['paper', 'false'], ['glass', 'true'], ['slate', 'false']]);
  assert.equal(themeUi.darkMode, 'dark');
  await win.webContents.executeJavaScript(`window.setUiTheme?.({ skin: 'paper', mode: 'light' })`);

  // Category preview / double-click behaviour must keep the clicked node alive.
  await win.webContents.executeJavaScript(`(async () => {
    window.navigationItems = ${JSON.stringify(items)};
    window.fetch = async url => {
      const u = new URL(url, 'http://fixture');
      if (u.pathname === '/api/items') {
        const type = u.searchParams.get('type'), articleId = u.searchParams.get('articleId');
        const list = window.navigationItems.filter(i => (!type || i.type === type) && (!articleId || i.article_id === articleId));
        return { ok: true, json: async () => ({ items: list, total: list.length }) };
      }
      if (u.pathname === '/api/article-images') return { ok: true, json: async () => ({ images: [] }) };
      return { ok: true, json: async () => ({ tasks: [], items: [] }) };
    };
    await selectTopTab('palette');
    window.previewCard = document.querySelector('[data-select-article]');
    return window.previewCard.getBoundingClientRect().toJSON();
  })()`);
  await new Promise(r => setTimeout(r, 240));
  const hint = await win.webContents.executeJavaScript(`(() => {
    const t = document.querySelector('#toast'), c = getComputedStyle(t);
    return { text: t.textContent, opacity: c.opacity, visible: c.visibility, background: c.backgroundColor,
      font: c.fontSize, pointer: c.pointerEvents, entering: document.querySelector('#list').classList.contains('is-entering') };
  })()`);
  assert.equal(hint.text, '单击预览卡片，双击可进入');
  assert.equal(hint.opacity, '1'); assert.equal(hint.pointer, 'none');
  assert.notEqual(hint.background, 'rgba(0, 0, 0, 0)');
  fs.writeFileSync(path.join(out, 'category-hint-980.png'), (await win.webContents.capturePage()).toPNG());

  const parentBox = await win.webContents.executeJavaScript(`window.previewCard.getBoundingClientRect().toJSON()`);
  const point = { x: Math.round(parentBox.x + 100), y: Math.round(parentBox.y + 50), button: 'left' };
  win.webContents.sendInputEvent({ type: 'mouseDown', ...point, clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseUp', ...point, clickCount: 1 });
  await new Promise(r => setTimeout(r, 40));
  const preview = await win.webContents.executeJavaScript(`({scope: state.articleScopeId, sameNode: window.previewCard === document.querySelector('[data-select-article]'), overview: !!document.querySelector('.article-overview')})`);
  assert.equal(preview.scope, null); assert.equal(preview.sameNode, true); assert.equal(preview.overview, true);
  win.webContents.sendInputEvent({ type: 'mouseDown', ...point, clickCount: 2 });
  win.webContents.sendInputEvent({ type: 'mouseUp', ...point, clickCount: 2 });
  await new Promise(r => setTimeout(r, 100));
  const entered = await win.webContents.executeJavaScript(`({scope: state.articleScopeId, ids: [...document.querySelectorAll('.li')].map(e => e.dataset.id), parents: document.querySelectorAll('[data-select-article]').length})`);
  assert.equal(entered.scope, 'sample'); assert.deepEqual(entered.ids, ['palette-one']); assert.equal(entered.parents, 0);

  await win.webContents.executeJavaScript(`(async () => {
    state.items = ${JSON.stringify(items)};
    state.selectedId = 'palette-one';
    renderList(); renderDetail();
    openEditModal('palette-one');
    document.querySelector('.modal').scrollTop = 0;
  })()`);
  await new Promise(r => setTimeout(r, 260));
  const edit = await win.webContents.executeJavaScript(`(() => {
    const m = document.querySelector('.modal'); m.scrollTop = m.scrollHeight;
    const save = document.querySelector('#m-save').getBoundingClientRect();
    return { modal: m.getBoundingClientRect().toJSON(), save: save.toJSON(), scroll: m.scrollHeight > m.clientHeight };
  })()`);
  assert.ok(edit.save.bottom <= 640); assert.equal(Math.round(edit.modal.width), 560);
  fs.writeFileSync(path.join(out, 'edit-980.png'), (await win.webContents.capturePage()).toPNG());

  await win.webContents.executeJavaScript(`(async () => {
    closeModal();
    gallery.files = ['data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="300"><rect width="600" height="300" fill="#6faee0"/></svg>')];
    document.querySelector('.gallery-main').classList.remove('hidden');
    updateGallery();
    await document.querySelector('#gallery-img').decode();
    document.querySelector('#gallery').scrollIntoView();
  })()`);
  const media = await win.webContents.executeJavaScript(`({
    height: document.querySelector('.gallery-viewport').getBoundingClientRect().height,
    button: document.querySelector('.g-btn').getBoundingClientRect().height,
    loaded: document.querySelector('#gallery-img').naturalWidth,
    dragSupported: CSS.supports('transform', 'translateX(var(--drag, 0px))')
  })`);
  assert.ok(media.height >= 300 && media.height <= 540); assert.equal(media.button, 36); assert.equal(media.loaded, 600);
  assert.ok(media.dragSupported);
  fs.writeFileSync(path.join(out, 'gallery-980.png'), (await win.webContents.capturePage()).toPNG());

  await win.webContents.executeJavaScript(`(async () => {
    await openSettings();
    await new Promise(r => setTimeout(r, 50));
    window.failedFixture = [
      { id: 'failed-phone', url: 'https://mp.weixin.qq.com/s/phone', source: 'inbox', status: 'failed', error: '未获取到有效正文或图片，请检查原文是否可访问；已有内容未变更', inbox: { id: 'phone', attempt: 3, maxAttempts: 3 } },
      { id: 'failed-manual', url: 'https://mp.weixin.qq.com/s/manual', source: 'manual', status: 'failed', error: '模拟抓取失败' }];
    window.deleteCalls = 0;
    window.fetch = async (url, options) => {
      if (options?.method === 'DELETE') { window.deleteCalls++; window.failedFixture = window.failedFixture.filter(t => !url.endsWith(t.id)); }
      return { ok: true, json: async () => ({ tasks: window.failedFixture, items: [], archived: 1 }) };
    };
    state.tasks = window.failedFixture; renderTaskStatus();
    const m = document.querySelector('.modal'), heading = document.querySelector('.task-heading');
    m.style.scrollBehavior = 'auto';
    m.scrollTop += heading.getBoundingClientRect().top - m.getBoundingClientRect().top - 20;
    await new Promise(r => setTimeout(r, 300));
  })()`);
  const taskActions = await win.webContents.executeJavaScript(`(() => [...document.querySelectorAll('[data-task-delete]')].map(b => {
    const r = b.getBoundingClientRect(), row = b.closest('.task-row');
    const message = row.querySelector('.task-record-message').getBoundingClientRect();
    return { width: r.width, height: r.height, bottomGap: Math.abs(r.bottom - message.bottom),
      noOverlap: message.right <= b.parentElement.getBoundingClientRect().left,
      right: Math.abs(r.right - row.getBoundingClientRect().right), visible: r.top >= 0 && r.bottom <= innerHeight };
  }))()`);
  assert.equal(taskActions.length, 2);
  for (const action of taskActions) {
    assert.ok(action.noOverlap); assert.ok(action.bottomGap < 1); assert.ok(action.visible);
    assert.ok(action.right < 1); assert.equal(action.height, 24);
    assert.equal(action.width, action.width === 48 || action.width === 64 ? action.width : -1);
  }
  await win.webContents.capturePage();
  await new Promise(r => setTimeout(r, 150));
  fs.writeFileSync(path.join(out, 'task-delete-980.png'), (await win.webContents.capturePage()).toPNG());

  const deleted = await win.webContents.executeJavaScript(`(async () => {
    const b = document.querySelector('[data-task-delete="failed-phone"]'); b.click(); b.click();
    const pending = b.disabled;
    await new Promise(r => setTimeout(r, 200));
    return { pending, calls: window.deleteCalls, left: document.querySelectorAll('[data-task-delete]').length };
  })()`);
  assert.equal(deleted.pending, true); assert.equal(deleted.calls, 1); assert.equal(deleted.left, 1);

  // Update button states must be visually distinct (gradients included).
  const update = await win.webContents.executeJavaScript(`(() => {
    document.documentElement.dataset.skin = 'paper';
    document.documentElement.dataset.mode = 'light';
    const kill = document.createElement('style');
    kill.textContent = '#update-btn{transition:none!important}';
    document.head.appendChild(kill);
    const b = document.querySelector('#update-btn');
    const read = phase => {
      b.dataset.phase = phase;
      const c = getComputedStyle(b);
      return {
        sig: [c.backgroundImage, c.backgroundColor, c.color, c.borderColor, c.borderWidth].join('|'),
        color: c.color,
      };
    };
    const result = { idle: read('idle'), avail: read('available'), ready: read('ready') };
    kill.remove();
    return result;
  })()`);
  assert.notEqual(update.idle.sig, update.avail.sig);
  assert.notEqual(update.avail.sig, update.ready.sig);

  fs.writeFileSync(path.join(out, 'measurements.json'), JSON.stringify({ results, themeUi, hint, preview, entered, edit, media, taskActions, deleted, update }, null, 2));
  console.log('Component geometry, theme and interaction checks passed');
  win.destroy(); app.quit();
}).catch(error => { console.error(error); app.exit(1); });
