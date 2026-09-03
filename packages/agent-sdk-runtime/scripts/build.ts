#!/usr/bin/env node

import { execSync } from "child_process"
import fs from "fs"
import path from "path"

const ROOT = path.resolve(import.meta.dirname, "..")
const DIST = path.join(ROOT, "dist")
const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

const ENTRIES = [
  "src/index.ts",
  "src/harnesses/index.ts",
  "src/harness-factories/acp.ts",
  "src/harness-factories/claude.ts",
  "src/harness-factories/codex.ts",
  "src/harness-factories/cursor.ts",
  "src/harness-factories/opencode.ts",
  "src/harness-factories/pi.ts",
  "src/adapters.ts",
  "src/message-page.ts",
  "src/compat-events.ts",
  "src/status.ts",
  "src/capabilities.ts",
  "src/session-env.ts",
  "src/virtual-session-env.ts",
  "src/runtime-event-hub.ts",
  "src/runtime.ts",
  "src/sse.ts",
  "src/mcp-resolver.ts",
  "src/subagent-admission.ts",
  "src/stores/memory.ts",
  "src/stores/sqlite.ts",
]

const EXTERNALS = Object.keys({
  ...packageJson.dependencies,
  ...packageJson.optionalDependencies,
  ...packageJson.peerDependencies,
}).flatMap((dependency) => [dependency, `${dependency}/*`])

function run(cmd: string) {
  console.log(`$ ${cmd}`)
  execSync(cmd, { stdio: "inherit", cwd: ROOT })
}

if (fs.existsSync(DIST)) fs.rmSync(DIST, { recursive: true })
fs.mkdirSync(DIST, { recursive: true })

run("bun scripts/validate-api-manifest.ts")
run("bun run check:source-shape")
run([
  path.join(ROOT, "node_modules/.bin/esbuild"),
  ...ENTRIES,
  "--bundle",
  "--platform=node",
  "--format=esm",
  "--splitting",
  "--target=node22",
  "--outdir=dist",
  "--outbase=src",
  "--out-extension:.js=.mjs",
  "--chunk-names=chunks/[name]-[hash]",
  ...EXTERNALS.map((item) => `--external:${item}`),
].join(" "))
run(`${path.join(ROOT, "node_modules/.bin/tsc")} -p tsconfig.build.json`)
run("bun scripts/check-package.ts")
