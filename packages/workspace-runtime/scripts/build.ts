#!/usr/bin/env node

/**
 * Build @claxedo/workspace-runtime for npm publishing.
 *
 * Steps:
 *   1. esbuild: bundle public entrypoints from src/*.ts → dist/*.mjs
 *      - Workspace dependencies are bundled in
 *      - Native modules and npm dependencies are externalized
 *   2. tsc: emit declaration files → dist/
 *
 * Usage: npx tsx scripts/build.ts
 */

import { execFileSync } from "child_process"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import { rollup } from "rollup"
import dts from "rollup-plugin-dts"
import { OPENCODE_SDK_EXTERNALS } from "./stage-opencode-sdk"
import { stageOpenCodePatches } from "./stage-opencode-patches"

const ROOT = path.resolve(import.meta.dirname, "..")
const DIST = path.join(ROOT, "dist")
const PUBLIC_ENTRIES = ["index", "relay", "client", "host", "exposure", "config", "routes", "http", "route-contribution", "testing", "opencode"] as const

// Dependencies that stay external (consumers install them)
const LIBRARY_EXTERNALS = [
  "@claxedo/agent-sdk-runtime",
  "@claxedo/agent-sdk-runtime/*",
  "@claxedo/agent-event-runtime",
  "@claxedo/agent-event-runtime/*",
]

const EXTERNALS = [
  "@claxedo/workspace-relay",
  "@claxedo/workspace-relay-protocol",
  // The public embedded OpenCode SDK (and its Node process-lock helper) stay
  // install-time dependencies: the SDK carries native PTY packages and an
  // asset-relative module graph that cannot be folded into this bundle.
  ...OPENCODE_SDK_EXTERNALS,
  "@agentclientprotocol/sdk",
  "@hono/node-server",
  "@hono/node-ws",
  "@lydell/node-pty",
  "better-sqlite3",
  "hono",
  "ws",
  "jsonc-parser",
  "zod",
  // Native helpers
  "cpu-features",
  "prebuild-install",
]

const DECLARATION_EXTERNALS = [
  /^@claxedo\//,
  /^hono(\/.*)?$/,
  /^@hono\//,
  /^node:/,
  "@lydell/node-pty",
  "better-sqlite3",
  "jose",
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
  const nodeShared = [
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
        ...(entry === "client"
          ? ["--bundle", "--platform=browser", "--format=esm", "--target=es2022"]
          : nodeShared),
        `--outfile=${path.join(DIST, `${entry}.mjs`)}`,
        ...libraryExternals,
        ...(entry === "client"
          ? []
          : ["--banner:js=import {createRequire as __cr} from 'module';var require=__cr(import.meta.url);"]),
      ],
    )
  }
  run(
    esbuild,
    [
      "src/cli.ts",
      ...nodeShared,
      `--outfile=${path.join(DIST, "cli.mjs")}`,
      ...cliExternals,
      "--banner:js=import {createRequire as __cr} from 'module';var require=__cr(import.meta.url);",
    ],
  )
  fs.chmodSync(path.join(DIST, "cli.mjs"), 0o755)
}

function emitDeclarations() {
  // Resolve tsc through node module resolution instead of node_modules/.bin:
  // bun only links the tsc bin for the catalog typescript (7.0.2), so this
  // package's 5.8.2 pin gets no .bin/tsc symlink on a fresh install.
  run(process.execPath, [
    fileURLToPath(import.meta.resolve("typescript/lib/tsc.js")),
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

async function bundleDeclarations() {
  // One declaration graph preserves nominal identities (WorkspaceScope's
  // private field) across public subpaths. Independent bundles duplicate them.
  const staging = path.join(DIST, ".declarations")
  const bundle = await rollup({
    input: Object.fromEntries(PUBLIC_ENTRIES.map((entry) => [entry, path.join(DIST, `${entry}.d.ts`)])),
    plugins: [dts({ respectExternal: true })],
    external: isDeclarationExternal,
  })
  try {
    await bundle.write({ dir: staging, entryFileNames: "[name].d.ts", chunkFileNames: "shared/[name]-[hash].d.ts", format: "es" })
  } finally {
    await bundle.close()
  }
  pruneInternalDeclarations()
  fs.cpSync(staging, DIST, { recursive: true })
  fs.rmSync(staging, { recursive: true })
}

function pruneInternalDeclarations(dir = DIST) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === ".declarations") continue
      pruneInternalDeclarations(file)
      if (fs.readdirSync(file).length === 0) fs.rmdirSync(file)
      continue
    }
    if (!entry.name.endsWith(".d.ts") && !entry.name.endsWith(".d.ts.map")) continue
    if (dir === DIST && PUBLIC_ENTRIES.some((publicEntry) => entry.name === `${publicEntry}.d.ts`)) continue
    fs.rmSync(file)
  }
}

async function main() {
  clean()
  bundleJS()
  emitDeclarations()
  await bundleDeclarations()
  const patchOutput = path.join(DIST, "opencode-node")
  const staged = await stageOpenCodePatches(patchOutput)
  fs.writeFileSync(path.join(patchOutput, "package.json"), JSON.stringify({
    private: true, type: "module", claxedoDependencyPatches: staged.patches,
  }, null, 2))
  console.log("\nBuild complete: public dist/*.mjs entries + bundled declarations")
}

main().catch((err) => {
  console.error("Build failed:", err)
  process.exit(1)
})
