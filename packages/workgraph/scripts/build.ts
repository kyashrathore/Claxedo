#!/usr/bin/env node

import { execFileSync } from "child_process"
import fs from "fs"
import path from "path"

const ROOT = path.resolve(import.meta.dirname, "..")
const DIST = path.join(ROOT, "dist")
if (fs.existsSync(DIST)) fs.rmSync(DIST, { recursive: true })
fs.mkdirSync(DIST, { recursive: true })

// Two public entry points (see package.json "exports"): the root client and
// the connectors surface. Bundle each with npm deps left external.
for (const [entry, outfile] of [
  ["src/index.ts", "dist/index.mjs"],
  ["src/connectors/index.ts", "dist/connectors/index.mjs"],
] as const) {
  execFileSync(
    process.execPath,
    ["build", entry, "--target=node", "--format=esm", `--outfile=${outfile}`, "--packages=external"],
    { stdio: "inherit", cwd: ROOT },
  )
}

// Emit the full declaration tree (dist/index.d.ts + dist/connectors/index.d.ts
// and everything they reference) so both entry points type-resolve.
execFileSync(path.join(ROOT, "node_modules/.bin/tsc"), ["-p", "tsconfig.build.json"], {
  stdio: "inherit",
  cwd: ROOT,
})
