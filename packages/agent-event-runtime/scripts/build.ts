#!/usr/bin/env node

import { execSync } from "child_process"
import fs from "fs"
import path from "path"

const ROOT = path.resolve(import.meta.dirname, "..")
const DIST = path.join(ROOT, "dist")

function run(cmd: string) {
  console.log(`$ ${cmd}`)
  execSync(cmd, { stdio: "inherit", cwd: ROOT })
}

if (fs.existsSync(DIST)) fs.rmSync(DIST, { recursive: true })
fs.mkdirSync(DIST, { recursive: true })

run(`${path.join(ROOT, "node_modules/.bin/esbuild")} src/index.ts --bundle --platform=browser --format=esm --outfile=${DIST}/index.mjs --target=es2022`)
run(`${path.join(ROOT, "node_modules/.bin/esbuild")} src/contracts/index.ts --bundle --platform=browser --format=esm --outfile=${DIST}/contracts.mjs --target=es2022`)
run(`${path.join(ROOT, "node_modules/.bin/esbuild")} src/projections/opencode-compat/index.ts --bundle --platform=browser --format=esm --outfile=${DIST}/opencode-compat.mjs --target=es2022`)
run(`${path.join(ROOT, "node_modules/.bin/esbuild")} src/projections/debug-trace/index.ts --bundle --platform=browser --format=esm --outfile=${DIST}/debug-trace.mjs --target=es2022`)
run(`${path.join(ROOT, "node_modules/.bin/esbuild")} src/harnesses/acp/index.ts --bundle --platform=browser --format=esm --outfile=${DIST}/harnesses/acp.mjs --target=es2022`)
run(`${path.join(ROOT, "node_modules/.bin/esbuild")} src/harnesses/claude/index.ts --bundle --platform=browser --format=esm --outfile=${DIST}/harnesses/claude.mjs --target=es2022`)
run(`${path.join(ROOT, "node_modules/.bin/esbuild")} src/harnesses/codex/index.ts --bundle --platform=browser --format=esm --outfile=${DIST}/harnesses/codex.mjs --target=es2022`)
run(`${path.join(ROOT, "node_modules/.bin/esbuild")} src/harnesses/cursor/index.ts --bundle --platform=browser --format=esm --outfile=${DIST}/harnesses/cursor.mjs --target=es2022`)
run(`${path.join(ROOT, "node_modules/.bin/tsc")} -p tsconfig.build.json`)
