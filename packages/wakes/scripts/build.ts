#!/usr/bin/env node

import { execFileSync } from "child_process"
import fs from "fs"
import path from "path"

const ROOT = path.resolve(import.meta.dirname, "..")
const DIST = path.join(ROOT, "dist")
if (fs.existsSync(DIST)) fs.rmSync(DIST, { recursive: true })
fs.mkdirSync(DIST, { recursive: true })

// Two public entry points; npm deps left external. The root entry must stay
// free of better-sqlite3 (edge-runtime safe); the sqlite subpath carries it.
for (const [entry, outfile] of [
  ["src/index.ts", "dist/index.mjs"],
  ["src/sqlite.ts", "dist/sqlite.mjs"],
]) {
  execFileSync(
    process.execPath,
    ["build", entry, "--target=node", "--format=esm", `--outfile=${outfile}`, "--packages=external"],
    { stdio: "inherit", cwd: ROOT },
  )
}

// Emit the declaration tree so the entry point type-resolves.
execFileSync(path.join(ROOT, "node_modules/.bin/tsc"), ["-p", "tsconfig.build.json"], {
  stdio: "inherit",
  cwd: ROOT,
})
