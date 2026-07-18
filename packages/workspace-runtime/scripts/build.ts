#!/usr/bin/env node

/**
 * Build @claxedo/workspace-runtime for npm publishing.
 *
 * Steps:
 *   1. esbuild: bundle public entrypoints from src/*.ts → dist/*.mjs
 *      - Workspace deps (@opencode-ai/sdk) are bundled in
 *      - Native modules and npm dependencies are externalized
 *   2. tsc: emit declaration files → dist/
 *
 * Usage: npx tsx scripts/build.ts
 */

import { execFileSync } from "child_process"
import fs from "fs"
import path from "path"
import { rollup } from "rollup"
import dts from "rollup-plugin-dts"

const ROOT = path.resolve(import.meta.dirname, "..")
const DIST = path.join(ROOT, "dist")
const PUBLIC_ENTRIES = ["index", "relay", "client", "host", "exposure", "config", "routes", "testing"] as const
type PublicEntry = typeof PUBLIC_ENTRIES[number]

// Dependencies that stay external (consumers install them)
const LIBRARY_EXTERNALS = [
  "@claxedo/agent-extensions",
  "@claxedo/agent-extensions/*",
  "@claxedo/agent-sdk-runtime",
  "@claxedo/agent-sdk-runtime/*",
  "@claxedo/agent-event-runtime",
  "@claxedo/agent-event-runtime/*",
  "@claxedo/workgraph",
  "@claxedo/workgraph/*",
]

const EXTERNALS = [
  "@claxedo/workspace-relay",
  "@claxedo/workspace-relay-protocol",
  "@agentclientprotocol/sdk",
  "@agentclientprotocol/codex-acp",
  "@zed-industries/claude-agent-acp",
  "@hono/node-server",
  "@hono/node-ws",
  "better-sqlite3",
  "hono",
  "node-pty",
  "ws",
  "jsonc-parser",
  "zod",
  // Native helpers
  "cpu-features",
  "prebuild-install",
]

const DECLARATION_EXTERNALS = [
  /^@claxedo\//,
  /^@opencode-ai\//,
  /^hono(\/.*)?$/,
  /^@hono\//,
  /^node:/,
  "better-sqlite3",
  "jose",
  "node-pty",
  "ws",
  "zod",
]

function run(cmd: string, args: string[], opts?: { cwd?: string }) {
  console.log(`$ ${[cmd, ...args].join(" ")}`)
  execFileSync(cmd, args, { stdio: "inherit", cwd: opts?.cwd ?? ROOT })
}

function clean() {
  if (fs.existsSync(DIST)) {
    fs.rmSync(DIST, { recursive: true })
  }
  fs.mkdirSync(DIST, { recursive: true })
}

function bundleJS() {
  const esbuild = path.join(ROOT, "node_modules/.bin/esbuild")
  const libraryExternals = [...LIBRARY_EXTERNALS, ...EXTERNALS].flatMap((m) => [`--external:${m}`])
  const cliExternals = [...LIBRARY_EXTERNALS, ...EXTERNALS].flatMap((m) => [`--external:${m}`])
  const shared = [
    "--bundle",
    "--platform=node",
    "--format=esm",
    "--target=node22",
    "--main-fields=module,main",
    "--loader:.sh=text",
    "--loader:.txt=text",
  ]
  // Library entries
  for (const entry of PUBLIC_ENTRIES) {
    run(
      esbuild,
      [
        `src/${entry}.ts`,
        ...shared,
        `--outfile=${path.join(DIST, `${entry}.mjs`)}`,
        ...libraryExternals,
        "--banner:js=import {createRequire as __cr} from 'module';var require=__cr(import.meta.url);",
      ],
    )
  }
}

function emitDeclarations() {
  run(path.join(ROOT, "node_modules/.bin/tsc"), [
    "--project",
    "tsconfig.build.json",
    "--declaration",
    "--emitDeclarationOnly",
    "--outDir",
    DIST,
  ])
}

function isDeclarationExternal(id: string) {
  return DECLARATION_EXTERNALS.some((external) => typeof external === "string" ? external === id : external.test(id))
}

async function bundleDeclaration(entry: PublicEntry) {
  const file = path.join(DIST, `${entry}.d.ts`)
  const bundled = path.join(DIST, `${entry}.bundled.d.ts`)
  const bundle = await rollup({
    input: file,
    plugins: [dts({ respectExternal: true })],
    external: isDeclarationExternal,
  })
  try {
    await bundle.write({ file: bundled, format: "es" })
  } finally {
    await bundle.close()
  }
  fs.renameSync(bundled, file)
}

function pruneInternalDeclarations(dir = DIST) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      pruneInternalDeclarations(file)
      if (fs.readdirSync(file).length === 0) fs.rmdirSync(file)
      continue
    }
    if (!entry.name.endsWith(".d.ts") && !entry.name.endsWith(".d.ts.map")) continue
    if (dir === DIST && PUBLIC_ENTRIES.some((publicEntry) => entry.name === `${publicEntry}.d.ts`)) continue
    fs.rmSync(file)
  }
}

async function bundleDeclarations() {
  for (const entry of PUBLIC_ENTRIES) {
    await bundleDeclaration(entry)
  }
  pruneInternalDeclarations()
}

async function main() {
  clean()
  bundleJS()
  emitDeclarations()
  await bundleDeclarations()
  console.log("\nBuild complete: public dist/*.mjs entries + bundled declarations")
}

main().catch((err) => {
  console.error("Build failed:", err)
  process.exit(1)
})
