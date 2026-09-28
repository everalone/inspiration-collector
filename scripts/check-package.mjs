import assert from "node:assert/strict";
import { listPackage } from "@electron/asar";
const archive = process.argv[2];
if (!archive) throw new Error("Provide the packaged app.asar path");
const files = listPackage(archive).map(file => file.replaceAll("\\", "/"));
const forbidden = files.filter(file => /^\/(?:data|assets|tests|docs)(?:\/|$)/.test(file) || /\/(?:\.env|config\.json|inbox-receipts\.json|tasks\.json)$/.test(file));
assert.deepEqual(forbidden, [], "The distribution must never include local data, settings or secrets");
for (const required of ["/dist/core/tasks.js", "/dist/core/inbox-client.js", "/src-electron/collection-controller.mjs", "/viewer/app.js"]) {
  assert.ok(files.includes(required), `Missing runtime file: ${required}`);
}
console.log(`Package boundary verified (${files.length} entries): runtime present, private data/settings excluded.`);
