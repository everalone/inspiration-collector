import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { parseReleaseVersion, toReleaseVersion } from "../src-electron/version.mjs";

const PACKAGE_FILE = new URL("../package.json", import.meta.url);
const DOWNLOAD_BASE = "https://github.com/everalone/inspiration-collector/releases/download";

function stableVersion(version) {
  if (!parseReleaseVersion(version)) {
    throw new Error("Update manifest requires a stable three- or four-part numeric version");
  }
  return version;
}

async function inspectArtifact(filePath, name, version) {
  const file = await fs.open(filePath, "r");
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size < 2) throw new Error(`Missing or empty update artifact: ${name}`);
    const header = Buffer.alloc(2);
    await file.read(header, 0, 2, 0);
    if (header.toString("ascii") !== "MZ") throw new Error(`Update artifact is not a Windows executable: ${name}`);
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of file.createReadStream({ start: 0, autoClose: false })) {
      size += chunk.length;
      hash.update(chunk);
    }
    const after = await file.stat();
    if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw new Error(`Update artifact changed while hashing: ${name}`);
    }
    return { name, size, sha256: hash.digest("hex"), url: `${DOWNLOAD_BASE}/v${version}/${name}` };
  } finally { await file.close(); }
}

async function prepareBuilderMetadata(directory, version, setupName) {
  let content;
  try { content = await fs.readFile(path.join(directory, "latest.yml"), "utf8"); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  // Only the known electron-builder shape is edited; retain every other byte,
  // including its SHA512 hashes, sizes, date and line endings.
  const versions = [...content.matchAll(/^version: ([^\r\n]+)\r?$/gm)];
  const paths = [...content.matchAll(/^path: ([^\r\n]+)\r?$/gm)];
  const files = [...content.matchAll(/^files:\r?\n((?:[ \t][^\r\n]*(?:\r?\n|$))*)/gm)];
  const urls = [...content.matchAll(/^[ \t]*(?:-[ \t]+)?url:[ \t]*([^\r\n]+)\r?$/gm)];
  const parts = parseReleaseVersion(version);
  const baseVersion = parts.slice(0, 3).join(".");
  const allowedVersions = new Set([version, baseVersion]);
  if (parts.length === 4) allowedVersions.add(`${baseVersion}+${parts[3]}`);
  if (["version", "path", "files"].some(key => [...content.matchAll(new RegExp(`^${key}:`, "gm"))].length !== 1) ||
      [...content.matchAll(/^[ \t]*(?:-[ \t]+)?url:/gm)].length !== 1 ||
      versions.length !== 1 || !allowedVersions.has(versions[0][1]) ||
      paths.length !== 1 || paths[0][1] !== setupName || files.length !== 1 ||
      urls.length !== 1 || urls[0][1] !== setupName ||
      !files[0][1].split(/\r?\n/).includes(`  - url: ${setupName}`)) {
    throw new Error("latest.yml must describe this release's exact Setup asset and matching version");
  }
  if (versions[0][1] === version) return null;
  return content.slice(0, versions[0].index) + versions[0][0].replace(versions[0][1], version) +
    content.slice(versions[0].index + versions[0][0].length);
}

async function replaceMetadata(directory, name, content) {
  const temporary = path.join(directory, `.${name}-${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
    await fs.rename(temporary, path.join(directory, name));
  } finally { await fs.rm(temporary, { force: true }); }
}

/** Generate the fixed-repository manifest after both Windows packages are complete. */
export async function createUpdateManifest(outputDirectory, options = {}) {
  if (typeof outputDirectory !== "string" || !outputDirectory.trim()) throw new Error("Provide the release output directory");
  const version = stableVersion(options.version === undefined
    ? toReleaseVersion(JSON.parse(await fs.readFile(PACKAGE_FILE, "utf8")).version)
    : options.version);
  const directory = path.resolve(outputDirectory);
  const names = ["Setup", "Portable"].map(kind => `InspirationCollector-${kind}-${version}.exe`);
  const assets = [];
  for (const name of names) assets.push(await inspectArtifact(path.join(directory, name), name, version));
  const manifest = { schemaVersion: 1, version, assets };
  const builderMetadata = await prepareBuilderMetadata(directory, version, names[0]);
  if (builderMetadata !== null) await replaceMetadata(directory, "latest.yml", builderMetadata);
  await replaceMetadata(directory, "update.json", `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const manifest = await createUpdateManifest(process.argv[2]);
    console.log(`Update manifest verified: v${manifest.version}, ${manifest.assets.length} Windows packages.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Update manifest generation failed");
    process.exitCode = 1;
  }
}
