#!/usr/bin/env bun

import { fileURLToPath } from "node:url"

const file = fileURLToPath(new URL("../../../release-claxedo.ts", import.meta.url))
const proc = Bun.spawn({
  cmd: ["bun", file, ...Bun.argv.slice(2)],
  cwd: fileURLToPath(new URL("../../..", import.meta.url)),
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
})

process.exit(await proc.exited)
