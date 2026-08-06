#!/usr/bin/env node

import { execSync } from "child_process"
import fs from "fs"
import path from "path"

const ROOT = path.resolve(import.meta.dirname, "..")
const DIST = path.join(ROOT, "dist")

const ENTRIES = [
  "src/index.ts",
  "src/harnesses/index.ts",
  "src/adapters.ts",
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
  "src/stores/convex.ts",
]

const EXTERNALS = [
  "@claxedo/agent-event-runtime",
  "@claxedo/agent-event-runtime/*",
  "@agentclientprotocol/sdk",
  "@agentclientprotocol/sdk/*",
  "@anthropic-ai/claude-agent-sdk",
  "@opencode-ai/sdk",
  "@opencode-ai/sdk/*",
  "@cursor/sdk",
  "@cursor/sdk/*",
  "just-bash",
  "just-bash/*",
  "better-sqlite3",
]

function run(cmd: string) {
  console.log(`$ ${cmd}`)
  execSync(cmd, { stdio: "inherit", cwd: ROOT })
}

if (fs.existsSync(DIST)) fs.rmSync(DIST, { recursive: true })
fs.mkdirSync(DIST, { recursive: true })

run([
  path.join(ROOT, "node_modules/.bin/esbuild"),
  ...ENTRIES,
  "--bundle",
  "--platform=node",
  "--format=esm",
  "--target=node22",
  "--outdir=dist",
  "--outbase=src",
  "--out-extension:.js=.mjs",
  ...EXTERNALS.map((item) => `--external:${item}`),
].join(" "))
run(`${path.join(ROOT, "node_modules/.bin/tsc")} -p tsconfig.build.json`)
