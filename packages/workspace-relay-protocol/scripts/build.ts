#!/usr/bin/env node

import { execFileSync } from "child_process"
import fs from "fs"
import path from "path"

const ROOT = path.resolve(import.meta.dirname, "..")
const DIST = path.join(ROOT, "dist")

if (fs.existsSync(DIST)) fs.rmSync(DIST, { recursive: true })
fs.mkdirSync(DIST, { recursive: true })

execFileSync(path.join(ROOT, "node_modules/.bin/esbuild"), [
  "src/index.ts",
  "--bundle",
  "--platform=node",
  "--format=esm",
  `--outfile=${DIST}/index.mjs`,
  "--target=node22",
  "--external:jose",
], { stdio: "inherit", cwd: ROOT })
execFileSync(path.join(ROOT, "node_modules/.bin/tsc"), ["-p", "tsconfig.build.json"], { stdio: "inherit", cwd: ROOT })
