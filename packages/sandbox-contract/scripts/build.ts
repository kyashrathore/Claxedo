#!/usr/bin/env node

import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const ROOT = path.resolve(import.meta.dirname, "..")
const DIST = path.join(ROOT, "dist")

if (fs.existsSync(DIST)) fs.rmSync(DIST, { recursive: true })
fs.mkdirSync(DIST, { recursive: true })

execFileSync(path.join(ROOT, "node_modules/.bin/esbuild"), [
  "src/index.ts",
  "--bundle",
  "--platform=neutral",
  "--format=esm",
  `--outfile=${DIST}/index.mjs`,
  "--target=es2022",
], { stdio: "inherit", cwd: ROOT })
execFileSync(path.join(ROOT, "node_modules/.bin/tsc"), ["-p", "tsconfig.build.json"], { stdio: "inherit", cwd: ROOT })
