import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { parseReleaseVersion } from './version.mjs';

export const RELEASE_API = 'https://api.github.com/repos/everalone/inspiration-collector/releases/latest';
const RELEASE_ROOT = 'https://github.com/everalone/inspiration-collector/releases/';
export const MANIFEST_URL = `${RELEASE_ROOT}latest/download/update.json`;
const MAX_BINARY = 512 * 1024 * 1024;
const ERRORS = {
  unsupported: '此运行方式暂不支持应用内更新，请使用 Windows x64 正式安装版或便携版。',
  network: '连接 GitHub 更新服务失败，请稍后重试。',
  rate_limit: 'GitHub 更新检查暂时达到频率限制，请稍后重试。',
  metadata: '更新信息不完整或格式不正确，未下载任何程序。',
  source: '更新文件来源不正确，已停止下载。',
  integrity: '更新文件校验失败，请重新下载。',
  storage: '无法保存更新文件，请检查磁盘空间和当前用户的目录权限。',
  not_ready: '请先下载更新，再重启安装。',
  busy: '收集任务或回执仍在处理中，更新已保留，请稍后重启安装。',
  install: '更新程序未能启动，当前版本仍可使用，请稍后重试。',
  layout: '无法确认原安装位置，请使用安装版完成此次升级。',
  cancelled: '更新已取消。',
};
class UpdateError extends Error { constructor(code) { super(ERRORS[code] || ERRORS.install); this.code = code; } }
const failure = code => new UpdateError(code);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

export function parseVersion(value) {
  return parseReleaseVersion(value, { allowPrefix: true });
}
export function compareVersions(a, b) {
  const left = parseVersion(a), right = parseVersion(b);
  if (!left || !right) throw failure('metadata');
  for (let i = 0; i < 4; i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}
export function selectRelease(release, currentVersion, kind = 'portable') {
  if (!release || typeof release !== 'object' || release.draft !== false || release.prerelease !== false || !parseVersion(release.tag_name)) throw failure('metadata');
  if (compareVersions(release.tag_name, currentVersion) <= 0) return null;
  const version = release.tag_name.replace(/^v/, '');
  const name = `InspirationCollector-${kind === 'portable' ? 'Portable' : 'Setup'}-${version}.exe`;
  const matches = Array.isArray(release.assets) ? release.assets.filter(item => item?.name === name) : [];
  if (matches.length !== 1) throw failure('metadata');
  const asset = matches[0];
  const expectedUrl = `${RELEASE_ROOT}download/${release.tag_name}/${name}`;
  if (asset.browser_download_url !== expectedUrl) throw failure('source');
  if (asset.state !== 'uploaded' || !Number.isSafeInteger(asset.size) || asset.size < 2 || asset.size > MAX_BINARY || !/^sha256:[a-f0-9]{64}$/i.test(asset.digest || '')) throw failure('metadata');
  return { version, name, url: expectedUrl, size: asset.size, sha256: asset.digest.slice(7).toLowerCase(), kind };
}
export function selectManifest(manifest, currentVersion, kind = 'portable') {
  if (!manifest || manifest.schemaVersion !== 1 || typeof manifest.version !== 'string' || manifest.version.startsWith('v') || !parseVersion(manifest.version) || !Array.isArray(manifest.assets)) throw failure('metadata');
  return selectRelease({ tag_name: `v${manifest.version}`, draft: false, prerelease: false,
    assets: manifest.assets.map(asset => ({name: asset?.name, size: asset?.size, digest: `sha256:${asset?.sha256}`, browser_download_url: asset?.url, state: 'uploaded'})) }, currentVersion, kind);
}
function allowedDownloadUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return false;
    if (url.hostname === 'github.com') return url.href === MANIFEST_URL || url.href.startsWith(`${RELEASE_ROOT}download/`);
    return ['release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'github-releases.githubusercontent.com'].includes(url.hostname);
  } catch { return false; }
}
async function githubDownloadResponse(fetchImpl, initialUrl, signal) {
  let url = initialUrl;
  for (let count = 0; count <= 5; count++) {
    if (!allowedDownloadUrl(url)) throw failure('source');
    const response = await fetchImpl(url, { signal, redirect: 'manual', credentials: 'omit', headers: { 'User-Agent': 'InspirationCollector-Updater' } });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location || count === 5) throw failure('source');
    url = new URL(location, url).href;
  }
  throw failure('source');
}
async function boundedJson(response) {
  if (Number(response.headers.get('content-length') || 0) > 1024 * 1024) throw failure('metadata');
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body || []) {
    size += chunk.byteLength;
    if (size > 1024 * 1024) throw failure('metadata');
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw failure('metadata'); }
}
async function verifyFile(file, candidate) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== candidate.size) throw failure('integrity');
  const handle = await fs.open(file, 'r');
  try {
    const hash = crypto.createHash('sha256');
    let first = true;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      if (first && (chunk[0] !== 0x4d || chunk[1] !== 0x5a)) throw failure('integrity');
      first = false;
      hash.update(chunk);
    }
    if (hash.digest('hex') !== candidate.sha256) throw failure('integrity');
  } finally { await handle.close(); }
}
function executablePath(value) {
  return typeof value === 'string' && path.isAbsolute(value) && value.toLowerCase().endsWith('.exe') && !/[\r\n\0"]/u.test(value);
}

/** The helper does no mutation until its caller writes an authorization marker. */
export async function prepareWindowsInstall(plan, { spawnImpl = spawn, now = Date.now, timeoutMs = 15_000 } = {}) {
  const planDir = plan.planDir;
  await fs.mkdir(planDir, { recursive: true });
  const helperPath = path.join(planDir, 'update-helper.ps1');
  const planPath = path.join(planDir, 'plan.json');
  await fs.writeFile(helperPath, await fs.readFile(new URL('./update-helper.ps1', import.meta.url)), { mode: 0o600 });
  await fs.writeFile(planPath, JSON.stringify(plan), { mode: 0o600 });
  const helperEncoded = Buffer.from(helperPath, 'utf8').toString('base64');
  const planEncoded = Buffer.from(planPath, 'utf8').toString('base64');
  // Only fixed code and base64 path literals enter the command line. No policy settings are changed.
  const command = `$h=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${helperEncoded}')); $p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${planEncoded}')); & ([ScriptBlock]::Create([IO.File]::ReadAllText($h))) -PlanPath $p`;
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // Start-Process gives the helper its own hidden Windows console/lifetime. Node's
  // detached flag leaves Windows PowerShell without a usable console on some systems.
  const innerCommand = Buffer.from(command, 'utf16le').toString('base64');
  const launchCommand = `Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -WindowStyle Hidden -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-WindowStyle','Hidden','-EncodedCommand','${innerCommand}')`;
  const child = spawnImpl(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(launchCommand, 'utf16le').toString('base64')], { detached: false, stdio: 'ignore', windowsHide: true });
  let spawnError = false;
  child.once('error', () => { spawnError = true; });
  child.unref();
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    if (spawnError) throw failure('install');
    try {
      const status = JSON.parse((await fs.readFile(path.join(planDir, 'status.json'), 'utf8')).replace(/^\uFEFF/, ''));
      if (status.phase === 'ready') {
        return {
          authorize: () => fs.writeFile(path.join(planDir, 'authorized'), '1', { mode: 0o600 }),
          cancel: () => fs.writeFile(path.join(planDir, 'cancelled'), '1', { mode: 0o600 }),
        };
      }
      if (status.phase === 'error') throw failure(status.code === 'layout' ? 'layout' : 'install');
    } catch (error) { if (error instanceof UpdateError) throw error; if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw failure('install'); }
    await wait(100);
  }
  await fs.writeFile(path.join(planDir, 'cancelled'), '1').catch(() => {});
  throw failure('install');
}

