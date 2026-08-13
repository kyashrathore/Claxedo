#!/usr/bin/env bun
/**
 * Generate the V8 compile caches that ship beside the embedded engine and
 * beside the server bundle.
 *
 * The cache is produced by the SAME Electron binary that will consume it,
 * running the SAME V8 flags the server child runs, because both the V8 version
 * and the flag hash are part of the cache's identity — see
 * `src/shared/opencode-compile-cache.ts` for the five ways this can silently
 * produce a cache the runtime ignores.
 *
 * Only the entries whose source file lives INSIDE the artifact's own root
 * directory are shipped. Everything else the generator compiles (the generator
 * stub, and `@lydell/node-pty`, which resolves into the workspace store at
 * build time but into `opencode-engine/node_modules/` when packaged) has no
 * stable root-relative name, so its runtime key cannot be derived and it is
 * dropped rather than guessed at. Measured, that costs nothing: the engine ESM
 * blob is 2,831,468 bytes and carries the entire ~155 ms win, while the seven
 * node-pty CommonJS entries total ~16 KB.
 *
 * HOW THE SERVER BUNDLE IS CACHED WITHOUT STARTING A SERVER. The engine is an
 * inert library: importing it is enough. The server bundle is not — evaluating
 * it binds a port and opens a database, which a build must never do. It does
 * not have to. A module graph is COMPILED DURING INSTANTIATION, before any body
 * evaluates, and node persists an entry for every module it compiled even when
 * evaluation then throws. So the server bundle is imported with its startup
 * environment deliberately absent; `claxedoServerStartup` refuses, the body
 * throws on its first statement, and all 23 compiled chunks are still written.
 * `expectRefusal` makes that an assertion rather than a hope: if the import
 * ever SUCCEEDS, a server really did start during the build and the build
 * fails.
 */

import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { claxedoServerExecArgv } from "../src/main/server-runtime-policy"
import { claxedoServerStartup } from "./claxedo-server-startup"
import {
  OPENCODE_COMPILE_CACHE_DIR_NAME,
  OPENCODE_COMPILE_CACHE_MANIFEST_NAME,
  compileCacheEntryName,
  compileCacheSourceName,
  type CompileCacheCodeType,
  type CompileCacheManifest,
  type CompileCacheManifestEntry,
} from "../src/shared/opencode-compile-cache"

/** One `[compile cache] writing cache ...` line, as the runtime reported it. */
type ObservedEntry = {
  type: CompileCacheCodeType
  /** Exactly the string node hashed — a `file://` URL for ESM, a path for CommonJS. */
  source: string
  /** The entry filename node chose, recovered from the temporary file it wrote. */
  key: string
}

