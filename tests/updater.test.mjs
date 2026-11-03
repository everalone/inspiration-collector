import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createUpdater, selectRelease, selectManifest, compareVersions, RELEASE_API, MANIFEST_URL, prepareWindowsInstall } from '../src-electron/updater.mjs';

const binary = Buffer.from('MZ fixture executable bytes for update integrity checks');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function release({version='0.2.4',kind='Portable',bytes=binary,...changes} = {}) {
  const name = `InspirationCollector-${kind}-${version}.exe`;
  return {tag_name:`v${version}`,draft:false,prerelease:false,assets:[{name,state:'uploaded',size:bytes.length,digest:`sha256:${hash(bytes)}`,browser_download_url:`https://github.com/everalone/inspiration-collector/releases/download/v${version}/${name}`}],...changes};
}
function manifest(changes={}) {
  const source=release(changes);
  return {schemaVersion:1,version:source.tag_name.slice(1),assets:source.assets.map(asset=>({name:asset.name,size:asset.size,sha256:asset.digest.slice(7),url:asset.browser_download_url}))};
}
async function fixture(t, overrides = {}) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'inspiration-updater-'));
  t.after(() => fs.rm(temp, {recursive:true,force:true}));
  const executable = path.join(temp, 'collector.exe');
  await fs.writeFile(executable, 'old executable');
  const states = [], calls = [];
  const options = {currentVersion:'0.2.3',isPackaged:true,platform:'win32',arch:'x64',portableExecutable:executable,exePath:executable,userDataDir:temp,
    onChange:state => states.push(state),
    fetchImpl:async (url,init) => {calls.push({url,init});return url === MANIFEST_URL ? Response.json(manifest()) : new Response(binary, {headers:{'content-length':String(binary.length)}});},...overrides};
  return {updater:createUpdater(options),temp,executable,states,calls,options};
}
test('strict stable version comparison orders three-part releases and four-part revisions', () => {
  assert.equal(compareVersions('v0.10.0','0.2.9'),1);
  assert.equal(compareVersions('0.2.3','v0.2.3'),0);
  assert.equal(compareVersions('v0.2.4.1','0.2.4'),1);
  assert.equal(compareVersions('0.2.4.1','0.2.5'),-1);
  assert.equal(compareVersions('0.2.4.10','0.2.4.2'),1);
  assert.equal(compareVersions('0.2.4','0.2.4.0'),0);
  assert.equal(compareVersions('0.2.5','0.2.4.999'),1);
  for (const version of ['0.2.03','0.2.4-beta.1','1.2','1.2.3;exec','9007199254740992.0.0',
    '0.2.4.01','0.2.4.1.2','0.2.4.1-rc.1','0.2.4+1','0.2.4.9007199254740992',null, ['0.2.4']]) {
    assert.throws(() => compareVersions(version,'0.2.3'));
  }
});
test('release selection chooses correct kind and never downgrades', () => {
  assert.equal(selectRelease(release({version:'0.2.2'}),'0.2.3'),null);
  assert.equal(selectRelease(release({version:'0.2.3'}),'0.2.3'),null);
  assert.equal(selectRelease(release(),'0.2.3').kind,'portable');
  assert.equal(selectRelease(release({kind:'Setup'}),'0.2.3','setup').name,'InspirationCollector-Setup-0.2.4.exe');
});
test('four-part patch assets retain exact repository, tag, kind and filename validation', () => {
  const patch = release({version:'0.2.4.1'});
  assert.equal(selectRelease(patch,'0.2.4').name,'InspirationCollector-Portable-0.2.4.1.exe');
  assert.equal(selectRelease(patch,'0.2.4.1'),null);
  assert.equal(selectRelease(release({version:'0.2.4'}),'0.2.4.1'),null);
  assert.equal(selectRelease(release({version:'0.2.5'}),'0.2.4.1').version,'0.2.5');
  assert.equal(selectRelease(release({version:'0.2.4.1',kind:'Setup'}),'0.2.4','setup').name,'InspirationCollector-Setup-0.2.4.1.exe');
  for (const replacement of [
    patch.assets[0].browser_download_url.replace('/v0.2.4.1/','/v0.2.4/'),
    patch.assets[0].browser_download_url.replace('/everalone/','/other/'),
    patch.assets[0].browser_download_url.replace('-0.2.4.1.exe','-0.2.4+1.exe'),
  ]) {
    const altered=structuredClone(patch); altered.assets[0].browser_download_url=replacement;
    assert.throws(()=>selectRelease(altered,'0.2.4'),/来源不正确/);
  }
});
test('untrusted metadata, missing digests, incomplete uploads and ambiguous assets are rejected', () => {
  for (const changes of [{draft:true},{prerelease:true},{tag_name:'v0.2.4-rc.1'}]) assert.throws(() => selectRelease(release(changes),'0.2.3'));
  for (const change of [{digest:null},{digest:'sha256:abc'},{size:0},{size:600*1024*1024},{state:'new'},
    {browser_download_url:'https://evil.example/InspirationCollector-Portable-0.2.4.exe'},
    {browser_download_url:'https://github.com/other/project/releases/download/v0.2.4/InspirationCollector-Portable-0.2.4.exe'}]) {
    const item=release();Object.assign(item.assets[0],change);assert.throws(() => selectRelease(item,'0.2.3'));
  }
  const duplicate=release();duplicate.assets.push({...duplicate.assets[0]});assert.throws(() => selectRelease(duplicate,'0.2.3'));
});
test('static manifest requires correct schema, stable version and same-repository versioned asset', () => {
  assert.equal(selectManifest(manifest(),'0.2.3').version,'0.2.4');
  assert.equal(selectManifest(manifest({version:'0.2.4.1'}),'0.2.4').version,'0.2.4.1');
  for(const changes of [{schemaVersion:2},{version:'v0.2.4'},{version:'0.2.4-rc.1'},{version:'0.2.4+1'},{assets:[]}]) assert.throws(()=>selectManifest({...manifest(),...changes},'0.2.3'));
  const wrongVersion=manifest();wrongVersion.assets[0].url=wrongVersion.assets[0].url.replace('/v0.2.4/','/v0.2.5/');assert.throws(()=>selectManifest(wrongVersion,'0.2.3'));
});
test('only a missing static manifest falls back to legacy release API', async t => {
  const calls=[];
  const f=await fixture(t,{fetchImpl:async url=>{calls.push(url);return url===MANIFEST_URL?new Response('',{status:404}):Response.json(release());}});
  await f.updater.check();assert.equal(f.updater.getState().phase,'available');assert.deepEqual(calls,[MANIFEST_URL,RELEASE_API]);
  for(const status of [200,403,429,500]){
    const seen=[];const bad=await fixture(t,{fetchImpl:async url=>{seen.push(url);return new Response('invalid',{status});}});
    await assert.rejects(bad.updater.check());assert.deepEqual(seen,[MANIFEST_URL]);
  }
});
test('static manifest redirect chain remains constrained to GitHub release infrastructure', async t => {
  const f=await fixture(t,{fetchImpl:async url=>url===MANIFEST_URL?new Response(null,{status:302,headers:{location:'https://github.com/everalone/inspiration-collector/releases/download/v0.2.4/update.json'}}):Response.json(manifest())});
  await f.updater.check();assert.equal(f.updater.getState().phase,'available');
  const bad=await fixture(t,{fetchImpl:async()=>new Response(null,{status:302,headers:{location:'https://example.org/update.json'}})});
  await assert.rejects(bad.updater.check(),/来源不正确/);
});
test('unpackaged and non-x64 apps do not contact GitHub or attempt installation', async t => {
  for (const override of [{isPackaged:false},{platform:'darwin'},{arch:'arm64'}]) {
    const f=await fixture(t,override);await f.updater.check();await f.updater.download();await f.updater.install();
    assert.equal(f.updater.getState().phase,'unsupported');assert.equal(f.calls.length,0);
  }
});
test('checking only fetches public metadata without credentials and reports newer version', async t => {
  const f=await fixture(t);await f.updater.check();
  assert.equal(f.updater.getState().phase,'available');assert.equal(f.updater.getState().version,'0.2.4');
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].init.credentials,'omit');
  assert.equal(f.calls[0].init.headers.Authorization,undefined);
});
test('four-part patch flows through check, verified download and installation plan unchanged', async t => {
  let plan;
  const f=await fixture(t,{currentVersion:'0.2.4',
    fetchImpl:async url=>url===MANIFEST_URL?Response.json(manifest({version:'0.2.4.1'})):new Response(binary),
    prepareInstall:async value=>{plan=value;return{authorize:async()=>{},cancel:async()=>{}}}});
  await f.updater.check();
  assert.equal(f.updater.getState().version,'0.2.4.1');
  await f.updater.download();
  assert.equal(f.updater.getState().phase,'ready');
  await f.updater.install();
  assert.equal(plan.newVersion,'0.2.4.1');
  assert.equal(plan.sha256,hash(binary));
  assert.equal(path.basename(plan.source),'InspirationCollector-Portable-0.2.4.1.exe');
});
test('same or older latest release leaves current installation unchanged', async t => {
  const f=await fixture(t,{fetchImpl:async()=>Response.json(manifest({version:'0.2.2'}))});
  await f.updater.check();assert.equal(f.updater.getState().phase,'idle');assert.equal(f.updater.getState().version,null);
});
test('download verifies exact size, SHA256 and executable header before ready', async t => {
  const f=await fixture(t);await f.updater.check();await f.updater.download();
  assert.equal(f.updater.getState().phase,'ready');assert.equal(f.updater.getState().progress,100);
  const files=await fs.readdir(path.join(f.temp,'updates'),{recursive:true});
  const executable=files.find(name=>name.endsWith('.exe'));
  assert.deepEqual(await fs.readFile(path.join(f.temp,'updates',executable)),binary);
  assert.equal(files.some(name=>name.endsWith('.part')),false);
  assert.equal(await fs.readFile(f.executable,'utf8'),'old executable');
});
test('validated download cache resumes ready after app restart without downloading twice', async t => {
  const f=await fixture(t);await f.updater.check();await f.updater.download();
  const restarted=createUpdater(f.options);await restarted.check();assert.equal(restarted.getState().phase,'ready');
  assert.equal(f.calls.filter(call=>call.url!==MANIFEST_URL).length,1);
});
test('damaged download is rejected and incomplete files are removed', async t => {
  const f=await fixture(t,{fetchImpl:async url=>url===MANIFEST_URL?Response.json(manifest()):new Response(Buffer.alloc(binary.length))});
  await f.updater.check();await assert.rejects(f.updater.download(),/校验失败/);assert.equal(f.updater.getState().phase,'error');
  const files=await fs.readdir(path.join(f.temp,'updates'),{recursive:true});assert.equal(files.some(name=>name.endsWith('.exe')||name.endsWith('.part')),false);
});
test('truncated stream and matching-hash non-executable payload are rejected', async t => {
  for (const bytes of [binary.subarray(0,10),Buffer.from('not executable')]) {
    const f=await fixture(t,{fetchImpl:async url=>url===MANIFEST_URL?Response.json(bytes[0]===0x4d?manifest():manifest({bytes})):new Response(bytes)});
    await f.updater.check();await assert.rejects(f.updater.download(),/校验失败/);
  }
});
test('download follows only approved HTTPS GitHub CDN redirects', async t => {
  let downloads=0;
  const f=await fixture(t,{fetchImpl:async url=>url===MANIFEST_URL?Response.json(manifest()):++downloads===1?new Response(null,{status:302,headers:{location:'https://release-assets.githubusercontent.com/allowed/file'}}):new Response(binary)});
  await f.updater.check();await f.updater.download();assert.equal(downloads,2);assert.equal(f.updater.getState().phase,'ready');
  const denied=await fixture(t,{fetchImpl:async url=>url===MANIFEST_URL?Response.json(manifest()):new Response(null,{status:302,headers:{location:'http://127.0.0.1/private'}})});
  await denied.updater.check();await assert.rejects(denied.updater.download(),/来源不正确/);
});
test('metadata errors and oversized metadata produce bounded user-facing errors', async t => {
  for (const response of [new Response('',{status:429}),new Response('not-json'),new Response('x'.repeat(1024*1024+1))]) {
    const f=await fixture(t,{fetchImpl:async()=>response});await assert.rejects(f.updater.check());
    assert.equal(f.updater.getState().phase,'error');assert.ok(f.updater.getState().error.length<100);
  }
});
test('concurrent checks share a single request', async t => {
  let unblock;const gate=new Promise(resolve=>{unblock=resolve});let count=0;
  const f=await fixture(t,{fetchImpl:async()=>{count++;await gate;return Response.json(manifest());}});
  const a=f.updater.check(),b=f.updater.check();unblock();await Promise.all([a,b]);assert.equal(count,1);
});
test('active collection keeps update ready and cancels prepared helper without quitting', async t => {
  const events=[];const f=await fixture(t,{prepareInstall:async()=>{events.push('prepared');return{authorize:async()=>events.push('authorized'),cancel:async()=>events.push('cancelled')}},canInstall:async()=>{events.push('gate');return '正在收集，请稍后更新';},onBeforeQuit:async()=>events.push('quit')});
  await f.updater.check();await f.updater.download();await assert.rejects(f.updater.install(),/正在收集/);
  assert.deepEqual(events,['prepared','gate','cancelled']);assert.equal(f.updater.getState().phase,'ready');
});
test('installer helper is ready before maintenance gate, authorization and quit', async t => {
  const events=[];let plan;const f=await fixture(t,{prepareInstall:async value=>{plan=value;events.push('prepared');return{authorize:async()=>events.push('authorized'),cancel:async()=>events.push('cancelled')}},canInstall:async()=>{events.push('gate');return true;},onBeforeQuit:async()=>events.push('quit')});
  await f.updater.check();await f.updater.download();await f.updater.install();
  assert.deepEqual(events,['prepared','gate','authorized','quit']);assert.equal(plan.target,f.executable);
  assert.equal(plan.sha256,hash(binary));assert.equal(plan.kind,'portable');assert.equal(f.updater.getState().phase,'installing');
});
test('helper startup failure leaves current process running and downloaded update retryable', async t => {
  let quit=false,gate=false;const f=await fixture(t,{prepareInstall:async()=>{throw new Error('private path details')},canInstall:async()=>{gate=true;return true},onBeforeQuit:async()=>{quit=true}});
  await f.updater.check();await f.updater.download();await assert.rejects(f.updater.install(),/当前版本仍可使用/);
  assert.equal(quit,false);assert.equal(gate,false);assert.equal(f.updater.getState().phase,'ready');assert.doesNotMatch(f.updater.getState().error,/private/);
});
test('cached binary changed after download is rejected before installation preparation', async t => {
  let prepared=false;const f=await fixture(t,{prepareInstall:async()=>{prepared=true;throw new Error('must not run')}});
  await f.updater.check();await f.updater.download();
  const entries=await fs.readdir(path.join(f.temp,'updates'),{recursive:true});const file=entries.find(name=>name.endsWith('.exe'));
  await fs.writeFile(path.join(f.temp,'updates',file),'tampered');
  await assert.rejects(f.updater.install(),/校验失败/);assert.equal(prepared,false);assert.equal(f.updater.getState().phase,'error');
  await f.updater.download();assert.equal(f.updater.getState().phase,'ready');
});

