import fs from "node:fs";
import { spawnSync } from "node:child_process";
const files = fs.readdirSync(new URL("../tests/", import.meta.url)).filter(name => /\.test\.(?:ts|mjs)$/.test(name)).sort().map(name => `tests/${name}`);
const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);
