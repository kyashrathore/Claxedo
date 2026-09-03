#!/usr/bin/env bun

import * as path from "node:path"

import { verify } from "./contract"
import { verifyPackageContents } from "./verify-package-contents"

const root = path.resolve(import.meta.dir, "..")
const args = Bun.argv.slice(2)

const map: Record<string, string> = {
  "--linux": "package:linux:inner",
  "--mac": "package:mac:inner",
  "--win": "package:win:inner",
}

const key = args[0]
const script = map[key] ?? "package:inner"
const extra = key in map ? args.slice(1) : args
const targetPlatform: NodeJS.Platform = key === "--win"
  ? "win32"
  : key === "--linux"
    ? "linux"
    : key === "--mac"
      ? "darwin"
      : process.platform
const targetArch = extra.includes("--arm64")
  ? "arm64"
  : extra.includes("--x64")
    ? "x64"
    : extra.includes("--universal")
      ? "universal"
      : process.arch
const pack = Bun.spawn({
  cmd: ["bun", "run", "build"],
  cwd: root,
  env: { ...Bun.env, CLAXEDO_REQUIRE_NATIVE_RICH_CONTENT: "1" },
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
})

if (await pack.exited !== 0) {
  process.exit(1)
}

verify()

const cmd = extra.length
  ? ["bun", "run", script, "--", ...extra]
  : ["bun", "run", script]
// One retry: electron-builder's bun "file traversal" node-module collector
// intermittently fails to resolve a workspace package's dependency across the
// .bun-store symlinks ("Production dependency better-sqlite3 not found for
// package @claxedo/<name>") — observed on different release legs in
// different runs with an identical tree that packaged fine elsewhere. The
// step is idempotent; a deterministic failure fails twice.
let code = 1
for (let attempt = 0; attempt < 2 && code !== 0; attempt++) {
  if (attempt > 0) console.error("[package] electron-builder failed; retrying once")
  const proc = Bun.spawn({
    cmd,
    cwd: root,
    env: Bun.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })
  code = await proc.exited
}
if (code !== 0) process.exit(code)

const { failures } = verifyPackageContents(root, { platform: targetPlatform, arch: targetArch })
if (failures.length > 0) {
  console.error(`[package] packaging invariant violated:\n${failures.join("\n")}`)
  process.exit(1)
}
console.log("[package] packaging invariants hold (bundled output, native modules, and rich-content renderer)")
process.exit(0)
