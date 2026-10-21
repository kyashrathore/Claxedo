#!/usr/bin/env node

/**
 * Build @claxedo/workspace-runtime's dist.
 *
 *   tsx scripts/build.ts            the repo build: one bundle per public entry,
 *                                   unpublished @claxedo siblings left to the workspace
 *   tsx scripts/build.ts --publish  the npm build: see `bundlePublishedJS`
 *
 * Both emit the bundled declarations and the OpenCode Node patch installer.
 */

import { execFileSync } from "child_process"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import { build, type BuildOptions, type Plugin } from "esbuild"
import { rollup } from "rollup"
import dts from "rollup-plugin-dts"
import { z } from "zod"
import { bundleCursorWorker } from "../../harness/scripts/cursor-worker"
import { OPENCODE_SDK_EXTERNALS } from "./stage-opencode-sdk"
import { stageOpenCodePatches } from "./stage-opencode-patches"

const ROOT = path.resolve(import.meta.dirname, "..")
const DIST = path.join(ROOT, "dist")
const PUBLIC_ENTRIES = ["index", "relay", "client", "host", "exposure", "config", "routes", "execution-env", "route-contribution", "testing", "file-index", "file-content"] as const
const NODE_ENTRIES = PUBLIC_ENTRIES.filter((entry) => entry !== "client")
const PUBLISH = process.argv.includes("--publish")

// Dependencies that stay external (consumers install them)
const LIBRARY_EXTERNALS = [
  // Separate public bundles must share the machine index cache.
  "@claxedo/workspace-runtime/file-index",
  // Contract error classes cross package boundaries. Keep their identity owned
  // by the installed contract package rather than a bundled copy.
  "@claxedo/agent-runtime-contract",
  "@claxedo/agent-runtime-contract/*",
  "@claxedo/process-ownership",
  "@claxedo/process-ownership/*",
  // The harness names its engine boots in this registry and the stall monitor
  // reads it, so both must share the installed copy.
  "@claxedo/helpers/event-loop-activity",
  "@claxedo/session-core",
  "@claxedo/harness",
  "@claxedo/harness/*",
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
  /^@opencode-ai\//,
  /^hono(\/.*)?$/,
  /^@hono\//,
  /^node:/,
  "@lydell/node-pty",
  "better-sqlite3",
  "jose",
  "ws",
  "zod",
]

const REQUIRE_SHIM = "import {createRequire as __cr} from 'module';var require=__cr(import.meta.url);"

const NODE_OPTIONS: BuildOptions = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  mainFields: ["module", "main"],
  loader: { ".sh": "text", ".txt": "text" },
  banner: { js: REQUIRE_SHIM },
  logLevel: "info",
}

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

async function bundleClient() {
  await build({
    entryPoints: [path.join(ROOT, "src/client.ts")],
    outfile: path.join(DIST, "client.mjs"),
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    external: [...LIBRARY_EXTERNALS, ...EXTERNALS],
    logLevel: "info",
  })
}

async function bundleRepoJS() {
  for (const entry of [...NODE_ENTRIES, "cli"]) {
    await build({
      ...NODE_OPTIONS,
      entryPoints: [path.join(ROOT, `src/${entry}.ts`)],
      outfile: path.join(DIST, `${entry}.mjs`),
      external: [...LIBRARY_EXTERNALS, ...EXTERNALS],
    })
  }
  fs.chmodSync(path.join(DIST, "cli.mjs"), 0o755)
}

const Manifest = z.object({
  name: z.string().optional(),
  exports: z.record(z.string(), z.unknown()).optional(),
})

function readManifest(dir: string) {
  return Manifest.parse(JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")))
}

/**
 * The unpublished siblings the npm package carries in its dist. The publisher
 * drops them from the packed manifest and refuses a tarball that still imports
 * one, so a sibling missing here fails the release rather than the install.
 */
const INLINED_WHEN_PUBLISHED = [
  "@claxedo/harness",
  "@claxedo/plugin-api",
  "@claxedo/process-ownership",
  "@claxedo/session-core",
  "@claxedo/status-hooks",
]

/** Node's lookup, self-reference included: a package imports its own subpaths by name. */
function packageDir(name: string, from: string) {
  for (let directory = from; ; directory = path.dirname(directory)) {
    if (fs.existsSync(path.join(directory, "package.json")) && readManifest(directory).name === name) return directory
    const candidate = path.join(directory, "node_modules", name)
    if (fs.existsSync(path.join(candidate, "package.json"))) return fs.realpathSync(candidate)
    if (path.dirname(directory) === directory) throw new Error(`${name} is not installed above ${from}`)
  }
}

function sourceExport(name: string, specifier: string, from: string) {
  const dir = packageDir(name, from)
  const subpath = specifier === name ? "." : `.${specifier.slice(name.length)}`
  const target = readManifest(dir).exports?.[subpath]
  const source = typeof target === "string"
    ? target
    : typeof target === "object" && target !== null && "development" in target && typeof target.development === "string"
      ? target.development
      : undefined
  if (!source) throw new Error(`${specifier}: ${name} exports no development source for ${subpath}`)
  return path.join(dir, source)
}

/**
 * Resolves an inlined sibling to its source export, the graph the workspace
 * runs. Every other package, published siblings included, stays an import the
 * published manifest has to declare.
 */
function inlineSiblings(names: readonly string[]): Plugin {
  const inlined = new Set(names)
  return {
    name: "inline-unpublished-siblings",
    setup(builder) {
      builder.onResolve({ filter: /^@claxedo\// }, (args) => {
        const name = args.path.split("/").slice(0, 2).join("/")
        if (!inlined.has(name)) return undefined
        return { path: sourceExport(name, args.path, args.resolveDir) }
      })
    },
  }
}

/**
 * The npm build. Every public entry, the `workspace-runtime` bin and the
 * process-ownership launch gate child come out of one split build, so an
 * inlined sibling's classes and module state exist once however many entries
 * a consumer imports. Every npm import
 * stays external for the published manifest's dependencies to satisfy. The
 * Cursor SDK worker and the launch gate child are spawned by path, and each
 * looks for its file beside the chunk that spawns it, so chunks and both files
 * sit in dist/ itself.
 */
async function bundlePublishedJS() {
  await build({
    ...NODE_OPTIONS,
    entryPoints: {
      ...Object.fromEntries([...NODE_ENTRIES, "cli"].map((entry) => [entry, path.join(ROOT, `src/${entry}.ts`)])),
      "launch-gate-child": sourceExport("@claxedo/process-ownership", "@claxedo/process-ownership/launch-gate-child", ROOT),
    },
    outdir: DIST,
    outExtension: { ".js": ".mjs" },
    splitting: true,
    chunkNames: "[name]-[hash]",
    packages: "external",
    plugins: [inlineSiblings(INLINED_WHEN_PUBLISHED)],
  })
  fs.chmodSync(path.join(DIST, "cli.mjs"), 0o755)
  await bundleCursorWorker(DIST)
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
  await bundleClient()
  await (PUBLISH ? bundlePublishedJS() : bundleRepoJS())
  emitDeclarations()
  await bundleDeclarations()
  const patchOutput = path.join(DIST, "opencode-node")
  const staged = await stageOpenCodePatches(patchOutput)
  fs.writeFileSync(path.join(patchOutput, "package.json"), JSON.stringify({
    private: true, type: "module", claxedoDependencyPatches: staged.patches,
  }, null, 2))
  console.log(`\nBuild complete (${PUBLISH ? "npm" : "repo"}): public dist/*.mjs entries + bundled declarations`)
}

main().catch((err) => {
  console.error("Build failed:", err)
  process.exit(1)
})
