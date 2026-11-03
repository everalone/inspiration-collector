import assert from "node:assert/strict";
import { listPackage, extractFile } from "@electron/asar";
import fs from "node:fs";
import { toReleaseVersion } from "../src-electron/version.mjs";
const archive = process.argv[2];
if (!archive) throw new Error("Provide the packaged app.asar path");
const files = listPackage(archive).map(file => file.replaceAll("\\", "/"));
const forbidden = files.filter(file => /^\/(?:data|assets|tests|docs)(?:\/|$)/.test(file) || /\/(?:\.env|config\.json|inbox-receipts\.json|tasks\.json)$/.test(file));
assert.deepEqual(forbidden, [], "The distribution must never include local data, settings or secrets");
const sourcePackage = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const packagedVersion = JSON.parse(extractFile(archive, "package.json")).version;
assert.equal(packagedVersion, sourcePackage.version, "Packaged version must preserve the hotfix revision");
assert.equal(toReleaseVersion(packagedVersion), sourcePackage.build.buildVersion, "Windows build and public release version must match");
assert.ok(files.includes("/src-electron/version.mjs"), "Missing release version conversion");
for (const required of ["/dist/core/tasks.js", "/dist/core/inbox-client.js", "/dist/core/maintenance.js", "/src-electron/collection-controller.mjs", "/src-electron/desktop-ipc.mjs", "/src-electron/preload.cjs", "/src-electron/updater.mjs", "/src-electron/update-helper.ps1", "/viewer/app.js", "/viewer/desktop.js"]) {
  assert.ok(files.includes(required), `Missing runtime file: ${required}`);
}
console.log(`Package boundary verified (${files.length} entries): runtime present, private data/settings excluded.`);
