#!/usr/bin/env node

import { execFileSync } from "child_process"
import fs from "fs"
import path from "path"

const ROOT = path.resolve(import.meta.dirname, "..")
const DIST = path.join(ROOT, "dist")
const EXTERNALS = [
  "@claxedo/workspace-relay-protocol",
  "hono",
  "hono/cors",
  "jose",
]

if (fs.existsSync(DIST)) fs.rmSync(DIST, { recursive: true })
fs.mkdirSync(DIST, { recursive: true })

execFileSync(path.join(ROOT, "node_modules/.bin/esbuild"), [
  "src/index.ts",
  "--bundle",
  "--platform=node",
  "--format=esm",
  `--outfile=${DIST}/index.mjs`,
  ...EXTERNALS.map((item) => `--external:${item}`),
  "--target=node22",
], { stdio: "inherit", cwd: ROOT })
execFileSync(path.join(ROOT, "node_modules/.bin/esbuild"), [
  "src/main.ts",
  "--bundle",
  "--platform=node",
  "--format=esm",
  `--outfile=${DIST}/main.mjs`,
  ...EXTERNALS.map((item) => `--external:${item}`),
  "--target=node22",
  "--banner:js=#!/usr/bin/env node",
], { stdio: "inherit", cwd: ROOT })
fs.chmodSync(path.join(DIST, "main.mjs"), 0o755)
execFileSync(path.join(ROOT, "node_modules/.bin/tsc"), ["-p", "tsconfig.build.json"], { stdio: "inherit", cwd: ROOT })
