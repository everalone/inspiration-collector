import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createUpdateManifest } from "../scripts/create-update-manifest.mjs";
import { toReleaseVersion } from "../src-electron/version.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const packageVersion = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8")).version;
const releaseVersion = toReleaseVersion(packageVersion);
async function fixture(t, version = "0.2.3") {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "inspiration-manifest-"));
  t.after(() => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("inspiration-manifest-"));
    return fs.rm(directory, { recursive: true, force: true });
  });
  const files = ["Setup", "Portable"].map(kind => ({
    name: `InspirationCollector-${kind}-${version}.exe`, data: Buffer.from(`MZ\0test-${kind}-executable`),
  }));
  for (const file of files) await fs.writeFile(path.join(directory, file.name), file.data);
  return { directory, files };
}

function builderMetadata(version, setupName, newline = "\n") {
  return [
    `version: ${version}`, "files:", `  - url: ${setupName}`,
    "    sha512: f+akXaVrhiomZbBEBmiFlkulytN/TsKJfI/AxhVTWfyfvcaFvWVEoO8sj43NKBlkA55ZtNSEeFxu7rLmHhJK6g==",
    "    size: 118659704", `path: ${setupName}`,
    "sha512: f+akXaVrhiomZbBEBmiFlkulytN/TsKJfI/AxhVTWfyfvcaFvWVEoO8sj43NKBlkA55ZtNSEeFxu7rLmHhJK6g==",
    "releaseDate: '2026-11-03T09:37:30.629Z'", "",
  ].join(newline);
}

test("update manifest contains both exact packages with reproducible sizes and SHA256 digests", async t => {
  const h = await fixture(t);
  const manifest = await createUpdateManifest(h.directory, { version: "0.2.3" });
  assert.deepEqual(manifest, { schemaVersion: 1, version: "0.2.3", assets: h.files.map(file => ({
    name: file.name, size: file.data.length, sha256: createHash("sha256").update(file.data).digest("hex"),
    url: `https://github.com/everalone/inspiration-collector/releases/download/v0.2.3/${file.name}`,
  })) });
  const first = await fs.readFile(path.join(h.directory, "update.json"), "utf8");
  assert.deepEqual(JSON.parse(first), manifest);
  await createUpdateManifest(h.directory, { version: "0.2.3" });
  assert.equal(await fs.readFile(path.join(h.directory, "update.json"), "utf8"), first);
  assert.equal((await fs.readdir(h.directory)).filter(name => name.endsWith(".tmp")).length, 0);
});

test("numeric package revisions map to the requested four-part public version without accepting arbitrary metadata", () => {
  assert.equal(toReleaseVersion("0.2.4"),"0.2.4");
  assert.equal(toReleaseVersion("0.2.4+1"),"0.2.4.1");
  assert.equal(toReleaseVersion("0.2.4+12"),"0.2.4.12");
  for (const version of ["v0.2.4", "0.2.4.1", "0.2.4-rc.1", "0.2.4+build", "0.2.4+01", "0.2.4+1.extra",
    "0.2.4+9007199254740992", "01.2.4+1", "0.2.4+1/other", null, ["0.2.4+1"]]) {
    assert.throws(()=>toReleaseVersion(version),/stable/);
  }
});

test("four-part manifests select exact patch filenames and versioned GitHub download paths", async t => {
  const h = await fixture(t,"0.2.4.1");
  const manifest = await createUpdateManifest(h.directory,{version:"0.2.4.1"});
  assert.equal(manifest.version,"0.2.4.1");
  assert.deepEqual(manifest.assets.map(asset=>asset.name),h.files.map(file=>file.name));
  for (const asset of manifest.assets) {
    assert.equal(asset.url,`https://github.com/everalone/inspiration-collector/releases/download/v0.2.4.1/${asset.name}`);
    const bytes=await fs.readFile(path.join(h.directory,asset.name));
    assert.equal(asset.sha256,createHash("sha256").update(bytes).digest("hex"));
  }
});

test("builder metadata maps a numeric package revision to the public patch version without changing hashes or formatting", async t => {
  const h = await fixture(t, "0.2.4.1");
  const latest = path.join(h.directory, "latest.yml");
  for (const sourceVersion of ["0.2.4", "0.2.4+1", "0.2.4.1"]) {
    for (const newline of ["\n", "\r\n"]) {
      const original = builderMetadata(sourceVersion, h.files[0].name, newline);
      await fs.writeFile(latest, original);
      const manifest = await createUpdateManifest(h.directory, { version: "0.2.4.1" });
      assert.equal(manifest.version, "0.2.4.1");
      const expected = original.replace(`version: ${sourceVersion}`, "version: 0.2.4.1");
      assert.equal(await fs.readFile(latest, "utf8"), expected);
      await createUpdateManifest(h.directory, { version: "0.2.4.1" });
      assert.equal(await fs.readFile(latest, "utf8"), expected);
    }
  }
  assert.equal((await fs.readdir(h.directory)).filter(name => name.endsWith(".tmp")).length, 0);
});