const WRITING = /^\[compile cache\] writing cache for (\S+) (.+?) to temporary file (.+?) \[/

const DEBUG_TYPES: Record<string, CompileCacheCodeType> = {
  ESM: "esm",
  CommonJS: "commonjs",
}

export function parseCompileCacheDebugOutput(stderr: string): ObservedEntry[] {
  const observed: ObservedEntry[] = []
  for (const line of stderr.split("\n")) {
    // The line ends in `...success` only when the blob actually reached disk.
    if (!line.includes("...success")) continue
    const match = WRITING.exec(line.trim())
    if (!match) continue
    const [, rawType, source, tempFile] = match
    const type = DEBUG_TYPES[rawType!]
    // TypeScript variants exist in the enum but never occur for this artifact.
    if (!type || !source || !tempFile) continue
    // `<dir>/<key>.<random>` — the key is the basename up to the first dot.
    observed.push({ type, source, key: path.basename(tempFile).split(".")[0]! })
  }
  return observed
}

/**
 * The generator child: enable a cache, import the artifact, let the exit hook
 * persist.
 *
 * The import is caught and the failure REPORTED rather than rethrown, because
 * for the server bundle a refusal is the expected outcome and the entries are
 * already compiled by the time it happens. The caller decides whether a given
 * artifact was allowed to throw.
 */
const GENERATOR_STUB = `import { enableCompileCache, getCompileCacheDir } from "node:module"
import { writeFileSync } from "node:fs"
import { pathToFileURL } from "node:url"

const [, , base, entry, report] = process.argv
const result = enableCompileCache(base)
if (result.status === 0) {
  console.error("[compile-cache] runtime refused to enable a compile cache: " + (result.message ?? "unknown"))
  process.exit(1)
}
const directory = getCompileCacheDir()
let refused
try {
  await import(pathToFileURL(entry).href)
} catch (error) {
  refused = error instanceof Error ? error.message : String(error)
}
writeFileSync(report, JSON.stringify({ directory, refused }))
process.exit(0)
`

export async function buildCompileCache(input: {
  /** The module whose STATIC closure is compiled and cached. */
  entryPath: string
  /**
   * Directory the manifest's `file` paths are relative to, and the boundary
   * outside which compiled entries are dropped. Defaults to the entry's own
   * directory, which is what the engine wants; the server bundle's entry lives
   * in `chunks/` while its root is the bundle directory above it.
   */
  rootDir?: string
  outputDir: string
  electronPath: string
  /**
   * Environment overrides for the generator child. A key set to `undefined` is
   * REMOVED from the inherited environment — which is how the server bundle's
   * startup variables are guaranteed absent even on a developer machine that
   * happens to export them.
   */
  env?: Record<string, string | undefined>
  /**
   * The substring the artifact's own evaluation must fail with. When set, an
   * import that SUCCEEDS fails the build: the artifact ran when it was only
   * supposed to compile. When unset, any failure fails the build.
   */
  expectRefusal?: string
  log?: (message: string) => void
}): Promise<{ manifest: CompileCacheManifest; dropped: ObservedEntry[] }> {
  const log = input.log ?? (() => {})
  const entryPath = path.resolve(input.entryPath)
  if (!fs.existsSync(entryPath)) {
    throw new Error(`compile cache source artifact not found at ${entryPath}; build it first`)
  }
  // REALPATH, not merely resolve. Every name the runtime hashes is
  // post-symlink-resolution (node's ESM resolver realpaths), so a root that is
  // still a symlink — `/tmp` on macOS is `/private/tmp` — makes every entry
  // look like it lives outside the artifact and drops the whole cache.
  const rootDir = fs.realpathSync(path.resolve(input.rootDir ?? path.dirname(entryPath)))

  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-compile-cache-"))
  try {
    const stub = path.join(staging, "generate.mjs")
    const report = path.join(staging, "report.json")
    const base = path.join(staging, "base")
    fs.writeFileSync(stub, GENERATOR_STUB)

    // The flags come from the policy the server child actually forks with, not
    // from a copy of them here: a re-spelling that drifted would move the flag
    // hash and file the cache under a directory tag the child never reads.
    const execArgv = claxedoServerExecArgv()
    log(`generating with ${execArgv.join(" ")}`)
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ELECTRON_RUN_AS_NODE: "1",
      // The runtime's own account of what it cached, which is the only
      // authority on the entry names this build must reproduce.
      NODE_DEBUG_NATIVE: "COMPILE_CACHE",
    }
    for (const [key, value] of Object.entries(input.env ?? {})) {
      if (value === undefined) delete env[key]
      else env[key] = value
    }
    const run = spawnSync(input.electronPath, [...execArgv, stub, base, entryPath, report], {
      env,
      encoding: "utf8",
      timeout: 300_000,
      maxBuffer: 64 * 1024 * 1024,
    })
    if (run.status !== 0) {
      throw new Error(
        `compile cache generation failed (status ${run.status}, signal ${run.signal})\n${run.stderr?.slice(-4000) ?? ""}`,
      )
    }
    const { directory, refused } = JSON.parse(fs.readFileSync(report, "utf8")) as {
      directory?: string
      refused?: string
    }
    if (!directory) throw new Error("compile cache generation reported no cache directory")
    assertEvaluation({ entryPath, refused, expectRefusal: input.expectRefusal, log })

    const observed = parseCompileCacheDebugOutput(run.stderr ?? "")
    if (observed.length === 0) {
      throw new Error("compile cache generation produced no entries; the runtime wrote nothing")
    }

    // THE BUILD-TIME SELF-CHECK. `compileCacheEntryName` reimplements
    // `GetCacheKey` from node's C++, which carries no stability guarantee — so
    // it is checked against every filename the runtime actually chose. The same
    // Electron binary ships, so agreement here is agreement at runtime, and a
    // node change fails this build instead of silently shipping a dead cache.
    for (const entry of observed) {
      const computed = compileCacheEntryName(entry.source, entry.type)
      if (computed !== entry.key) {
        throw new Error(
          `compile cache key derivation disagrees with the runtime: ${entry.type} ${entry.source} ` +
            `hashed to ${computed} but the runtime wrote ${entry.key}. ` +
            `GetCacheKey in node's src/compile_cache.cc has changed; update compileCacheEntryName.`,
        )
      }
    }
    log(`verified ${observed.length} cache key(s) against the runtime`)

    const entries: CompileCacheManifestEntry[] = []
    const dropped: ObservedEntry[] = []
    fs.rmSync(input.outputDir, { recursive: true, force: true })
    fs.mkdirSync(input.outputDir, { recursive: true })

    for (const entry of observed) {
      const file = rootRelativeFile(entry, rootDir)
      if (!file) {
        dropped.push(entry)
        continue
      }
      // ...and the other half of the check: that the name the RUNTIME will
      // derive from the root-relative path is the one just verified. This is
      // the derivation `seedShippedCompileCaches` performs on the user's
      // machine, exercised here against the real artifact.
      const derived = compileCacheSourceName(path.join(rootDir, file), entry.type)
      if (derived !== entry.source) {
        throw new Error(
          `compile cache source derivation disagrees with the runtime: derived ${derived}, runtime used ${entry.source}`,
        )
      }
      const blob = `${file.replace(/[\\/]/g, "_")}.${entry.type}.v8cache`
      const from = path.join(directory, entry.key)
      const bytes = fs.statSync(from).size
      const to = path.join(input.outputDir, blob)
      fs.copyFileSync(from, to)
      // The runtime creates its cache directory 0700 and its entries 0600, so a
      // straight copy would ship a blob only the BUILD user can read. Every
      // customer would then fail the read, swallow it, and miss.
      fs.chmodSync(to, 0o644)
      entries.push({ file, type: entry.type, blob, bytes })
    }

    if (entries.length === 0) {
      throw new Error(`compile cache generation cached nothing inside ${rootDir}; the artifact was not compiled`)
    }

    const manifest: CompileCacheManifest = { version: 1, entries }
    fs.writeFileSync(
      path.join(input.outputDir, OPENCODE_COMPILE_CACHE_MANIFEST_NAME),
      `${JSON.stringify(manifest, null, 2)}\n`,
    )
    return { manifest, dropped }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
  }
}

