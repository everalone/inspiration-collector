// Run with Electron, not Node. Isolated visual checks; no API, DB or model calls.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'data/ui-check-20261113');
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'p016-components-')));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1440, height: 960, useContentSize: true, show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
  win.webContents.on('console-message', event => console.log(event.message));
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') && !details.url.startsWith('data:') }));
  let html = fs.readFileSync(path.join(root, 'viewer/index.html'), 'utf8')
    .replace(/<script[^>]*src=[^>]*><\/script>/g, '')
    .replace('<head>', `<head><base href="${pathToFileURL(path.join(root, 'viewer/')).href}">`);
  const fixture = path.join(out, 'fixture.html');
  fs.writeFileSync(fixture, html);
  await win.loadFile(fixture);
  await win.webContents.executeJavaScript(`
    window.fetch = async url => ({ok:true, json:async()=> {
      if(String(url).includes('/api/config')) return {hasKey:true};
      if(String(url).includes('/api/items')) return {items:[],total:0};
      if(String(url).includes('/api/bootstrap')) return {articles:[],typeCounts:{},articleCount:0};
      return {tasks:[],items:[],articles:[]};
    }});
    ${fs.readFileSync(path.join(root, 'viewer/app.js'), 'utf8')}
  `);
  await win.webContents.executeJavaScript(`new Promise(r=>setTimeout(r,100))`);
  const fixtureCode = `
    state.articles=[{id:'sample',title:'把日常风景，变成一组温柔的配色',account:'设计观察室',
      summary:'从街角、天空与植物中提取颜色，把灵感整理成随时可复用的设计笔记。',
      article_summary:'从街角、天空与植物中提取颜色，把灵感整理成随时可复用的设计笔记。',
      url:'https://mp.weixin.qq.com/s/fixture',created_at:'2026-11-12T00:00:00Z',
      itemCount:10,typeCounts:{palette:2,website:2,repo:2,prompt:2,note:2}}];
    state.bootstrap={articles:state.articles,typeCounts:{palette:2,website:2,repo:2,prompt:2,note:2},unsureCount:0};
    state.selectedArticleId='sample';state.loadingItems=false;renderTabs();renderList();renderDetail();
    document.body.classList.add('desktop');document.querySelector('#desktop-controls').hidden=false;
  `;
  await win.webContents.executeJavaScript(fixtureCode);
  const results = [];
  for (const [width,height] of [[1440,960],[980,640]]) {
    win.setContentSize(width,height);
    await win.webContents.executeJavaScript(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);
    const measures = await win.webContents.executeJavaScript(`(() => {
      const box=s=>{const e=document.querySelector(s),r=e.getBoundingClientRect(),c=getComputedStyle(e);return {w:r.width,h:r.height,radius:c.borderRadius,font:c.fontFamily,weight:c.fontWeight,color:c.color,border:c.borderColor}};
      return {header:box('header'),article:box('.article-card'),type:box('.type-summary-card'),input:box('#ingest-input'),collect:box('#ingest-btn'),search:box('#search'),tab:box('.tab.active'),settings:box('#settings-btn')};
    })()`);
    assert.equal(measures.article.w,328); assert.equal(measures.article.h,156);
    assert.equal(measures.type.w,180); assert.equal(measures.type.h,98);
    assert.equal(measures.input.h,36); assert.equal(measures.collect.h,40);
    assert.equal(measures.settings.h,32); assert.equal(measures.search.h,28);
    assert.ok(Math.abs(measures.header.h-208.4)<.1, JSON.stringify({width,height,measures}));
    const columns = await win.webContents.executeJavaScript(`(()=>{const cards=[...document.querySelectorAll('.type-summary-card')];return cards.filter(e=>e.offsetTop===cards[0].offsetTop).length})()`);
    assert.equal(columns,width===980?3:5);
    results.push({width,height,columns,...measures});
    fs.writeFileSync(path.join(out,`overview-${width}.png`),(await win.webContents.capturePage()).toPNG());
    // Sparse categories must not distribute themselves across the entire row.
    const sparse = await win.webContents.executeJavaScript(`(()=>{
      const grid=document.querySelector('.article-type-grid'),original=grid.innerHTML;
      while(grid.children.length>2)grid.lastElementChild.remove();
      const a=grid.children[0].getBoundingClientRect(),b=grid.children[1].getBoundingClientRect();
      const result={gap:b.left-a.right,left:a.left-grid.getBoundingClientRect().left};
      grid.innerHTML=original;return result;
    })()`);
    assert.equal(sparse.gap,8); assert.equal(sparse.left,0);
  }
  // Use Chromium mouse events: replacing the node on the first click breaks native dblclick.
  const parentBox = await win.webContents.executeJavaScript(`(async()=>{
    window.navigationItems=[{id:'palette-one',article_id:'sample',type:'palette',title:'配色一',payload:JSON.stringify({colors:[{hex:'#6FAEE0'}]})},
      {id:'note-one',article_id:'sample',type:'note',title:'笔记一',payload:JSON.stringify({sections:[]})}];
    window.fetch=async url=>({ok:true,json:async()=>{
      const u=new URL(url,'http://fixture');
      if(u.pathname==='/api/items'){const items=window.navigationItems.filter(i=>(!u.searchParams.get('type')||i.type===u.searchParams.get('type'))&&(!u.searchParams.get('articleId')||i.article_id===u.searchParams.get('articleId')));return {items,total:items.length};}
      if(u.pathname==='/api/article-images')return {images:[]};
      return {tasks:[],items:[]};
    }});
    await selectTopTab('palette');
    window.previewCard=document.querySelector('[data-select-article]');
    return window.previewCard.getBoundingClientRect().toJSON();
  })()`);
  await new Promise(r=>setTimeout(r,240));
  const hint=await win.webContents.executeJavaScript(`(()=>{const t=document.querySelector('#toast'),c=getComputedStyle(t);return {text:t.textContent,opacity:c.opacity,background:c.backgroundColor,shadow:c.boxShadow,font:c.fontSize,line:c.lineHeight,transition:c.transitionDuration,pointer:c.pointerEvents};})()`);
  assert.equal(hint.text,'单击预览卡片，双击可进入');assert.equal(hint.opacity,'1');assert.equal(hint.background,'rgb(36, 62, 80)');assert.equal(hint.shadow,'none');assert.equal(hint.font,'13px');assert.equal(hint.pointer,'none');
  await win.webContents.capturePage();
  fs.writeFileSync(path.join(out,'category-hint-980.png'),(await win.webContents.capturePage()).toPNG());
  const point={x:Math.round(parentBox.x+100),y:Math.round(parentBox.y+50),button:'left'};
  win.webContents.sendInputEvent({type:'mouseDown',...point,clickCount:1});
  win.webContents.sendInputEvent({type:'mouseUp',...point,clickCount:1});
  await new Promise(r=>setTimeout(r,40));
  const preview=await win.webContents.executeJavaScript(`({scope:state.articleScopeId,sameNode:window.previewCard===document.querySelector('[data-select-article]'),overview:!!document.querySelector('.article-overview')})`);
  assert.equal(preview.scope,null);assert.equal(preview.sameNode,true);assert.equal(preview.overview,true);
  win.webContents.sendInputEvent({type:'mouseDown',...point,clickCount:2});
  win.webContents.sendInputEvent({type:'mouseUp',...point,clickCount:2});
  await new Promise(r=>setTimeout(r,100));
  const entered=await win.webContents.executeJavaScript(`({scope:state.articleScopeId,ids:[...document.querySelectorAll('.li')].map(e=>e.dataset.id),parents:document.querySelectorAll('[data-select-article]').length})`);
  assert.equal(entered.scope,'sample');assert.deepEqual(entered.ids,['palette-one']);assert.equal(entered.parents,0);
  const fade=await win.webContents.executeJavaScript(`(async()=>{toast('单击预览卡片，双击可进入',260);await new Promise(r=>setTimeout(r,320));const midway=Number(getComputedStyle(toastEl).opacity);await new Promise(r=>setTimeout(r,220));return {midway,opacity:getComputedStyle(toastEl).opacity,visibility:getComputedStyle(toastEl).visibility,classes:toastEl.className,text:toastEl.textContent,animations:toastEl.getAnimations().map(a=>({time:a.currentTime,state:a.playState}))};})()`);
  assert.ok(fade.midway>0&&fade.midway<1, JSON.stringify({fade,hint}));assert.equal(fade.opacity,'0');assert.equal(fade.visibility,'hidden');
  fs.writeFileSync(path.join(out,'navigation-check.json'),JSON.stringify({preview,entered,hint,fade},null,2));
  await win.webContents.executeJavaScript(`state.items=[{id:1,article_id:'sample',type:'palette',title:'海岸线的五种蓝',payload:JSON.stringify({colors:['#173D57','#6FAEE0','#C6E4F5','#F7F1C8','#F3F8FB'].map(hex=>({hex}))}) }];state.selectedId=1;document.querySelector('#list').innerHTML=itemHtml(state.items[0]);openEditModal(1);`);
  const edit = await win.webContents.executeJavaScript(`(() => {const m=document.querySelector('.modal');m.scrollTop=m.scrollHeight;const b=document.querySelector('#m-save').getBoundingClientRect();return {modal:m.getBoundingClientRect().toJSON(),save:b.toJSON(),scroll:m.scrollHeight>m.clientHeight};})()`);
  assert.ok(edit.save.bottom<=640); assert.equal(edit.modal.width,560);
  fs.writeFileSync(path.join(out,'edit-980.png'),(await win.webContents.capturePage()).toPNG());
  await win.webContents.executeJavaScript(`(async()=>{
    closeModal();
    gallery.files=['data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="300"><rect width="600" height="300" fill="#6faee0"/></svg>')];
    document.querySelector('.gallery-main').classList.remove('hidden');updateGallery();
    await document.querySelector('#gallery-img').decode();
    document.querySelector('#gallery').scrollIntoView();
  })()`);
  const media = await win.webContents.executeJavaScript(`({height:document.querySelector('.gallery-viewport').getBoundingClientRect().height,button:document.querySelector('.g-btn').getBoundingClientRect().height,loaded:document.querySelector('#gallery-img').naturalWidth})`);
  assert.ok(Math.abs(media.height-371.2)<.1); assert.equal(media.button,40); assert.equal(media.loaded,600);
  fs.writeFileSync(path.join(out,'gallery-980.png'),(await win.webContents.capturePage()).toPNG());
  await win.webContents.executeJavaScript(`(async()=>{
    await openSettings();
    await new Promise(r=>setTimeout(r,50));
    window.failedFixture=[{id:'failed-phone',url:'https://mp.weixin.qq.com/s/phone-fixture',source:'inbox',status:'failed',error:'未获取到有效正文或图片，请检查原文是否可访问；已有内容未变更',inbox:{id:'phone',attempt:3,maxAttempts:3}},
      {id:'failed-manual',url:'https://mp.weixin.qq.com/s/manual-fixture',source:'manual',status:'failed',error:'模拟抓取失败'}];
    window.deleteCalls=0;
    window.fetch=async(url,options)=>{
      if(options?.method==='DELETE') { window.deleteCalls++; await new Promise(r=>setTimeout(r,100)); window.failedFixture=window.failedFixture.filter(t=>!url.endsWith(t.id)); }
      return {ok:true,json:async()=>({tasks:window.failedFixture,items:[],archived:1})};
    };
    state.tasks=window.failedFixture; renderTaskStatus();
    const m=document.querySelector('.modal'),heading=document.querySelector('.task-heading');
    m.style.scrollBehavior='auto';
    m.scrollTop+=heading.getBoundingClientRect().top-m.getBoundingClientRect().top-20;
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
  })()`);
  const taskActions = await win.webContents.executeJavaScript(`(()=>{
    const buttons=[...document.querySelectorAll('[data-task-delete]')];
    return buttons.map(b=>{const rect=b.getBoundingClientRect(),row=b.closest('.task-row'),message=row.querySelector('.task-record-message').getBoundingClientRect(),style=getComputedStyle(b);return {width:rect.width,height:rect.height,bottomGap:Math.abs(rect.bottom-message.bottom),noOverlap:message.right<=b.parentElement.getBoundingClientRect().left,right:Math.abs(rect.right-row.getBoundingClientRect().right),font:style.fontSize,radius:style.borderRadius,visible:rect.top>=0&&rect.bottom<=innerHeight&&!document.querySelector('#modal').classList.contains('hidden')};});
  })()`);
  assert.equal(taskActions.length,2);
  for(const action of taskActions) {assert.ok(action.noOverlap);assert.ok(action.bottomGap<1);assert.ok(action.visible);assert.ok(action.right<1);assert.equal(action.height,24);assert.equal(action.width,64);assert.equal(action.font,'10px');assert.equal(action.radius,'8px');}
  // A hidden window may retain the previous compositor frame until captured.
  await win.webContents.capturePage();
  await new Promise(resolve=>setTimeout(resolve,150));
  fs.writeFileSync(path.join(out,'task-delete-980.png'),(await win.webContents.capturePage()).toPNG());
  const longReport=await win.webContents.executeJavaScript(`(()=>{window.failedFixture[1].error='长错误报告字段说明与处理建议'.repeat(24);renderTaskStatus();const row=document.querySelector('[data-task-delete="failed-manual"]').closest('.task-row'),m=row.querySelector('.task-record-message'),a=row.querySelector('.task-record-actions'),mr=m.getBoundingClientRect(),ar=a.getBoundingClientRect();return {height:mr.height,noOverlap:mr.right<=ar.left,contained:m.scrollWidth<=m.clientWidth,bottom:Math.abs(mr.bottom-ar.bottom)};})()`);
  assert.ok(longReport.height>24);assert.ok(longReport.noOverlap);assert.ok(longReport.contained);assert.ok(longReport.bottom<1);
  const deleted = await win.webContents.executeJavaScript(`(async()=>{
    const b=document.querySelector('[data-task-delete="failed-phone"]');b.click();b.click();
    const pending=b.disabled;
    await new Promise(r=>setTimeout(r,200));
    return {pending,calls:window.deleteCalls,left:document.querySelectorAll('[data-task-delete]').length,label:document.querySelector('#tasks-btn').textContent};
  })()`);
  assert.equal(deleted.pending,true);assert.equal(deleted.calls,1);assert.equal(deleted.left,1);assert.match(deleted.label,/1 条失败/);
  fs.writeFileSync(path.join(out,'task-delete-check.json'),JSON.stringify({taskActions,longReport,deleted},null,2));
  fs.writeFileSync(path.join(out,'measurements.json'),JSON.stringify({results,edit},null,2));
  console.log('Component geometry and scroll checks passed');
  win.destroy(); app.quit();
}).catch(error=>{console.error(error);app.exit(1);});
