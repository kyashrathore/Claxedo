import { describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { pathToFileURL } from "node:url"

import {
  COMPILE_CACHE_SEED_COMPLETE_NAME,
  OPENCODE_COMPILE_CACHE_BASE_DIR_NAME,
  OPENCODE_COMPILE_CACHE_MANIFEST_NAME,
  compileCacheEntryName,
  compileCacheSourceName,
  enableShippedCompileCaches,
  parseCompileCacheManifest,
  seedShippedCompileCaches,
} from "./opencode-compile-cache"

/**
 * The end-to-end proof that the seeded cache is actually READ lives in
 * scripts/opencode-compile-cache-boot.test.ts, which asserts the runtime's own
 * HIT/MISS verdict. These tests pin the two things that must not drift
 * underneath it: the key derivation, and the failure behaviour.
 */

describe("compile cache key derivation", () => {
  /**
   * Recorded from a real `NODE_DEBUG_NATIVE=COMPILE_CACHE` run on
   * Electron 43.2.0 / Node 24.18.0 — the filenames the runtime ACTUALLY wrote,
   * including the real 23 MB engine artifact. This reimplements `GetCacheKey`
   * from node's `src/compile_cache.cc` (crc32 of the type byte, then of the
   * name), so it is pinned against the producer rather than against itself.
   *
   * The build regenerates this agreement on every run and fails loudly if node
   * changes the scheme; see scripts/build-opencode-compile-cache.ts.
   *
   * The `name` strings are VERBATIM recorded paths and are hashed as-is —
   * including the historical worktree directory names in them. Editing one
   * (to tidy a name, say) invalidates its recorded `entry` and fails here.
   */
  const recorded = [
    {
      type: "esm" as const,
      name: "file:///Users/yashvardhansingh/test/opencode/.worktrees/codex/memory-workgraph-perf/.worktrees/integrate/claxedo-memory-buckets/packages/opencode/dist/node/node.js",
      entry: "3a35ee30",
    },
    {
      type: "commonjs" as const,
      name: "/Users/yashvardhansingh/test/opencode/.worktrees/codex/memory-workgraph-perf/.worktrees/integrate/claxedo-memory-buckets/node_modules/.bun/@lydell+node-pty@1.2.0-beta.14/node_modules/@lydell/node-pty/index.js",
      entry: "d96b7ade",
    },
    { type: "esm" as const, name: "file:///private/tmp/cclab/a/mod.mjs", entry: "5feb6894" },
    { type: "esm" as const, name: "file:///private/tmp/cclab/b/mod.mjs", entry: "66665451" },
  ]

  for (const { type, name, entry } of recorded) {
    test(`reproduces the ${type} entry the runtime wrote for ${path.basename(name)}`, () => {
      expect(compileCacheEntryName(name, type)).toBe(entry)
    })
  }

  test("the type byte, not just the path, is part of the key", () => {
    // CommonJS=0 and ESM=1 are hashed before the name; a file cached both ways
    // gets two entries. Dropping the byte would collide them.
    expect(compileCacheEntryName("/tmp/x.js", "commonjs")).not.toBe(compileCacheEntryName("/tmp/x.js", "esm"))
  })

  test("two locations of the same file get different entries — the reason a shipped cache must be re-keyed", () => {
    expect(compileCacheEntryName("file:///a/node.js", "esm")).not.toBe(
      compileCacheEntryName("file:///b/node.js", "esm"),
    )
  })

  test("ESM is keyed by the resolved file URL and CommonJS by the resolved path", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-cc-name-"))
    const file = path.join(dir, "node.js")
    fs.writeFileSync(file, "export const a = 1\n")
    const real = fs.realpathSync(file)
    expect(compileCacheSourceName(file, "esm")).toBe(pathToFileURL(real).href)
    expect(compileCacheSourceName(file, "commonjs")).toBe(real)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe("compile cache manifest", () => {
  test("accepts a generated manifest", () => {
    const manifest = parseCompileCacheManifest(
      JSON.stringify({ version: 1, entries: [{ file: "node.js", type: "esm", blob: "n.v8cache", bytes: 12 }] }),
    )
    expect(manifest.entries).toEqual([{ file: "node.js", type: "esm", blob: "n.v8cache", bytes: 12 }])
  })

  test("rejects a manifest from a future generator instead of guessing", () => {
    expect(() => parseCompileCacheManifest(JSON.stringify({ version: 2, entries: [] }))).toThrow(/version 2/)
  })

  test("rejects an entry with an unknown code type", () => {
    expect(() =>
      parseCompileCacheManifest(
        JSON.stringify({ version: 1, entries: [{ file: "a", type: "wasm", blob: "b", bytes: 1 }] }),
      ),
    ).toThrow(/unknown compile cache entry type/)
  })
})

describe("seeding", () => {
  /** One shipped set: `count` cached files under `<root>/<name>/`, with a manifest. */
  function shippedSet(root: string, name: string, files: string[]) {
    const shipped = path.join(root, `${name}-shipped`)
    const rootDir = path.join(root, name)
    fs.mkdirSync(shipped, { recursive: true })
    fs.mkdirSync(path.join(rootDir, "chunks"), { recursive: true })
    const entries = files.map((file) => {
      fs.writeFileSync(path.join(rootDir, file), "export const a = 1\n")
      const blob = `${file.replace(/[\\/]/g, "_")}.esm.v8cache`
      fs.writeFileSync(path.join(shipped, blob), `BLOB:${name}:${file}`)
      return { file, type: "esm" as const, blob, bytes: 4 }
    })
    fs.writeFileSync(path.join(shipped, OPENCODE_COMPILE_CACHE_MANIFEST_NAME), JSON.stringify({ version: 1, entries }))
    return { shippedDir: shipped, rootDir }
  }

  function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-cc-seed-"))
    const computed = path.join(root, "base", "v24-arm64-abcd1234-501")
    fs.mkdirSync(computed, { recursive: true })
    const engine = shippedSet(root, "engine", ["node.js"])
    const server = shippedSet(root, "server", ["index.js", "chunks/entry-abc.js"])
    return { root, computed, engine, server }
  }

  const runtimeName = (source: { rootDir: string }, file: string) =>
    compileCacheEntryName(pathToFileURL(fs.realpathSync(path.join(source.rootDir, file))).href, "esm")
  const cacheEntries = (computed: string) => fs.readdirSync(computed).filter((entry) => !entry.startsWith("."))

  test("files each blob under the name the runtime will look for on THIS machine", () => {
    const { root, computed, engine } = fixture()
    const result = seedShippedCompileCaches({ sources: [engine], computedCacheDir: computed })

    expect(result).toMatchObject({ status: "seeded", entries: 1 })
    const expected = runtimeName(engine, "node.js")
    // Not the shipped name, and not a name derived from the build machine.
    expect(cacheEntries(computed)).toEqual([expected])
    expect(fs.existsSync(path.join(computed, COMPILE_CACHE_SEED_COMPLETE_NAME))).toBe(true)
    expect(fs.readFileSync(path.join(computed, expected), "utf8")).toBe("BLOB:engine:node.js")
    fs.rmSync(root, { recursive: true, force: true })
  })

  test("seeds EVERY shipped set into the one runtime directory", () => {
    // The regression this pins: the engine's blobs landing first must not make
    // the directory look populated to the server bundle's set.
    const { root, computed, engine, server } = fixture()

    const result = seedShippedCompileCaches({ sources: [engine, server], computedCacheDir: computed })

    expect(result).toMatchObject({ status: "seeded", entries: 3 })
    expect(cacheEntries(computed).sort()).toEqual(
      [runtimeName(engine, "node.js"), runtimeName(server, "index.js"), runtimeName(server, "chunks/entry-abc.js")]
        .sort(),
    )
    // Each blob is the one from ITS OWN set, keyed by ITS OWN root.
    expect(fs.readFileSync(path.join(computed, runtimeName(server, "index.js")), "utf8")).toBe("BLOB:server:index.js")
    fs.rmSync(root, { recursive: true, force: true })
  })

  test("preserves runtime-written entries while completing every missing shipped set", () => {
    const { root, computed, engine, server } = fixture()
    fs.writeFileSync(path.join(computed, "deadbeef"), "EXISTING")

    const result = seedShippedCompileCaches({ sources: [engine, server], computedCacheDir: computed })

    expect(result).toMatchObject({ status: "seeded", entries: 3 })
    expect(fs.readFileSync(path.join(computed, "deadbeef"), "utf8")).toBe("EXISTING")
    expect(cacheEntries(computed).sort()).toEqual([
      "deadbeef",
      runtimeName(engine, "node.js"),
      runtimeName(server, "index.js"),
      runtimeName(server, "chunks/entry-abc.js"),
    ].sort())
    fs.rmSync(root, { recursive: true, force: true })
  })

  test("a restart repairs orphan pending and partial final entries without overwriting the final", () => {
    const { root, computed, engine, server } = fixture()
    const engineTarget = path.join(computed, runtimeName(engine, "node.js"))
    const serverTarget = path.join(computed, runtimeName(server, "index.js"))
    fs.writeFileSync(engineTarget, "RUNTIME-WRITTEN")
    fs.writeFileSync(`${serverTarget}.pending`, "INTERRUPTED")

    const result = seedShippedCompileCaches({ sources: [engine, server], computedCacheDir: computed })

    expect(result).toMatchObject({ status: "seeded", entries: 2 })
    expect(fs.readFileSync(engineTarget, "utf8")).toBe("RUNTIME-WRITTEN")
    expect(fs.readFileSync(serverTarget, "utf8")).toBe("BLOB:server:index.js")
    expect(fs.existsSync(`${serverTarget}.pending`)).toBe(false)
    expect(fs.existsSync(path.join(computed, COMPILE_CACHE_SEED_COMPLETE_NAME))).toBe(true)
    fs.rmSync(root, { recursive: true, force: true })
  })

  test("a completion marker makes later launches leave runtime cache files untouched", () => {
    const { root, computed, engine } = fixture()
    const first = seedShippedCompileCaches({ sources: [engine], computedCacheDir: computed })
    const target = path.join(computed, runtimeName(engine, "node.js"))
    fs.writeFileSync(target, "RUNTIME-REFRESHED")

    const second = seedShippedCompileCaches({ sources: [engine], computedCacheDir: computed })

    expect(first).toMatchObject({ status: "seeded", entries: 1 })
    expect(second).toMatchObject({ status: "already-seeded", entries: 0 })
    expect(fs.readFileSync(target, "utf8")).toBe("RUNTIME-REFRESHED")
    fs.rmSync(root, { recursive: true, force: true })
  })

  test("leaves no partial blob behind when the copy is interrupted", () => {
    // The completion marker appears only after every final entry exists.
    const { root, computed, engine } = fixture()
    fs.rmSync(path.join(engine.shippedDir, "node.js.esm.v8cache"))

    expect(() => seedShippedCompileCaches({ sources: [engine], computedCacheDir: computed })).toThrow()
    expect(fs.readdirSync(computed)).toEqual([])
    fs.rmSync(root, { recursive: true, force: true })
  })
})

describe("enable", () => {
  const runtime = (directory: string) => ({
    enableCompileCache: () => ({ status: 1 }),
    getCompileCacheDir: () => directory,
  })

  test("enables the cache under the server data dir even with nothing to seed from", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-cc-enable-"))
    const dataDir = path.join(root, "profile")
    const computed = path.join(root, "computed")
    fs.mkdirSync(computed, { recursive: true })
    let requested: string | undefined

    const result = enableShippedCompileCaches({
      dataDir,
      sources: [undefined],
      runtime: {
        enableCompileCache: (directory: string) => {
          requested = directory
          return { status: 1 }
        },
        getCompileCacheDir: () => computed,
      },
    })

    // The base is derived here, so the entry has no layout knowledge to get wrong.
    expect(requested).toBe(path.join(dataDir, OPENCODE_COMPILE_CACHE_BASE_DIR_NAME))
    // Nothing shipped is not a failure, and the cache is on regardless.
    expect(result).toMatchObject({ status: "not-seeded", enabled: true, entries: 0 })
    fs.rmSync(root, { recursive: true, force: true })
  })

  test("reports failure instead of throwing when the runtime refuses to enable a cache", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-cc-refuse-"))
    const shipped = path.join(root, "shipped")
    fs.mkdirSync(shipped, { recursive: true })
    fs.writeFileSync(
      path.join(shipped, OPENCODE_COMPILE_CACHE_MANIFEST_NAME),
      JSON.stringify({ version: 1, entries: [] }),
    )
    const result = enableShippedCompileCaches({
      dataDir: path.join(root, "profile"),
      sources: [{ shippedDir: shipped, rootDir: path.join(root, "engine") }],
      runtime: {
        enableCompileCache: () => ({ status: 0, message: "read-only file system" }),
        getCompileCacheDir: () => undefined,
      },
    })
    expect(result).toMatchObject({ status: "not-seeded", enabled: false, reason: "read-only file system" })
    fs.rmSync(root, { recursive: true, force: true })
  })

  test("swallows a broken shipped cache — seeding may never fail a boot", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-cc-broken-"))
    const shipped = path.join(root, "shipped")
    const computed = path.join(root, "computed")
    fs.mkdirSync(shipped, { recursive: true })
    fs.mkdirSync(computed, { recursive: true })
    fs.writeFileSync(path.join(shipped, OPENCODE_COMPILE_CACHE_MANIFEST_NAME), "{ not json")

    const result = enableShippedCompileCaches({
      dataDir: path.join(root, "profile"),
      sources: [{ shippedDir: shipped, rootDir: path.join(root, "engine") }],
      runtime: runtime(computed),
    })

    expect(result.status).toBe("failed")
    expect(result.entries).toBe(0)
    fs.rmSync(root, { recursive: true, force: true })
  })

  test("installs the sets that WERE shipped and skips the ones that were not", () => {
    // A build that generated the engine's cache but not the server bundle's
    // must still seed the engine's, rather than treating one absent directory
    // as "nothing was shipped".
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-cc-partial-"))
    const shipped = path.join(root, "shipped")
    const engineDir = path.join(root, "engine")
    const computed = path.join(root, "computed")
    for (const dir of [shipped, engineDir, computed]) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(engineDir, "node.js"), "export const a = 1\n")
    fs.writeFileSync(path.join(shipped, "node.js.esm.v8cache"), "BLOB")
    fs.writeFileSync(
      path.join(shipped, OPENCODE_COMPILE_CACHE_MANIFEST_NAME),
      JSON.stringify({ version: 1, entries: [{ file: "node.js", type: "esm", blob: "node.js.esm.v8cache", bytes: 4 }] }),
    )

    const result = enableShippedCompileCaches({
      dataDir: path.join(root, "profile"),
      sources: [
        { shippedDir: shipped, rootDir: engineDir },
        { shippedDir: path.join(root, "never-generated"), rootDir: root },
      ],
      runtime: runtime(computed),
    })

    expect(result).toMatchObject({ status: "seeded", enabled: true, entries: 1 })
    fs.rmSync(root, { recursive: true, force: true })
  })

  test("does nothing when the desktop handed over no data dir", () => {
    expect(
      enableShippedCompileCaches({ dataDir: undefined, sources: [{ shippedDir: "/nope", rootDir: "/nope" }] }),
    ).toMatchObject({ status: "not-seeded", enabled: false })
  })
})