test('Windows helper cancellation leaves original executable untouched and does not end the app', {skip:process.platform!=='win32',timeout:25_000}, async t => {
  const f=await fixture(t),planDir=path.join(f.temp,'plan');
  const source=path.join(f.temp,'new.exe');await fs.writeFile(source,binary);
  const dummy=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});
  await once(dummy,'spawn');
  t.after(()=>dummy.kill());
  const prepared=await prepareWindowsInstall({version:1,kind:'portable',source,target:f.executable,sha256:hash(binary),size:binary.length,processId:dummy.pid,launcherPid:null,planDir,newVersion:'0.2.4'});
  await prepared.cancel();
  let status;
  for(let i=0;i<50;i++){
    status=JSON.parse((await fs.readFile(path.join(planDir,'status.json'),'utf8')).replace(/^\uFEFF/,''));
    if(status.phase==='error')break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.equal(status.phase,'error');assert.equal(await fs.readFile(f.executable,'utf8'),'old executable');assert.equal(dummy.exitCode,null);
});
test('Windows portable helper rolls back a failed executable launch using the real file swap', {skip:process.platform!=='win32',timeout:25_000}, async t => {
  const f=await fixture(t),planDir=path.join(f.temp,'plan');
  const source=path.join(f.temp,'new.exe');await fs.writeFile(source,binary);
  const dummy=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});
  await once(dummy,'spawn');t.after(()=>dummy.kill());
  const prepared=await prepareWindowsInstall({version:1,kind:'portable',source,target:f.executable,sha256:hash(binary),size:binary.length,processId:dummy.pid,launcherPid:null,planDir,newVersion:'0.2.4'});
  await prepared.authorize();dummy.kill();
  let status;
  for(let i=0;i<100;i++){
    status=JSON.parse((await fs.readFile(path.join(planDir,'status.json'),'utf8')).replace(/^\uFEFF/,''));
    if(status.phase==='error')break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.equal(status.phase,'error');assert.equal(await fs.readFile(f.executable,'utf8'),'old executable');
  assert.deepEqual(await fs.readFile(source),binary);
});
test('Windows helper survives its actual creator exiting and restores old file on launch failure', {skip:process.platform!=='win32',timeout:25_000}, async t => {
  const f=await fixture(t),planDir=path.join(f.temp,'parent-exit-plan');
  const source=path.join(f.temp,'new.exe');await fs.writeFile(source,binary);
  const script=path.join(f.temp,'bootstrap.mjs');
  const plan={version:1,kind:'portable',source,target:f.executable,sha256:hash(binary),size:binary.length,launcherPid:null,planDir,newVersion:'0.2.4'};
  await fs.writeFile(script,`import {prepareWindowsInstall} from ${JSON.stringify(new URL('../src-electron/updater.mjs',import.meta.url).href)};\nconst p=${JSON.stringify(plan)};p.processId=process.pid;\nconst helper=await prepareWindowsInstall(p);await helper.authorize();\n`);
  const bootstrap=spawn(process.execPath,[script],{stdio:'ignore',windowsHide:true});
  const [exit]=await once(bootstrap,'exit');assert.equal(exit,0);
  let status;
  for(let i=0;i<100;i++){
    status=JSON.parse((await fs.readFile(path.join(planDir,'status.json'),'utf8')).replace(/^\uFEFF/,''));
    if(status.phase==='error')break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.equal(status.phase,'error');assert.equal(await fs.readFile(f.executable,'utf8'),'old executable');
});
