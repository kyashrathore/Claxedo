#!/usr/bin/env bun

import * as path from "node:path"

import { write, verify } from "./contract"
import { copyWorkspaceRuntimeTemplates } from "./utils"

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

const copied = copyWorkspaceRuntimeTemplates(path.join(root, "out/templates"))
console.log(`[build] copied workspace-runtime templates from ${copied.src} to ${copied.dest}`)

write()
const saved = verify()
console.log(`[build] contract locked at ${saved.built_at}`)
