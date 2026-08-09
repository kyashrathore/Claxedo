import { spawnSync } from "node:child_process"
import path from "node:path"

const argv = process.argv.slice(2)
const native = argv[0]
const packageFlag = argv.indexOf("--package-dir")
const packageDir = packageFlag === -1 ? undefined : argv[packageFlag + 1]

if (!packageDir || !["better-sqlite3", "node-pty"].includes(native ?? "")) {
  throw new Error("usage: bun prepare-native.ts <better-sqlite3|node-pty> --package-dir <workspace-dir>")
}

const workspace = path.resolve(process.cwd(), packageDir)
const probe = native === "better-sqlite3"
  ? `const Database = requireFromWorkspace("better-sqlite3");
     const db = new Database(":memory:");
     const row = db.prepare("select 1 as ready").get();
     db.close();
     if (row.ready !== 1) process.exit(2);`
  : `const names = ["node-pty", "@lydell/node-pty"];
     const timer = setTimeout(() => process.exit(3), 5000);
     Promise.all(names.map((name) => new Promise((resolve, reject) => {
       const pty = requireFromWorkspace(name);
       const child = pty.spawn(process.execPath, ["-e", "process.exit(0)"], {
         name: "xterm-color", cols: 80, rows: 24, cwd: process.cwd(), env: process.env,
       });
       child.onExit(({ exitCode }) => exitCode === 0 ? resolve() : reject(new Error(name + " exited " + exitCode)));
     }))).then(() => { clearTimeout(timer); process.exit(0); }, (error) => { console.error(error); process.exit(2); });`
const result = spawnSync("node", [
  "-e",
  `const { createRequire } = require("node:module");
   const requireFromWorkspace = createRequire(process.argv[1]);
   ${probe}`,
  path.join(workspace, "package.json"),
], {
  cwd: workspace,
  env: process.env,
  stdio: "inherit",
})
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 2)
