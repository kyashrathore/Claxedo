#!/usr/bin/env node
// Runs each real-workerd test file in its own `bun test` process. Under bun
// 1.3.14 on Linux, a workerd that Miniflare spawns in a process where an
// earlier workerd was killed or disposed can have its pipes closed under it:
// the spawn throws EBADF from epoll_ctl or "Failed to connect", or workerd
// reports "Broken pipe; fd = 3" on its control pipe. Each of ten processes
// that booted workerd thirty times in a row hit them; 240 processes that each
// booted it once, on a loaded machine, never did.
import { spawnSync } from "node:child_process"
import { mkdirSync, readdirSync } from "node:fs"
import path from "node:path"

const root = path.resolve(import.meta.dirname, "..")
const files = readdirSync(path.join(root, "src")).filter((name) => /^relay-workerd-.+\.test\.ts$/.test(name)).sort()
if (files.length === 0) throw new Error("no relay-workerd-*.test.ts files in src")
mkdirSync(path.join(root, ".artifacts", "unit"), { recursive: true })

let failed = false
for (const file of files) {
  const report = path.join(".artifacts", "unit", `junit-${file.replace(/\.test\.ts$/, "")}.xml`)
  const result = spawnSync("bun", ["test", `./src/${file}`, "--timeout", "240000", "--reporter=junit", `--reporter-outfile=${report}`], {
    cwd: root,
    stdio: "inherit",
  })
  if (result.error) throw result.error
  if (result.status !== 0) failed = true
}
process.exit(failed ? 1 : 0)