/**
 * The cached file's path relative to the artifact's root directory, or
 * undefined when it lives outside it and therefore has no derivable runtime
 * location.
 */
function rootRelativeFile(entry: ObservedEntry, rootDir: string): string | undefined {
  const filePath = entry.type === "esm" ? safeFileURLToPath(entry.source) : entry.source
  if (!filePath) return undefined
  const relative = path.relative(rootDir, filePath)
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return undefined
  return relative
}

/**
 * Whether the artifact behaved as the caller said it would while it was being
 * compiled.
 *
 * An artifact declared inert must not throw, and an artifact declared to refuse
 * must not run. The second half is the important one: it is the only thing
 * standing between "the build compiled the server bundle" and "the build
 * started a server, bound a port and opened a database".
 */
function assertEvaluation(input: {
  entryPath: string
  refused: string | undefined
  expectRefusal: string | undefined
  log: (message: string) => void
}) {
  const { entryPath, refused, expectRefusal, log } = input
  if (!expectRefusal) {
    if (refused) throw new Error(`compile cache generation failed while importing ${entryPath}: ${refused}`)
    return
  }
  if (!refused) {
    throw new Error(
      `${entryPath} was expected to refuse to run during compile cache generation and instead evaluated ` +
        `successfully. The build must never start a server; check that its startup environment is absent.`,
    )
  }
  if (!refused.includes(expectRefusal)) {
    throw new Error(
      `${entryPath} failed during compile cache generation for an unexpected reason: ${refused}. ` +
        `Expected a refusal containing ${JSON.stringify(expectRefusal)}.`,
    )
  }
  log(`${path.basename(entryPath)} refused to run as expected: ${refused}`)
}

