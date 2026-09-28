// Run using the packaged Electron runtime with ELECTRON_RUN_AS_NODE=1.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
const root = path.resolve(process.argv[2]);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "inspiration-package-smoke-"));
process.env.INSPIRATION_DATA_DIR = temp;
process.env.INSPIRATION_APP_ROOT = root;
for (const key of ["API_KEY", "INBOX_TOKEN", "INBOX_URL", "MODEL", "BASE_URL"]) delete process.env[key];
const load = relative => import(pathToFileURL(path.join(root, relative)).href);
let server, store;
try {
  const { loadConfig, DB_PATH } = await load("dist/core/config.js");
  const cfg = loadConfig();
  assert.equal(cfg.apiKey, ""); assert.equal(cfg.inboxToken, "");
  assert.equal(cfg.inboxUrl, ""); assert.equal(cfg.inboxEnabled, false);
  assert.equal(DB_PATH, path.join(temp, "data/inspiration.db"));
  store = await load("dist/core/store.js");
  const { toDataUri } = await load("dist/core/vision.js");
  const converted = await toDataUri(Buffer.from('<svg width="32" height="32"><rect width="32" height="32" fill="#336699"/></svg>'));
  assert.ok(converted.startsWith("data:image/jpeg;base64,"));
  const { startServer } = await load("dist/core/server.js");
  server = await startServer(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const home = await fetch(base);
  assert.equal(home.status, 200); assert.ok((await home.text()).includes('id="tasks-btn"'));
  const bootstrap = await (await fetch(`${base}/api/bootstrap`)).json();
  assert.equal(bootstrap.articleCount, 0);
  const publicConfig = await (await fetch(`${base}/api/config`)).json();
  assert.equal(publicConfig.hasKey, false); assert.equal(publicConfig.inboxTokenSet, false);
  const tasks = await (await fetch(`${base}/api/tasks`)).json();
  assert.deepEqual(tasks.tasks, []); assert.equal(tasks.inbox.connection, "disabled");
  console.log("Packaged runtime verified: empty private configuration, SQLite, sharp, viewer and HTTP APIs.");
} finally {
  if (server) await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
  if (store) store.getDb().close();
  if (!temp.startsWith(path.join(os.tmpdir(), "inspiration-package-smoke-"))) throw new Error("Unexpected cleanup target");
  fs.rmSync(temp, { recursive: true, force: true });
}