export function createUpdater(options) {
  const { currentVersion, userDataDir, exePath, portableExecutable, onChange = () => {}, canInstall = async () => true, onBeforeQuit = async () => {} } = options;
  const platform = options.platform ?? process.platform, arch = options.arch ?? process.arch;
  const fetchImpl = options.fetchImpl ?? fetch;
  const prepareInstall = options.prepareInstall ?? prepareWindowsInstall;
  const supported = options.isPackaged === true && platform === 'win32' && arch === 'x64' && parseVersion(currentVersion) && executablePath(portableExecutable || exePath);
  const kind = portableExecutable ? 'portable' : 'setup';
  const cacheRoot = path.resolve(userDataDir, 'updates');
  let state = { phase: supported ? 'idle' : 'unsupported', currentVersion, version: null, progress: null, error: supported ? null : ERRORS.unsupported, checkedAt: null };
  let candidate = null, downloaded = null, busy = null, disposed = false, controller = null;
  const getState = () => ({ ...state });
  const update = patch => { state = { ...state, ...patch }; if (!disposed) onChange(getState()); return getState(); };
  const report = (error, phase = 'error') => {
    const message = error instanceof UpdateError ? error.message : ERRORS.network;
    update({ phase, error: message, progress: null });
    throw new Error(message);
  };
  const run = (operation, action) => {
    if (disposed) return Promise.reject(failure('cancelled'));
    if (!supported) return Promise.resolve(getState());
    if (busy) return busy;
    const work = Promise.resolve().then(action).finally(() => { if (busy === work) busy = null; });
    busy = work;
    return work;
  };
  async function check() {
    if (['downloading', 'installing', 'ready'].includes(state.phase)) return getState();
    return run('check', async () => {
      update({ phase: 'checking', error: null });
      controller = new AbortController();
      const timer = setTimeout(() => controller?.abort(), options.checkTimeoutMs ?? 20_000);
      try {
        const manifestResponse = await githubDownloadResponse(fetchImpl, MANIFEST_URL, controller.signal);
        if (manifestResponse.status === 404) {
          await manifestResponse.body?.cancel();
          const response = await fetchImpl(RELEASE_API, { headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'InspirationCollector-Updater' }, signal: controller.signal, redirect: 'manual', credentials: 'omit' });
          if (response.status === 403 || response.status === 429) throw failure('rate_limit');
          if (!response.ok) throw failure('network');
          candidate = selectRelease(await boundedJson(response), currentVersion, kind);
        } else {
          if (manifestResponse.status === 403 || manifestResponse.status === 429) throw failure('rate_limit');
          if (!manifestResponse.ok) throw failure('network');
          candidate = selectManifest(await boundedJson(manifestResponse), currentVersion, kind);
        }
        downloaded = null;
        if (!candidate) return update({ phase: 'idle', version: null, checkedAt: new Date().toISOString(), progress: null });
        const file = path.join(cacheRoot, `${candidate.version}-${candidate.sha256.slice(0, 16)}`, candidate.name);
        try { await verifyFile(file, candidate); downloaded = file; } catch { /* A missing/incomplete cache is downloaded on request. */ }
        return update({ phase: downloaded ? 'ready' : 'available', version: candidate.version, checkedAt: new Date().toISOString(), progress: downloaded ? 100 : null });
      } catch (error) { return report(error); }
      finally { clearTimeout(timer); controller = null; }
    });
  }
  async function download() {
    return run('download', async () => {
      if (!candidate) return report(failure('not_ready'));
      if (downloaded) return getState();
      const directory = path.join(cacheRoot, `${candidate.version}-${candidate.sha256.slice(0, 16)}`);
      const target = path.join(directory, candidate.name);
      const temporary = path.join(directory, `${candidate.name}.${crypto.randomUUID()}.part`);
      let handle;
      update({ phase: 'downloading', error: null, progress: 0 });
      controller = new AbortController();
      const timer = setTimeout(() => controller?.abort(), options.downloadTimeoutMs ?? 10 * 60_000);
      try {
        await fs.mkdir(directory, { recursive: true }).catch(() => { throw failure('storage'); });
        const response = await githubDownloadResponse(fetchImpl, candidate.url, controller.signal);
        if (!response?.ok) throw failure('network');
        const declared = response.headers.get('content-length');
        if (declared !== null && Number(declared) !== candidate.size) throw failure('integrity');
        handle = await fs.open(temporary, 'wx', 0o600);
        const hash = crypto.createHash('sha256');
        let received = 0, lastProgress = 0;
        for await (const chunk of response.body || []) {
          received += chunk.byteLength;
          if (received > candidate.size) throw failure('integrity');
          hash.update(chunk);
          await handle.write(chunk);
          const progress = Math.floor(received / candidate.size * 100);
          if (progress !== lastProgress) { lastProgress = progress; update({ progress }); }
        }
        await handle.sync(); await handle.close(); handle = null;
        if (received !== candidate.size || hash.digest('hex') !== candidate.sha256) throw failure('integrity');
        await verifyFile(temporary, candidate);
        await fs.rename(temporary, target);
        downloaded = target;
        return update({ phase: 'ready', progress: 100, error: null });
      } catch (error) {
        await handle?.close().catch(() => {});
        await fs.unlink(temporary).catch(() => {});
        return report(error instanceof UpdateError ? error : ['EACCES', 'EPERM', 'ENOSPC', 'EROFS'].includes(error.code) ? failure('storage') : error);
      } finally { clearTimeout(timer); controller = null; }
    });
  }
  async function install() {
    return run('install', async () => {
      if (!downloaded || !candidate) return report(failure('not_ready'));
      let prepared;
      try {
        try { await verifyFile(downloaded, candidate); }
        catch { downloaded = null; throw failure('integrity'); }
        const plan = { version: 1, kind, source: downloaded, sha256: candidate.sha256, size: candidate.size,
          target: path.resolve(portableExecutable || exePath), processId: process.pid, launcherPid: portableExecutable ? process.ppid : null,
          planDir: path.join(cacheRoot, `install-${crypto.randomUUID()}`), newVersion: candidate.version };
        prepared = await prepareInstall(plan);
        const permission = await canInstall();
        if (permission !== true) {
          const message = typeof permission === 'string' && permission.length < 300 ? permission : ERRORS.busy;
          update({ phase: 'ready', error: message });
          throw new Error(message);
        }
        update({ phase: 'installing', error: null });
        await prepared.authorize();
        await onBeforeQuit();
        return getState();
      } catch (error) {
        await prepared?.cancel().catch(() => {});
        if (error instanceof UpdateError && error.code === 'integrity') { downloaded = null; return report(error); }
        if (state.phase === 'ready' && state.error) throw error;
        return report(error instanceof UpdateError ? error : failure('install'), downloaded ? 'ready' : 'error');
      }
    });
  }
  function dispose() { disposed = true; controller?.abort(); }
  return { getState, check, download, install, dispose };
}
