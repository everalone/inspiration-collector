// Exercise the actual Windows Portable launcher, not only win-unpacked.
// A repeated launch must not remove the first process's lazy-loaded resources.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const args = process.argv.slice(2);
const executable = args.shift();
const outputIndex = args.indexOf("--output");
const output = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
if (process.platform !== "win32") throw new Error("Portable regression requires Windows");
if (!executable || (args.length && (outputIndex !== 0 || args.length !== 2 || !output))) {
  throw new Error("Usage: node scripts/check-portable.mjs <Portable.exe> [--output <directory>]");
}
const portable = path.resolve(executable);
assert.ok((await fs.stat(portable)).isFile(), "Portable executable is missing");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "inspiration-portable-check-"));
const tempRoot = path.join(root, "extract");
const profile = path.join(root, "profile");
const reportDir = path.resolve(output || root);
await Promise.all([tempRoot, profile, reportDir].map(dir => fs.mkdir(dir, { recursive: true })));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const inside = (candidate, parent) => {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
};
const psLiteral = value => `'${String(value).replaceAll("'", "''")}'`;
async function powershell(script) {
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); $ErrorActionPreference='Stop'; ${script}`],
  { windowsHide: true, encoding: "utf8", timeout: 20_000, maxBuffer: 2 * 1024 * 1024 });
  return stdout.replace(/^\uFEFF/, "").trim();
}
async function processes() {
  const text = await powershell("@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,CreationDate) | ConvertTo-Json -Compress");
  return text ? [].concat(JSON.parse(text)) : [];
}
async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function waitUntil(check, label, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try { const value = await check(); if (value) return value; } catch (error) { lastError = error; }
    await sleep(200);
  }
  throw new Error(`${label} timed out${lastError ? `: ${lastError.message}` : ""}`);
}
const port = await unusedPort();
const base = `http://127.0.0.1:${port}`;
const env = { ...process.env, TEMP: tempRoot, TMP: tempRoot, INSPIRATION_DATA_DIR: profile, INSPIRATION_PORT: String(port) };
for (const name of ["ELECTRON_RUN_AS_NODE", "INSPIRATION_APP_ROOT", "PORTABLE_EXECUTABLE_FILE", "PORTABLE_EXECUTABLE_DIR", "API_KEY", "INBOX_TOKEN", "INBOX_URL", "BASE_URL", "MODEL"]) delete env[name];
// The seed uses the built store without importing image/model modules.
process.env.INSPIRATION_DATA_DIR = profile;
await fs.mkdir(path.join(profile, "data"), { recursive: true });
await fs.writeFile(path.join(profile, "data/config.json"), JSON.stringify({ apiKey: "", baseUrl: "http://127.0.0.1:1", model: "portable-regression", inboxEnabled: false, inboxToken: "", inboxUrl: "" }));
const store = await import(new URL("../dist/core/store.js", import.meta.url));
const articleId = "portable-runtime-regression";
const imageDir = path.join(profile, "assets", articleId);
await fs.mkdir(imageDir, { recursive: true });
await fs.writeFile(path.join(imageDir, "0.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#336699"/></svg>');
store.upsertArticle({ id: articleId, url: "https://example.invalid/portable-test", title: "Portable runtime test fixture", account: "Local test", publishDate: "", description: "Fictional isolated fixture", imagesDir: articleId, processed: true });
store.getDb().close();

const children = [];
const owned = new Map();
const report = { executable: portable, testRoot: root, tempRoot, profile, port, passed: false, events: [] };
const event = (name, detail = {}) => report.events.push({ name, ...detail });
const sameProcess = (a, b) => a.ProcessId === b.ProcessId && a.CreationDate === b.CreationDate && a.ExecutablePath === b.ExecutablePath;
function launch() {
  const child = spawn(portable, ["--hidden", "--runtime-check"], { env, windowsHide: true, stdio: "ignore" });
  child.spawnError = null;
  child.on("error", error => { child.spawnError = error; });
  children.push(child);
  return child;
}
async function rememberTree(launcherPid) {
  const all = await processes();
  const ids = new Set([launcherPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const proc of all) if (ids.has(proc.ParentProcessId) && !ids.has(proc.ProcessId)) { ids.add(proc.ProcessId); changed = true; }
  }
  for (const proc of all) if (ids.has(proc.ProcessId)) {
    const previous = owned.get(proc.ProcessId);
    assert.ok(!previous || sameProcess(proc, previous), "A test PID was reused; refusing process ownership change");
    owned.set(proc.ProcessId, proc);
  }
  return all;
}
const resourceNames = ["icudtl.dat", "resources/app.asar", "resources/app.asar.unpacked/node_modules/sharp/package.json", "resources/app.asar.unpacked/node_modules/sharp/lib/index.js", "resources/app.asar.unpacked/node_modules/@img/sharp-win32-x64/lib/sharp-win32-x64.node"];
async function inspectResources(appDir) {
  return Promise.all(resourceNames.map(async name => ({ name, exists: await fs.stat(path.join(appDir, name)).then(stat => stat.isFile(), () => false) })));
}
async function getJSON(route) {
  const response = await fetch(`${base}${route}`, { signal: AbortSignal.timeout(2000) });
  assert.equal(response.status, 200, `${route} should be available`);
  return response.json();
}
try {
  const first = launch();
  await waitUntil(async () => {
    if (first.spawnError) throw first.spawnError;
    const bootstrap = await getJSON("/api/bootstrap");
    return bootstrap.articleCount === 1 && bootstrap.articles?.some(article => article.id === articleId);
  }, "First Portable startup");
  const all = await rememberTree(first.pid);
  const main = all.find(proc => proc.ParentProcessId === first.pid && proc.ExecutablePath?.endsWith(".exe") && inside(proc.ExecutablePath, tempRoot));
  // Never start a second old launcher until its extracted application has been
  // proven to be inside this run's unique TEMP root, not the user's live TEMP.
  assert.ok(main, "First Portable child was not found inside isolated TEMP; refusing repeated launch");
  const appDir = path.dirname(main.ExecutablePath);
  const before = await inspectResources(appDir);
  event("first-start", { launcherPid: first.pid, mainPid: main.ProcessId, appDir, resources: before });
  assert.ok(before.every(item => item.exists), "First launch is missing runtime resources");
  const config = await getJSON("/api/config");
  assert.equal(config.hasKey, false); assert.equal(config.inboxTokenSet, false); assert.equal(config.inboxEnabled, false);
  // Do not call /api/crop or preload sharp here: the bug affects lazy loading.
  const second = launch();
  await rememberTree(second.pid);
  await waitUntil(() => {
    if (second.spawnError) throw second.spawnError;
    return second.exitCode !== null;
  }, "Second Portable launcher exit");
  assert.equal(second.exitCode, 0, "Second launch should exit successfully after handing off");
  const afterProcesses = await rememberTree(first.pid);
  assert.ok(afterProcesses.some(proc => sameProcess(proc, main)), "The original application process did not survive");
  const bootstrap = await getJSON("/api/bootstrap");
  assert.equal(bootstrap.articleCount, 1);
  const after = await inspectResources(appDir);
  event("second-exit", { launcherPid: second.pid, exitCode: second.exitCode, originalMainSurvived: true, resources: after });
  // This is the first image processing operation in the application process.
  const crop = await fetch(`${base}/api/crop?article=${articleId}&idx=0&x1=0&y1=0&x2=1000&y2=1000`, { signal: AbortSignal.timeout(5000) });
  const jpeg = Buffer.from(await crop.arrayBuffer());
  event("first-image-after-second-exit", { status: crop.status, contentType: crop.headers.get("content-type"), bytes: jpeg.length,
    ...(crop.status !== 200 ? { error: jpeg.toString("utf8").slice(0, 800) } : {}) });
  assert.ok(after.every(item => item.exists), "Repeated Portable launch deleted the original process's runtime resources");
  assert.equal(crop.status, 200, "First image processing after repeated launch must succeed");
  assert.ok(crop.headers.get("content-type")?.startsWith("image/jpeg"));
  assert.equal(jpeg.subarray(0, 2).toString("hex"), "ffd8");
  const tasks = await getJSON("/api/tasks");
  assert.deepEqual(tasks.tasks, [], "The isolated regression must not collect clipboard or model tasks");
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  // Stop only verified descendants of the two launchers this script created.
  // Keep the generated profile and report for diagnosis; never delete a supplied path.
  try {
    for (const child of children) if (child.pid && child.exitCode === null && !child.spawnError) await rememberTree(child.pid);
    const live = await processes();
    const safe = live.filter(proc => owned.has(proc.ProcessId) && sameProcess(proc, owned.get(proc.ProcessId)));
    const launcherIds = new Set(children.map(child => child.pid));
    const mainAndHelpers = safe.filter(proc => !launcherIds.has(proc.ProcessId));
    if (mainAndHelpers.length) await powershell(`Stop-Process -Id ${mainAndHelpers.map(proc => proc.ProcessId).join(",")} -ErrorAction SilentlyContinue`);
    // Let each NSIS launcher finish its own extraction cleanup after its main exits.
    await waitUntil(() => children.every(child => child.exitCode !== null || child.spawnError), "Portable test cleanup", 10_000).catch(() => {});
    for (const child of children) {
      if (child.exitCode !== null || child.spawnError) continue;
      const current = (await processes()).find(proc => proc.ProcessId === child.pid);
      const original = owned.get(child.pid);
      if (current && original && sameProcess(current, original)) await powershell(`Stop-Process -Id ${child.pid} -ErrorAction SilentlyContinue`);
    }
    report.cleanup = "Owned test processes stopped; diagnostic files retained";
  } catch (error) {
    report.cleanupError = error.message;
    report.passed = false;
    process.exitCode = 1;
  }
  await fs.writeFile(path.join(reportDir, "portable-regression.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ passed: report.passed, report: path.join(reportDir, "portable-regression.json"), error: report.error, cleanupError: report.cleanupError }));
}