test("ordinary three-part builder metadata is preserved byte for byte", async t => {
  const h = await fixture(t);
  const original = builderMetadata("0.2.3", h.files[0].name);
  await fs.writeFile(path.join(h.directory, "latest.yml"), original);
  await createUpdateManifest(h.directory, { version: "0.2.3" });
  assert.equal(await fs.readFile(path.join(h.directory, "latest.yml"), "utf8"), original);
});

test("unknown or mismatched builder metadata fails before changing either release metadata file", async t => {
  const h = await fixture(t, "0.2.4.1");
  await createUpdateManifest(h.directory, { version: "0.2.4.1" });
  const manifest = await fs.readFile(path.join(h.directory, "update.json"), "utf8");
  const valid = builderMetadata("0.2.4", h.files[0].name);
  const invalid = [
    valid.replace("version: 0.2.4", "version: 0.2.5"),
    valid.replace("version: 0.2.4", "version: 0.2.4+2"),
    valid.replace("version: 0.2.4", "version: 0.2.4.2"),
    valid.replace("version: 0.2.4", "version: 0.2.4-rc.1"),
    valid.replace("version: 0.2.4", "version: 0.2.4\nversion: 0.2.4"),
    valid.replace(`url: ${h.files[0].name}`, "url: InspirationCollector-Setup-0.2.4.exe"),
    valid.replace(`path: ${h.files[0].name}`, `path: ${h.files[1].name}`),
    valid.replace(`path: ${h.files[0].name}\n`, ""),
    valid.replace("files:", "files:\n  - url: unrelated.exe"),
    valid.replace("files:", "fileList:"),
  ];
  for (const original of invalid) {
    await fs.writeFile(path.join(h.directory, "latest.yml"), original);
    await assert.rejects(createUpdateManifest(h.directory, { version: "0.2.4.1" }), /latest\.yml.*exact Setup asset/);
    assert.equal(await fs.readFile(path.join(h.directory, "latest.yml"), "utf8"), original);
    assert.equal(await fs.readFile(path.join(h.directory, "update.json"), "utf8"), manifest);
  }
});

test("manifest generation refuses missing assets and does not overwrite a prior valid manifest", async t => {
  const h = await fixture(t);
  await createUpdateManifest(h.directory, { version: "0.2.3" });
  const previous = await fs.readFile(path.join(h.directory, "update.json"), "utf8");
  await fs.unlink(path.join(h.directory, h.files[1].name));
  await assert.rejects(createUpdateManifest(h.directory, { version: "0.2.3" }), { code: "ENOENT" });
  assert.equal(await fs.readFile(path.join(h.directory, "update.json"), "utf8"), previous);
});

test("manifest generation accepts only strict stable versions", async t => {
  const h = await fixture(t);
  for (const version of ["v0.2.3", "0.2", "01.2.3", "0.2.3-rc.1", "0.2.3+build", "0.2.3+1", "0.2.3/other", "9007199254740992.0.0", "0.2.4.01", "0.2.4.1.1", "0.2.4.9007199254740992", 203, null]) {
    await assert.rejects(createUpdateManifest(h.directory, { version }), /stable/);
  }
  await assert.rejects(fs.access(path.join(h.directory, "update.json")), { code: "ENOENT" });
});

test("manifest generation rejects empty and non-executable package contents", async t => {
  const h = await fixture(t);
  for (const data of [Buffer.alloc(0), Buffer.from("M"), Buffer.from("not an executable")]) {
    await fs.writeFile(path.join(h.directory, h.files[0].name), data);
    await assert.rejects(createUpdateManifest(h.directory, { version: "0.2.3" }), /empty|not a Windows executable/);
  }
  await assert.rejects(fs.access(path.join(h.directory, "update.json")), { code: "ENOENT" });
});

test("CLI reads the root package version and writes update.json in the supplied output directory", async t => {
  const h = await fixture(t, releaseVersion);
  const result = spawnSync(process.execPath, ["scripts/create-update-manifest.mjs", h.directory], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /2 Windows packages/);
  const manifest = JSON.parse(await fs.readFile(path.join(h.directory, "update.json"), "utf8"));
  assert.equal(manifest.version, releaseVersion);
  assert.equal(manifest.assets.length, 2);
});
