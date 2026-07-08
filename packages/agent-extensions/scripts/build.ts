#!/usr/bin/env node

import { execFileSync } from "child_process"
import fs from "fs"
import path from "path"

const ROOT = path.resolve(import.meta.dirname, "..")
const DIST = path.join(ROOT, "dist")

const ENTRIES = [
  "src/index.ts",
  "src/facade.ts",
  "src/install.ts",
  "src/manifest.ts",
  "src/source.ts",
  "src/cache.ts",
  "src/fetch.ts",
  "src/state.ts",
  "src/lock.ts",
  "src/storage.ts",
  "src/replay.ts",
  "src/runtime-config.ts",
  "src/workspace.ts",
  "src/materialization.ts",
  "src/materialize.ts",
  "src/types.ts",
  "src/cli.ts",
  "src/materializers/mcp.ts",
  "src/materializers/opencode-agent.ts",
  "src/materializers/cursor.ts",
  "src/materializers/skills.ts",
]

function run(cmd: string, args: string[]) {
  console.log(`$ ${[cmd, ...args].join(" ")}`)
  execFileSync(cmd, args, { stdio: "inherit", cwd: ROOT })
}

if (fs.existsSync(DIST)) fs.rmSync(DIST, { recursive: true })
fs.mkdirSync(path.join(DIST, "materializers"), { recursive: true })

run(path.join(ROOT, "node_modules/.bin/esbuild"), [
  ...ENTRIES,
  "--bundle",
  "--platform=node",
  "--format=esm",
  "--target=node22",
  "--external:jsonc-parser",
  "--outdir=dist",
  "--outbase=src",
  "--out-extension:.js=.mjs",
  "--banner:js=import {createRequire as __cr} from 'module';var require=__cr(import.meta.url);",
])
run(path.join(ROOT, "node_modules/.bin/esbuild"), [
  "src/main.ts",
  "--bundle",
  "--platform=node",
  "--format=esm",
  "--target=node22",
  "--external:jsonc-parser",
  `--outfile=${path.join(DIST, "main.mjs")}`,
  "--banner:js=#!/usr/bin/env node\nimport {createRequire as __cr} from 'module';var require=__cr(import.meta.url);",
])
fs.chmodSync(path.join(DIST, "main.mjs"), 0o755)
run(path.join(ROOT, "node_modules/.bin/tsc"), ["-p", "tsconfig.build.json"])
