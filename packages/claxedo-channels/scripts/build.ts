#!/usr/bin/env node

import { execFileSync } from "child_process"
import fs from "fs"
import path from "path"

const ROOT = path.resolve(import.meta.dirname, "..")
const DIST = path.join(ROOT, "dist")
if (fs.existsSync(DIST)) fs.rmSync(DIST, { recursive: true })
fs.mkdirSync(DIST, { recursive: true })

execFileSync(process.execPath, [
  "build",
  "src/index.ts",
  "--target=node",
  "--format=esm",
  "--outfile=dist/index.mjs",
  "--packages=external",
], { stdio: "inherit", cwd: ROOT })
execFileSync(path.join(ROOT, "node_modules/.bin/tsc"), ["-p", "tsconfig.build.json"], { stdio: "inherit", cwd: ROOT })
