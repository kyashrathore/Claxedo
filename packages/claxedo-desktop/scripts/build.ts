#!/usr/bin/env bun

import * as path from "node:path"

import { write, verify } from "./contract"

const root = path.resolve(import.meta.dir, "..")
const proc = Bun.spawn({
  cmd: ["bun", "run", "build:inner"],
  cwd: root,
  env: Bun.env,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
})

if (await proc.exited !== 0) {
  process.exit(1)
}

write()
const saved = verify()
console.log(`[build] contract locked at ${saved.built_at}`)
