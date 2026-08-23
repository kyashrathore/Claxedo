import { afterAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { pathToFileURL } from "node:url"

import { claxedoServerExecArgv } from "../src/main/server-runtime-policy"
import {
  COMPILE_CACHE_SEED_COMPLETE_NAME,
  OPENCODE_COMPILE_CACHE_MANIFEST_NAME,
  compileCacheEntryName,
  compileCacheSourceName,
} from "../src/shared/opencode-compile-cache"
import { bundleClaxedoServer } from "./bundle-claxedo-server"
import {
  buildClaxedoServerCompileCache,
  buildOpenCodeCompileCache,
  resolveElectronBinary,
} from "./build-opencode-compile-cache"

/**
 * Boot-level coverage for the shipped V8 compile cache.
 *
 * These tests assert the runtime's OWN verdict, taken from
 * `NODE_DEBUG_NATIVE=COMPILE_CACHE`, which distinguishes
 *
 *   HIT   "...was accepted, keeping the in-memory entry"
 *   MISS  "...was not initialized, initializing the in-memory entry"
 *
 * A test that asserted the seeded directory or file merely EXISTS would pass on
 * a cache that missed on every launch, which is the entire failure mode this
 * slice exists to avoid — and it is not hypothetical: it is what a naive
 * verbatim copy of the generated entries actually does.
 *
 * THE LOAD-BEARING CASE is "first launch on a fresh profile HITS". The engine is
 * copied to a directory that is NOT the build directory, because the cache entry
 * FILENAME is a hash of the module's own resolved path (node
 * `src/compile_cache.cc` GetCacheKey). Shipping the generated entries under
 * their generated names hits on the build machine and misses for every
 * customer; the ablation test below pins that difference. The copy must be a
 * real copy and never a symlink — node's ESM resolver realpaths, so a symlink
 * would resolve back to the build path and the test would pass for the wrong
 * reason.
 */

const SCRIPT_DIR = import.meta.dir
const PACKAGE_DIR = path.resolve(SCRIPT_DIR, "..")
const ENGINE_ARTIFACT = path.resolve(PACKAGE_DIR, "../opencode/dist/node/node.js")
const HARNESS = path.resolve(SCRIPT_DIR, "fixtures/opencode-compile-cache-harness.ts")

type Outcome = { status: string; entries: number; reason?: string; directory?: string; refused?: string[] }
type Launch = { code: number | null; stderr: string; outcome: Outcome | undefined }

function engineIsBuilt() {
  if (fs.existsSync(ENGINE_ARTIFACT)) return true
  console.warn("[skip] embedded engine artifact missing — run `bun run predev` first")
  return false
}

/** The exact URL node uses to key a module, derived independently of the module under test. */
function engineUrl(modulePath: string) {
  return pathToFileURL(fs.realpathSync(modulePath)).href
}

function hitLine(modulePath: string) {
  return `V8 code cache for ESM ${engineUrl(modulePath)} was accepted, keeping the in-memory entry`
}

function missLine(modulePath: string) {
  return `V8 code cache for ESM ${engineUrl(modulePath)} was not initialized, initializing the in-memory entry`
}

/**
 * An installed app: the engine at a path that is NOT the build path, its native
 * sibling reachable, and a freshly generated shipped cache built from the BUILD
 * location — exactly the build-path/install-path split a real user gets.
 */
function installFixture(root: string) {
  const engineDir = path.join(root, "Resources", "opencode-engine")
  fs.mkdirSync(engineDir, { recursive: true })
  const buildDir = path.dirname(ENGINE_ARTIFACT)
  for (const entry of fs.readdirSync(buildDir)) {
    if (!entry.endsWith(".js") && !entry.endsWith(".wasm")) continue
    fs.copyFileSync(path.join(buildDir, entry), path.join(engineDir, entry))
  }
  const enginePath = path.join(engineDir, "node.js")
  expect(fs.realpathSync(enginePath)).not.toBe(fs.realpathSync(ENGINE_ARTIFACT))

  // The engine imports `@lydell/node-pty` bare at the top level; packaging ships
  // it as a sibling. A link is fine here — nothing is asserted about its entries.
  const modules = path.join(engineDir, "node_modules", "@lydell")
  fs.mkdirSync(modules, { recursive: true })
  for (const name of ["node-pty", `node-pty-${process.platform}-${process.arch}`]) {
    const resolved = resolveWorkspacePackage(name)
    if (resolved) fs.symlinkSync(resolved, path.join(modules, name))
  }
  return { engineDir, enginePath }
}

function resolveWorkspacePackage(name: string) {
  const store = path.resolve(PACKAGE_DIR, "../../node_modules/.bun")
  if (!fs.existsSync(store)) return undefined
  const prefix = `@lydell+${name}@`
  const match = fs
    .readdirSync(store)
    .filter((entry) => entry.startsWith(prefix))
    .map((entry) => path.join(store, entry, "node_modules", "@lydell", name))
    .find((dir) => fs.existsSync(dir))
  return match
}

let bundledHarness: string | undefined
/** Bundle the harness the way the shipped server bundle is built, once per file. */
function harnessBundle() {
  if (bundledHarness) return bundledHarness
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-cc-harness-"))
  const built = spawnSync(
    "bun",
    ["build", HARNESS, "--target=node", "--format=esm", "--outfile", path.join(out, "harness.mjs")],
    { encoding: "utf8", cwd: PACKAGE_DIR },
  )
  if (built.status !== 0) throw new Error(`harness bundle failed: ${built.stderr}`)
  bundledHarness = path.join(out, "harness.mjs")
  return bundledHarness
}

/** One server-child launch: real Electron, real server V8 flags, real artifact import. */
function launch(input: {
  dataDir: string
  shippedDir: string | undefined
  enginePath: string
  serverShippedDir?: string | undefined
  serverRootDir?: string
  deferredEntry?: string
}): Launch {
  const report = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-cc-report-")), "outcome.json")
  const run = spawnSync(
    resolveElectronBinary(PACKAGE_DIR),
    [
      ...claxedoServerExecArgv(),
      harnessBundle(),
      input.dataDir,
      input.shippedDir ?? "-",
      input.enginePath,
      report,
      input.serverShippedDir ?? "-",
      input.serverRootDir ?? "-",
      input.deferredEntry ?? "-",
    ],
    {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", NODE_DEBUG_NATIVE: "COMPILE_CACHE" },
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 64 * 1024 * 1024,
    },
  )
  return {
    code: run.status,
    stderr: run.stderr ?? "",
    outcome: fs.existsSync(report) ? (JSON.parse(fs.readFileSync(report, "utf8")) as Outcome) : undefined,
  }
}

async function withFixture(run: (root: string) => Promise<void>): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-compile-cache-"))
  try {
    await run(root)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

async function shippedCache(root: string, enginePath: string) {
  const outputDir = path.join(root, "shipped")
  await buildOpenCodeCompileCache({
    // Generated from the BUILD location, as the real build does...
    enginePath: ENGINE_ARTIFACT,
    outputDir,
    electronPath: resolveElectronBinary(PACKAGE_DIR),
  })
  // ...and never from the install location, which is what makes this a real test.
  expect(path.dirname(enginePath)).not.toBe(path.dirname(ENGINE_ARTIFACT))
  return outputDir
}

test("first launch on a fresh profile HITS the shipped cache at an install path that is not the build path", async () => {
  if (!engineIsBuilt()) return
  await withFixture(async (root) => {
    const { enginePath } = installFixture(root)
    const shipped = await shippedCache(root, enginePath)
    const dataDir = path.join(root, "profile")

    const first = launch({ dataDir, shippedDir: shipped, enginePath })

    expect(first.code).toBe(0)
    expect(first.outcome).toMatchObject({ status: "seeded", entries: 1 })
    // The runtime's own verdict, on the very first launch of a fresh profile.
    expect(first.stderr).toContain(hitLine(enginePath))
    expect(first.stderr).not.toContain(missLine(enginePath))
  })
}, 180_000)

test("ABLATION: the same blob under the BUILD-path key MISSES — shipping the entries verbatim gains nothing", async () => {
  if (!engineIsBuilt()) return
  await withFixture(async (root) => {
    const { enginePath } = installFixture(root)
    const shipped = await shippedCache(root, enginePath)
    const dataDir = path.join(root, "profile")
    const manifest = JSON.parse(
      fs.readFileSync(path.join(shipped, OPENCODE_COMPILE_CACHE_MANIFEST_NAME), "utf8"),
    ) as { entries: { blob: string }[] }
    const blob = path.join(shipped, manifest.entries[0]!.blob)

    // The corrected design, for contrast.
    const seeded = launch({ dataDir, shippedDir: shipped, enginePath })
    expect(seeded.stderr).toContain(hitLine(enginePath))
    const computed = seeded.outcome!.directory!

    // The briefed design: file the identical bytes under the name the GENERATOR
    // produced — the key for the build path — inside the very same directory.
    const buildKey = compileCacheEntryName(compileCacheSourceName(ENGINE_ARTIFACT, "esm"), "esm")
    const runtimeKey = compileCacheEntryName(compileCacheSourceName(enginePath, "esm"), "esm")
    expect(buildKey).not.toBe(runtimeKey)
    fs.rmSync(computed, { recursive: true, force: true })
    fs.mkdirSync(computed, { recursive: true })
    fs.copyFileSync(blob, path.join(computed, buildKey))
    fs.writeFileSync(path.join(computed, COMPILE_CACHE_SEED_COMPLETE_NAME), "1\n")

    // A completed seed is left alone, so this launch consumes exactly what a
    // verbatim ship would have placed there.
    const verbatim = launch({ dataDir, shippedDir: shipped, enginePath })

    expect(verbatim.outcome).toMatchObject({ status: "already-seeded" })
    expect(verbatim.code).toBe(0)
    expect(verbatim.stderr).toContain(missLine(enginePath))
    expect(verbatim.stderr).not.toContain(hitLine(enginePath))
  })
}, 240_000)

test("a missing shipped cache still boots, and reports a MISS", async () => {
  if (!engineIsBuilt()) return
  await withFixture(async (root) => {
    const { enginePath } = installFixture(root)
    const shipped = await shippedCache(root, enginePath)
    fs.rmSync(shipped, { recursive: true, force: true })

    const run = launch({ dataDir: path.join(root, "profile"), shippedDir: shipped, enginePath })

    expect(run.code).toBe(0)
    // The cache is still switched on, so this launch pays the compile and the
    // next one does not — it just has nothing shipped to seed from.
    expect(run.outcome).toMatchObject({ status: "not-seeded", enabled: true, entries: 0 })
    expect(run.stderr).toContain(missLine(enginePath))
  })
}, 180_000)

test("a second launch does not re-seed and still HITS", async () => {
  if (!engineIsBuilt()) return
  await withFixture(async (root) => {
    const { enginePath } = installFixture(root)
    const shipped = await shippedCache(root, enginePath)
    const dataDir = path.join(root, "profile")

    const first = launch({ dataDir, shippedDir: shipped, enginePath })
    expect(first.outcome).toMatchObject({ status: "seeded", entries: 1 })
    const seededDir = first.outcome!.directory!
    const seededFile = path.join(seededDir, fs.readdirSync(seededDir).find((entry) => !entry.startsWith("."))!)
    const stamp = fs.statSync(seededFile).mtimeMs

    const second = launch({ dataDir, shippedDir: shipped, enginePath })

    expect(second.outcome).toMatchObject({ status: "already-seeded", entries: 0 })
    // Not re-copied: the seeded blob is the same file the first launch wrote.
    expect(fs.statSync(seededFile).mtimeMs).toBe(stamp)
    expect(second.stderr).toContain(hitLine(enginePath))
  })
}, 240_000)

test("a broken shipped cache still boots", async () => {
  if (!engineIsBuilt()) return
  await withFixture(async (root) => {
    const { enginePath } = installFixture(root)
    const shipped = await shippedCache(root, enginePath)
    // Permission bits are not a portable unreadability primitive: Windows ACLs
    // ignore chmod(000), and uid 0 can still read it on Unix. A malformed
    // shipped manifest exercises the same canonical parse/read failure at the
    // real boot boundary on every platform.
    fs.writeFileSync(path.join(shipped, OPENCODE_COMPILE_CACHE_MANIFEST_NAME), "{ not json")
    const run = launch({ dataDir: path.join(root, "profile"), shippedDir: shipped, enginePath })

    expect(run.code).toBe(0)
    // Present but broken is a real failure, reported as one — and still not a
    // boot failure.
    expect(run.outcome?.status).toBe("failed")
    expect(run.stderr).toContain(missLine(enginePath))
  })
}, 180_000)

/**
 * THE SERVER BUNDLE'S OWN CLOSURE.
 *
 * The engine was always reachable: it is imported lazily, so a cache switched on
 * in a module body still precedes it. The server bundle was not. Node compiles
 * and links an entire static ESM graph before any body runs, so while
 * `enableCompileCache` lived inside `claxedo-server-entry.ts` the bundle's own
 * 9.11 MB was already compiled by the time the cache existed — measured at 41.0
 * ms of pure V8 compile on every launch, and corroborated by the shipped
 * manifest, which held exactly one entry (`node.js`) and nothing of the server.
 *
 * `claxedo-server-boot.ts` moves the whole closure behind a dynamic import. The
 * tests below assert the consequence the same way as above: the runtime's own
 * HIT/MISS verdict, on a FIRST launch of a FRESH profile, for the PRODUCT ENTRY
 * chunk specifically, at an install path that is not the build path.
 */
describe("the server bundle's own static closure", () => {
  /** Built once: bundling the real server is the expensive part of this file. */
  let built: { buildDir: string; entry: string; deferredEntry: string } | undefined
  let buildRoot: string | undefined

  afterAll(() => {
    if (buildRoot) fs.rmSync(buildRoot, { recursive: true, force: true })
  })

  /**
   * The bundle at its BUILD location, under the package so that
   * `better-sqlite3` — the closure's only non-builtin static bare import —
   * resolves from the workspace exactly as it does during `prebuild`.
   */
  async function serverBundle() {
    if (built) return built
    const artifactRoot = path.join(PACKAGE_DIR, ".artifacts", "compile-cache-build")
    fs.mkdirSync(artifactRoot, { recursive: true })
    buildRoot = fs.mkdtempSync(path.join(artifactRoot, "run-"))
    const buildDir = path.join(buildRoot, "claxedo-server")
    const bundled = await bundleClaxedoServer(path.join(SCRIPT_DIR, "claxedo-server-boot.ts"), buildDir)
    built = { buildDir, entry: bundled.entry, deferredEntry: bundled.deferredEntry }
    return built
  }

  /** A real copy at a DIFFERENT path, with the native module reachable from it. */
  function installBundle(root: string, buildDir: string) {
    const installDir = path.join(root, "Resources", "claxedo-server")
    // A real copy and never a symlink: node's ESM resolver realpaths, so a
    // symlinked install would resolve back to the build path and the test would
    // pass for exactly the wrong reason.
    fs.cpSync(buildDir, installDir, { recursive: true, dereference: true })
    expect(fs.realpathSync(installDir)).not.toBe(fs.realpathSync(buildDir))

    const require = createRequire(path.join(PACKAGE_DIR, "package.json"))
    const sqlite = path.dirname(require.resolve("better-sqlite3/package.json"))
    fs.mkdirSync(path.join(installDir, "node_modules"), { recursive: true })
    fs.symlinkSync(sqlite, path.join(installDir, "node_modules", "better-sqlite3"))
    return installDir
  }

  /** The deferred chunk's path INSIDE a given bundle directory. */
  const deferredIn = (bundleDir: string, deferredEntry: string, buildDir: string) =>
    path.join(bundleDir, path.relative(buildDir, deferredEntry))

  async function shippedServerCache(root: string, buildDir: string, deferredEntry: string) {
    const outputDir = path.join(root, "server-shipped")
    await buildClaxedoServerCompileCache({
      // Generated from the BUILD location, as the real build does...
      deferredEntryPath: deferredEntry,
      bundleDir: buildDir,
      outputDir,
      electronPath: resolveElectronBinary(PACKAGE_DIR),
    })
    return outputDir
  }

  test("the generator caches the closure WITHOUT ever starting a server", async () => {
    const { buildDir, deferredEntry } = await serverBundle()
    await withFixture(async (root) => {
      const shipped = await shippedServerCache(root, buildDir, deferredEntry)
      const manifest = JSON.parse(
        fs.readFileSync(path.join(shipped, OPENCODE_COMPILE_CACHE_MANIFEST_NAME), "utf8"),
      ) as { entries: { file: string; bytes: number }[] }

      // The product entry carries the mass, and it is the one that could not be
      // cached before. `index.js` is deliberately absent: it is the process
      // entry, compiled before the cache is seeded, and it is now 4 KB.
      const files = manifest.entries.map((entry) => entry.file)
      expect(files).toContain(path.relative(buildDir, deferredEntry))
      expect(files).not.toContain("index.js")
      expect(manifest.entries.length).toBeGreaterThan(20)
    })
  }, 600_000)

  test("a FIRST launch on a FRESH profile HITS the product entry at an install path that is not the build path", async () => {
    const { buildDir, deferredEntry } = await serverBundle()
    await withFixture(async (root) => {
      const shipped = await shippedServerCache(root, buildDir, deferredEntry)
      const installDir = installBundle(root, buildDir)
      const installedEntry = deferredIn(installDir, deferredEntry, buildDir)
      // The premise of the whole slice: the install key is NOT the build key.
      expect(compileCacheEntryName(compileCacheSourceName(installedEntry, "esm"), "esm")).not.toBe(
        compileCacheEntryName(compileCacheSourceName(deferredEntry, "esm"), "esm"),
      )

      const first = launch({
        dataDir: path.join(root, "profile"),
        shippedDir: undefined,
        enginePath: "-",
        serverShippedDir: shipped,
        serverRootDir: installDir,
        deferredEntry: installedEntry,
      })

      expect(first.code).toBe(0)
      expect(first.outcome?.status).toBe("seeded")
      // THE ASSERTION. The runtime's own verdict on the 7.8 MB product entry,
      // on the very first launch of a fresh profile.
      expect(first.stderr).toContain(hitLine(installedEntry))
      expect(first.stderr).not.toContain(missLine(installedEntry))
      // And it compiled the closure without running it — the refusal is the
      // product's own startup validation, reached only after 9.11 MB compiled.
      expect(first.outcome?.refused?.join("\n")).toContain("missing its startup configuration")
    })
  }, 600_000)

  test("without the shipped entries the same launch MISSES, and still boots", async () => {
    // The negative that makes the positive mean something: identical fixture,
    // identical code path, nothing shipped to seed from.
    const { buildDir, deferredEntry } = await serverBundle()
    await withFixture(async (root) => {
      const installDir = installBundle(root, buildDir)
      const installedEntry = deferredIn(installDir, deferredEntry, buildDir)

      const run = launch({
        dataDir: path.join(root, "profile"),
        shippedDir: undefined,
        enginePath: "-",
        serverShippedDir: undefined,
        serverRootDir: installDir,
        deferredEntry: installedEntry,
      })

      expect(run.code).toBe(0)
      // The cache is still switched on, so this launch pays the compile and
      // writes one for a next launch the benchmark's fresh profile never gets.
      expect(run.outcome).toMatchObject({ status: "not-seeded", enabled: true, entries: 0 })
      expect(run.stderr).toContain(missLine(installedEntry))
      expect(run.stderr).not.toContain(hitLine(installedEntry))
    })
  }, 600_000)

  test("ABLATION: the same blob under the BUILD-path key MISSES", async () => {
    const { buildDir, deferredEntry } = await serverBundle()
    await withFixture(async (root) => {
      const shipped = await shippedServerCache(root, buildDir, deferredEntry)
      const installDir = installBundle(root, buildDir)
      const installedEntry = deferredIn(installDir, deferredEntry, buildDir)
      const manifest = JSON.parse(
        fs.readFileSync(path.join(shipped, OPENCODE_COMPILE_CACHE_MANIFEST_NAME), "utf8"),
      ) as { entries: { file: string; blob: string }[] }
      const relative = path.relative(buildDir, deferredEntry)
      const blob = path.join(shipped, manifest.entries.find((entry) => entry.file === relative)!.blob)

      const seeded = launch({
        dataDir: path.join(root, "profile"),
        shippedDir: undefined,
        enginePath: "-",
        serverShippedDir: shipped,
        serverRootDir: installDir,
        deferredEntry: installedEntry,
      })
      expect(seeded.stderr).toContain(hitLine(installedEntry))
      const computed = seeded.outcome!.directory!

      // What shipping the generated entries VERBATIM would have placed there:
      // the identical bytes under the key for the BUILD path.
      fs.rmSync(computed, { recursive: true, force: true })
      fs.mkdirSync(computed, { recursive: true })
      fs.copyFileSync(blob, path.join(computed, compileCacheEntryName(compileCacheSourceName(deferredEntry, "esm"), "esm")))
      fs.writeFileSync(path.join(computed, COMPILE_CACHE_SEED_COMPLETE_NAME), "1\n")

      const verbatim = launch({
        dataDir: path.join(root, "profile"),
        shippedDir: undefined,
        enginePath: "-",
        serverShippedDir: shipped,
        serverRootDir: installDir,
        deferredEntry: installedEntry,
      })

      expect(verbatim.outcome).toMatchObject({ status: "already-seeded" })
      expect(verbatim.stderr).toContain(missLine(installedEntry))
      expect(verbatim.stderr).not.toContain(hitLine(installedEntry))
    })
  }, 900_000)

  test("the process entry compiles almost nothing; the product closure is behind the dynamic boundary", async () => {
    // THE DEFECT THIS SLICE EXISTS FOR, stated as a property of the artifact.
    //
    // Whatever is STATICALLY reachable from the process entry is compiled during
    // instantiation, before any body runs — so it is compiled before the seed
    // and can never be cached, on launch one or launch fifty. Whatever is behind
    // the dynamic import is compiled after. Before `claxedo-server-boot.ts` the
    // first set WAS the product: 9.11 MB, uncacheable by construction.
    //
    // Measured on the emitted files rather than argued from the source, because
    // the property belongs to what the bundler produced.
    const { buildDir, entry, deferredEntry } = await serverBundle()
    const eager = staticClosureBytes(entry)
    const deferred = staticClosureBytes(deferredEntry)

    // The product entry is NOT in the entry's static closure. This is the whole
    // fix; make it static again and this is the assertion that goes red.
    expect(eager.files).not.toContain(fs.realpathSync(deferredEntry))
    expect(deferred.files).toContain(fs.realpathSync(deferredEntry))

    // Sizes, so a regression that smuggled the product back across the boundary
    // one chunk at a time is caught before it is complete.
    expect(eager.bytes).toBeLessThan(256 * 1024)
    expect(deferred.bytes).toBeGreaterThan(8 * 1024 * 1024)
    expect(path.dirname(deferredEntry)).toBe(path.join(buildDir, "chunks"))
  }, 600_000)
})

/**
 * Every file reachable by STATIC `import` / `export ... from` from a module,
 * and their total size — i.e. exactly what node compiles during instantiation,
 * before the module's own body can enable anything.
 *
 * Dynamic `import()` is deliberately NOT followed: that is the boundary under
 * test.
 */
function staticClosureBytes(entry: string) {
  const STATIC = /(?:^|[;}\s])(?:import|export)\s*(?:[^;"']*?\bfrom\s*)?["']([^"']+)["']/g
  const files = new Set<string>()
  const pending = [fs.realpathSync(entry)]
  let bytes = 0
  while (pending.length > 0) {
    const file = pending.pop()!
    if (files.has(file)) continue
    files.add(file)
    const source = fs.readFileSync(file, "utf8")
    bytes += Buffer.byteLength(source)
    for (const [, specifier] of source.matchAll(STATIC)) {
      if (!specifier?.startsWith(".")) continue
      const resolved = path.resolve(path.dirname(file), specifier)
      if (fs.existsSync(resolved)) pending.push(fs.realpathSync(resolved))
    }
  }
  return { files: [...files], bytes }
}
