// A user-operated launcher for browsing older builds with a new empty library.
import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { extractFile } from "@electron/asar";
import { toReleaseVersion } from "../src-electron/version.mjs";

const repo = await fs.realpath(fileURLToPath(new URL("..", import.meta.url)));
const inside = (candidate, parent) => {
  const rel = path.relative(parent, candidate);
  return !!rel && !path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`);
};
const candidates = [];
const skipped = [];
for (const dir of await fs.readdir(repo, { withFileTypes: true })) {
  // Only established release folders, excluding diagnostic/repro/temp builds.
  if (!dir.isDirectory() || !/^release(?:-\d+\.\d+\.\d+(?:\.\d+)?(?:-github)?)?$/.test(dir.name)) continue;
  const directory = await fs.realpath(path.join(repo, dir.name));
  if (!inside(directory, repo)) continue;
  for (const file of await fs.readdir(directory, { withFileTypes: true })) {
    const match = /^InspirationCollector-Portable-(\d+\.\d+\.\d+(?:\.\d+)?)\.exe$/i.exec(file.name);
    if (!file.isFile() || !match) continue;
    const executable = await fs.realpath(path.join(directory, file.name));
    if (!inside(executable, directory)) continue;
    const archive = path.join(directory, "win-unpacked/resources/app.asar");
    try {
      const realArchive = await fs.realpath(archive);
      if (!inside(realArchive, directory)) throw new Error("archive is outside release directory");
      const pkg = JSON.parse(extractFile(realArchive, "package.json"));
      const main = extractFile(realArchive, path.normalize("src-electron/main.mjs")).toString();
      const version = toReleaseVersion(pkg.version);
      const dataSetting = main.indexOf('app.setPath("userData", userDataDir)');
      const lock = main.indexOf("app.requestSingleInstanceLock()");
      // Older 0.1.x builds hard-code the formal profile and port. Do not launch
      // them merely because an isolated environment was supplied.
      if (version !== match[1] || !main.includes("Number(process.env.INSPIRATION_PORT)") ||
          !/path\.resolve\(process\.env\.INSPIRATION_DATA_DIR\s*\|\|/.test(main) || dataSetting < 0 || lock < dataSetting) {
        throw new Error("build does not verify separate profile/port before the single-instance lock");
      }
      candidates.push({ version, directory: dir.name, executable, supportsRuntimeCheck: main.includes('process.argv.includes("--runtime-check")') });
    } catch {
      skipped.push(`${dir.name}/${file.name}`);
    }
  }
}
candidates.sort((a, b) => b.version.localeCompare(a.version, "en", { numeric: true }) || a.directory.localeCompare(b.directory));
const argv = process.argv.slice(2);
if (argv[0] === "--list") {
  console.log(JSON.stringify({ candidates, skipped }, null, 2));
  process.exit(0);
}
if (process.platform !== "win32") throw new Error("此入口用于 Windows Portable 版本。");
if (argv.length && !(argv.length === 2 && argv[0] === "--prepare-only" && /^\d+$/.test(argv[1]))) {
  throw new Error("用法：node scripts/launch-isolated.mjs [--list | --prepare-only 序号]");
}
console.log("\n旧版本隔离测试：每次新建空白测试库、独立端口与独立临时解压目录。");
candidates.forEach((item, index) => console.log(`  ${index + 1}. v${item.version}  (${item.directory})`));
if (skipped.length) console.log(`\n已跳过 ${skipped.length} 个无法验证数据隔离的包（例如 v0.1.x），不会启动它们。`);
if (!candidates.length) throw new Error("未找到支持独立数据目录的旧版 Portable，请保留对应 win-unpacked 目录。");
let selection;
if (argv[0] === "--prepare-only") selection = Number(argv[1]);
else {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try { selection = Number((await prompt.question("\n输入版本序号（直接回车取消）：")).trim()); }
  finally { prompt.close(); }
  if (!selection) process.exit(0);
}
if (!Number.isInteger(selection) || selection < 1 || selection > candidates.length) throw new Error("版本序号无效。");
const selected = candidates[selection - 1];
const sessions = path.join(repo, "data/isolated-versions");
await fs.mkdir(sessions, { recursive: true });
const realSessions = await fs.realpath(sessions);
if (!inside(realSessions, repo)) throw new Error("测试数据目录不在本项目内，已停止。");
const session = await fs.mkdtemp(path.join(realSessions, `v${selected.version}-`));
const profile = path.join(session, "profile"), temp = path.join(session, "temp");
await Promise.all([path.join(profile, "data"), temp].map(dir => fs.mkdir(dir, { recursive: true })));
const server = net.createServer();
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
const port = server.address().port;
await new Promise(resolve => server.close(resolve));
await fs.writeFile(path.join(profile, "data/config.json"), JSON.stringify({
  apiKey: "", baseUrl: "http://127.0.0.1:1", model: "isolated-version-test", serverPort: port,
  inboxEnabled: false, inboxToken: "", inboxUrl: "", inboxIntervalSec: 30,
}, null, 2) + "\n", { flag: "wx" });
const metadata = { version: selected.version, executable: selected.executable, profile, temp, port, copiedUserData: false, runtimeCheck: selected.supportsRuntimeCheck };
await fs.writeFile(path.join(session, "session.json"), JSON.stringify(metadata, null, 2) + "\n");
console.log(`\n测试版本：v${selected.version}\n测试库：${profile}\n本机地址：http://127.0.0.1:${port}\n正式文章、设置、任务和手机回执均未复制。`);
console.log("首次打开会显示设置；默认没有 API Key，手机收件箱关闭。需要测试在线导入时，在这个测试窗口填写测试配置。");
if (!selected.supportsRuntimeCheck) console.log("这个旧版本仍会读取系统剪贴板；如含公众号链接可能自动加入测试队列。当前 Key 为空，不会调用收费模型。测试前可将剪贴板换成普通文字。");
console.log("退出时请使用此测试应用的托盘菜单 → 退出。测试数据会保留；下次运行此入口会新建另一个空测试库。\n");
if (argv[0] === "--prepare-only") {
  console.log(JSON.stringify({ preparedOnly: true, session, ...metadata }));
  process.exit(0);
}
const env = { ...process.env, TEMP: temp, TMP: temp, INSPIRATION_DATA_DIR: profile, INSPIRATION_PORT: String(port) };
for (const key of ["ELECTRON_RUN_AS_NODE", "INSPIRATION_APP_ROOT", "PORTABLE_EXECUTABLE_FILE", "PORTABLE_EXECUTABLE_DIR", "PORTABLE_EXECUTABLE_APP_FILENAME", "API_KEY", "BASE_URL", "MODEL", "INBOX_TOKEN", "INBOX_URL"]) delete env[key];
const child = spawn(selected.executable, selected.supportsRuntimeCheck ? ["--runtime-check"] : [], { env, cwd: session, windowsHide: false, stdio: "ignore" });
const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (value, signal) => resolve(value ?? (signal ? 1 : 0))); });
await fs.writeFile(path.join(session, "exit.json"), JSON.stringify({ exitCode: code }, null, 2) + "\n");
console.log(`测试版本已退出，退出码 ${code}。保留的测试库：${profile}`);
process.exitCode = code === 0 ? 0 : 1;
