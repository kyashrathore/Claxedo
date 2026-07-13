#!/usr/bin/env node

import { execFileSync } from "child_process"
import fs from "fs"
import path from "path"

const ROOT = path.resolve(import.meta.dirname, "..")
const DIST = path.join(ROOT, "dist")
if (fs.existsSync(DIST)) fs.rmSync(DIST, { recursive: true })
fs.mkdirSync(DIST, { recursive: true })

// Public entry points (see package.json "exports") are bundled with npm deps
// left external. Contracts use the browser target to emit a portable artifact;
// the static import-boundary test separately enforces its dependency allowlist.
for (const [entry, outfile, target] of [
  ["src/index.ts", "dist/index.mjs", "node"],
  ["src/connectors/index.ts", "dist/connectors/index.mjs", "node"],
  ["src/contracts/index.ts", "dist/contracts/index.mjs", "browser"],
  ["src/domain/index.ts", "dist/domain/index.mjs", "browser"],
  ["src/hosted.ts", "dist/hosted.mjs", "browser"],
  ["src/matching.ts", "dist/matching.mjs", "browser"],
  ["src/ports/index.ts", "dist/ports/index.mjs", "browser"],
  ["src/conformance/index.ts", "dist/conformance/index.mjs", "browser"],
] as const) {
  execFileSync(
    process.execPath,
    ["build", entry, `--target=${target}`, "--format=esm", `--outfile=${outfile}`, "--packages=external"],
    { stdio: "inherit", cwd: ROOT },
  )
}

// Emit the full declaration tree so every entry point and its references
// type-resolve.
execFileSync(path.join(ROOT, "node_modules/.bin/tsc"), ["-p", "tsconfig.build.json"], {
  stdio: "inherit",
  cwd: ROOT,
})
