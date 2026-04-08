#!/usr/bin/env bun

import * as path from "node:path"

import { verify } from "./contract"

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
const pack = Bun.spawn({
  cmd: ["bun", "run", "build"],
  cwd: root,
  env: Bun.env,
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
const proc = Bun.spawn({
  cmd,
  cwd: root,
  env: Bun.env,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
})

process.exit(await proc.exited)
