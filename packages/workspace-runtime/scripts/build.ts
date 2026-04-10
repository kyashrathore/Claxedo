#!/usr/bin/env node

/**
 * Build @claxedo/workspace-runtime for npm publishing.
 *
 * Steps:
 *   1. esbuild: bundle src/index.ts → dist/index.mjs
 *      - Workspace deps (@opencode-ai/sdk) are bundled in
 *      - Native modules and npm dependencies are externalized
 *   2. tsc: emit declaration files → dist/
 *
 * Usage: npx tsx scripts/build.ts
 */

import { execSync } from "child_process"
import fs from "fs"
import path from "path"

const ROOT = path.resolve(import.meta.dirname, "..")
const DIST = path.join(ROOT, "dist")

// Dependencies that stay external (consumers install them)
const EXTERNALS = [
  "@agentclientprotocol/sdk",
  "@zed-industries/claude-agent-acp",
  "@zed-industries/codex-acp",
  "@hono/node-server",
  "@hono/node-ws",
  "better-sqlite3",
  "hono",
  "node-pty",
  "jsonc-parser",
  "zod",
  // Native helpers
  "cpu-features",
  "prebuild-install",
]

function run(cmd: string, opts?: { cwd?: string }) {
  console.log(`$ ${cmd}`)
  execSync(cmd, { stdio: "inherit", cwd: opts?.cwd ?? ROOT })
}

function clean() {
  if (fs.existsSync(DIST)) {
    fs.rmSync(DIST, { recursive: true })
  }
  fs.mkdirSync(DIST, { recursive: true })
}

function bundleJS() {
  const externals = EXTERNALS.map((m) => `--external:${m}`).join(" ")
  const banner = `--banner:js="import {createRequire as __cr} from 'module';var require=__cr(import.meta.url);"`
  // Library entry
  run(
    `npx esbuild src/index.ts --bundle --platform=node --format=esm --outfile=${DIST}/index.mjs ${externals} --target=node22 --main-fields=module,main ${banner}`,
  )
  // CLI entry (bin)
  run(
    `npx esbuild src/main.ts --bundle --platform=node --format=esm --outfile=${DIST}/main.mjs ${externals} --target=node22 --main-fields=module,main ${banner}`,
  )
}

function emitDeclarations() {
  run(`npx tsc --declaration --emitDeclarationOnly --outDir ${DIST}`)
}

try {
  clean()
  bundleJS()
  emitDeclarations()
  console.log("\nBuild complete: dist/index.mjs + dist/main.mjs + declarations")
} catch (err) {
  console.error("Build failed:", err)
  process.exit(1)
}