function safeFileURLToPath(source: string): string | undefined {
  try {
    return new URL(source).protocol === "file:" ? decodeURIComponent(new URL(source).pathname) : undefined
  } catch {
    return undefined
  }
}

export function resolveElectronBinary(fromDir: string): string {
  const require = createRequire(path.join(fromDir, "package.json"))
  return require("electron") as string
}

/** The embedded engine artifact: an inert library, so importing it is enough. */
export function buildOpenCodeCompileCache(input: {
  enginePath: string
  outputDir: string
  electronPath: string
  log?: (message: string) => void
}) {
  return buildCompileCache({ entryPath: input.enginePath, ...input })
}

/**
 * The message `claxedoServerStartup` refuses an empty environment with, taken
 * from the producer rather than copied.
 *
 * If that validation is ever relaxed the server bundle would EVALUATE during
 * the build, and this call is what turns that into a failure at the first
 * opportunity instead of a server booting inside `bun run prebuild`.
 */
export function serverStartupRefusal(): string {
  try {
    claxedoServerStartup({})
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error(
    "claxedoServerStartup accepted an empty environment, so the server bundle would RUN during the build " +
      "instead of merely compiling. Compile cache generation cannot proceed safely.",
  )
}

/**
 * The server bundle's own static closure — the 9.11 MB behind
 * `claxedo-server-boot.ts`'s dynamic import.
 *
 * Entered at the DEFERRED chunk, not at `index.js`: the boot stub refuses the
 * same empty environment and would throw before its dynamic import, compiling
 * nothing. Keyed relative to the BUNDLE directory, because that is what the
 * child resolves `import.meta.dirname` to at runtime.
 */
export function buildClaxedoServerCompileCache(input: {
  /** The chunk `index.js` dynamically imports; `bundleClaxedoServer` returns it. */
  deferredEntryPath: string
  /** The bundle root, i.e. the directory holding `index.js`. */
  bundleDir: string
  outputDir: string
  electronPath: string
  log?: (message: string) => void
}) {
  return buildCompileCache({
    entryPath: input.deferredEntryPath,
    rootDir: input.bundleDir,
    outputDir: input.outputDir,
    electronPath: input.electronPath,
    // Absent, not merely unset here: a developer shell that exports these would
    // otherwise let the build start a real server.
    env: { CLAXEDO_CHILD_PORT: undefined, CLAXEDO_DESKTOP_PARENT_PID: undefined },
    expectRefusal: serverStartupRefusal(),
    ...(input.log ? { log: input.log } : {}),
  })
}

if (import.meta.main) {
  const packageDir = path.resolve(import.meta.dir, "..")
  const enginePath = path.resolve(packageDir, "../opencode/dist/node/node.js")
  const outputDir = path.resolve(packageDir, "resources", OPENCODE_COMPILE_CACHE_DIR_NAME)
  const { manifest, dropped } = await buildOpenCodeCompileCache({
    enginePath,
    outputDir,
    electronPath: resolveElectronBinary(packageDir),
    log: (message) => console.log(`[compile-cache] ${message}`),
  })
  for (const entry of manifest.entries) {
    console.log(`[compile-cache] shipping ${entry.file} (${entry.type}, ${entry.bytes} bytes)`)
  }
  if (dropped.length > 0) {
    console.log(`[compile-cache] skipped ${dropped.length} entr(ies) outside ${path.dirname(enginePath)}`)
  }
}
