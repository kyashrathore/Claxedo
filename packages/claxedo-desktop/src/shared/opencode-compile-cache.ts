import { enableCompileCache, getCompileCacheDir } from "node:module"
import { crc32 } from "node:zlib"
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

/**
 * Seeding the V8 compile cache the packaged server child will actually read.
 *
 * `module.enableCompileCache(base)` makes Node persist V8 code cache for every
 * module it compiles, which is worth ~155 ms on the 23 MB embedded engine and a
 * measured 41 ms on the server bundle's own 9.11 MB static closure — but only
 * from the SECOND launch, because the first one is what writes it. Shipping a
 * prebuilt cache moves that win to launch one, and there are four ways to ship
 * a cache the runtime silently ignores. All four are load-bearing here:
 *
 *  1. THE UID. `enableCompileCache(base)` does not write into `base`.
 *     `getCompileCacheDir()` resolves to `<base>/v<node>-<arch>-<flaghash>-<uid>`
 *     and node's `GetCacheVersionTag()` appends `getuid()`. A shipped tree that
 *     baked in the build user's uid would hit on the build machine and miss for
 *     every customer. So we never ship a directory NAME: we ship entries and
 *     copy them into the directory the RUNNING user's runtime computes.
 *
 *  2. THE PATH. The entry FILENAME is a hash of the module's own location —
 *     node `src/compile_cache.cc`:
 *         GetCacheKey(filename, type) = crc32(uint8 type) then crc32(filename)
 *         cache_filename = <dir>/Uint32ToHex(key)
 *     where `filename` is the resolved `file://` URL for ESM and the absolute
 *     path for CommonJS. The build path is never the install path, so copying
 *     entries VERBATIM produces a guaranteed miss for every customer while
 *     hitting on the build machine. Measured on the real artifact: verbatim
 *     441/438/445/445 ms cold vs 453/438/470/443 ms seeded — zero gain — versus
 *     296/295/303/305 ms once the entry is renamed to the runtime key. So the
 *     entry name is RECOMPUTED here, at runtime, from the engine's real path.
 *
 *  3. THE V8 FLAGS. `CachedDataVersionTag()` is `hash_combine(Version::Hash(),
 *     FlagList::Hash())` and that hash is the `<flaghash>` directory segment.
 *     The server child runs `claxedoServerExecArgv()`, which moves the tag from
 *     `f02d4d51` to `ff1546d9`. The generator therefore forks with that exact
 *     argv — see scripts/build-opencode-compile-cache.ts, which imports the
 *     policy function rather than re-spelling the flags.
 *
 *  4. WHAT IS ACTUALLY IN THE BLOB. Nothing machine-specific, which is why (2)
 *     is a legitimate fix rather than a trick that only works on one host. V8's
 *     `SerializedCodeData` header carries magic, version hash, source hash, flag
 *     hash, read-only-snapshot checksum, payload length and checksum — and NOT
 *     the script name. A blob produced at one path is accepted at another once
 *     it is filed under the right key. Every surviving input is a property of
 *     the shipped Electron binary, the shipped engine bytes and the flags.
 *
 *  5. WHEN IT IS SWITCHED ON. Node compiles and links an ENTIRE static ESM
 *     graph during instantiation, before any module body runs. A cache enabled
 *     from inside a module body therefore cannot cache the graph that body
 *     belongs to — not on launch one, not on launch fifty. That is why the
 *     server bundle is entered through `scripts/claxedo-server-boot.ts`, which
 *     seeds and only then `await import()`s the product entry: the 9.11 MB
 *     closure is compiled on the far side of a dynamic boundary, after this
 *     module has run. The engine was already lazy for the same reason.
 *
 * The coupling to (2) is a node implementation detail with no stability
 * guarantee, so it is not left to trust: the generator asserts that
 * {@link compileCacheEntryName} reproduces the filename the runtime ACTUALLY
 * wrote, for every entry, and fails the BUILD if it does not. The same Electron
 * binary ships that generated the cache, so a passing build is a runtime
 * guarantee. And every failure path below degrades to a plain cache miss with a
 * booting app — seeding must never be able to fail a boot.
 */

/** Directory name under `resources/` (and `process.resourcesPath`) that holds the engine's shipped cache. */
export const OPENCODE_COMPILE_CACHE_DIR_NAME = "opencode-compile-cache"

/** The same, for the server bundle's own static closure. Two artifacts, two shipped sets, one runtime directory. */
export const CLAXEDO_SERVER_COMPILE_CACHE_DIR_NAME = "claxedo-server-compile-cache"

/** Manifest filename inside those directories. */
export const OPENCODE_COMPILE_CACHE_MANIFEST_NAME = "manifest.json"

/** Subdirectory of the server data dir used as the writable compile cache base. */
export const OPENCODE_COMPILE_CACHE_BASE_DIR_NAME = "opencode-compile-cache"

/**
 * `CachedCodeType` from node `src/compile_cache.h`, whose numeric value is
 * hashed into the cache key as a single byte.
 */
export const COMPILE_CACHE_CODE_TYPES = {
  commonjs: 0,
  esm: 1,
} as const

export type CompileCacheCodeType = keyof typeof COMPILE_CACHE_CODE_TYPES

/** One shipped cache entry: a blob plus the root-relative file it belongs to. */
export type CompileCacheManifestEntry = {
  /** Path of the cached source file relative to its manifest's root directory. */
  file: string
  type: CompileCacheCodeType
  /** Blob filename inside the shipped directory. Never the runtime key. */
  blob: string
  bytes: number
}

export type CompileCacheManifest = {
  version: 1
  entries: CompileCacheManifestEntry[]
}

/**
 * One shipped set of blobs and the directory its manifest's `file` paths are
 * resolved against ON THIS MACHINE.
 *
 * There are two: the embedded engine artifact's directory, and the server
 * bundle's own directory. They are separate manifests because they are separate
 * artifacts built at separate times, but they are seeded into ONE runtime
 * directory, because the runtime has exactly one — see
 * {@link seedShippedCompileCaches}.
 */
export type ShippedCompileCache = {
  /** Directory holding the manifest and the blobs, as shipped. */
  shippedDir: string
  /** Absolute directory the manifest's `file` paths are relative to at runtime. */
  rootDir: string
}

/**
 * The string node hashes into the cache key for a file it is about to compile.
 *
 * ESM is keyed by the resolved `file://` URL, CommonJS by the absolute path.
 * Both are post-symlink-resolution, because node's ESM resolver realpaths by
 * default and that resolved name is what reaches `GetOrInsert`.
 */
export function compileCacheSourceName(absolutePath: string, type: CompileCacheCodeType): string {
  const real = realpathSync(absolutePath)
  return type === "esm" ? pathToFileURL(real).href : real
}

/**
 * The entry filename node computes for a source name, reproducing
 * `GetCacheKey` + `Uint32ToHex` from `src/compile_cache.cc`.
 *
 * Verified against the runtime on every build; see the generator.
 */
export function compileCacheEntryName(sourceName: string, type: CompileCacheCodeType): string {
  const typeByte = Buffer.from([COMPILE_CACHE_CODE_TYPES[type]])
  const key = crc32(Buffer.concat([typeByte, Buffer.from(sourceName, "utf8")])) >>> 0
  return key.toString(16).padStart(8, "0")
}

export function parseCompileCacheManifest(raw: string): CompileCacheManifest {
  const parsed: unknown = JSON.parse(raw)
  if (!parsed || typeof parsed !== "object") throw new Error("compile cache manifest is not an object")
  const { version, entries } = parsed as { version?: unknown; entries?: unknown }
  if (version !== 1) throw new Error(`unsupported compile cache manifest version ${String(version)}`)
  if (!Array.isArray(entries)) throw new Error("compile cache manifest has no entries")
  return {
    version: 1,
    entries: entries.map((entry) => {
      const { file, type, blob, bytes } = entry as Record<string, unknown>
      if (typeof file !== "string" || !file) throw new Error("compile cache entry is missing its file")
      if (type !== "esm" && type !== "commonjs") throw new Error(`unknown compile cache entry type ${String(type)}`)
      if (typeof blob !== "string" || !blob) throw new Error("compile cache entry is missing its blob")
      if (typeof bytes !== "number") throw new Error("compile cache entry is missing its size")
      return { file, type, blob, bytes }
    }),
  }
}

export type OpenCodeCompileCacheOutcome = {
  /**
   * `seeded` — the shipped entries were installed for this launch.
   * `already-seeded` — the computed directory was already populated.
   * `not-seeded` — nothing was installed, and why. Says nothing about whether
   *   the runtime cache itself is on; read `enabled` for that.
   * `failed` — something threw. The caller boots anyway.
   */
  status: "seeded" | "already-seeded" | "not-seeded" | "failed"
  /** Whether this process is now persisting a compile cache of its own. */
  enabled: boolean
  entries: number
  reason?: string
  directory?: string
}

/**
 * Copy every shipped blob into `computedCacheDir`, each under the entry name the
 * runtime will look for GIVEN ITS ARTIFACT'S REAL PATH ON THIS MACHINE.
 *
 * `computedCacheDir` must come from `module.getCompileCacheDir()` — never
 * constructed here — so the uid segment is the running user's by construction.
 *
 * THE GUARD BELOW IS PER-LAUNCH, NOT PER-MANIFEST, and that distinction is
 * load-bearing now that there is more than one manifest. The runtime has ONE
 * cache directory; both shipped sets land in it. Were the "already populated"
 * check applied once per source, the first source's own blobs would make the
 * directory look populated and every later source would be silently skipped —
 * a partial seed that still reports success. So it is evaluated exactly once,
 * here, before any source is touched.
 */
export function seedShippedCompileCaches(input: {
  sources: readonly ShippedCompileCache[]
  computedCacheDir: string
}): Omit<OpenCodeCompileCacheOutcome, "enabled"> {
  const { sources, computedCacheDir } = input

  // Idempotence, decided ONCE for the whole launch: a populated cache directory
  // is left completely alone, so the second launch does no copying and never
  // overwrites what the runtime itself has since written.
  const existing = readdirSync(computedCacheDir).filter((entry) => !entry.startsWith("."))
  if (existing.length > 0) return { status: "already-seeded", entries: 0, directory: computedCacheDir }

  let seeded = 0
  for (const { shippedDir, rootDir } of sources) {
    const manifest = parseCompileCacheManifest(
      readFileSync(join(shippedDir, OPENCODE_COMPILE_CACHE_MANIFEST_NAME), "utf8"),
    )
    for (const entry of manifest.entries) {
      const source = join(rootDir, entry.file)
      const name = compileCacheEntryName(compileCacheSourceName(source, entry.type), entry.type)
      // Copy through a temporary name so an interrupted launch cannot leave a
      // half-written blob behind a directory that now looks populated.
      const target = join(computedCacheDir, name)
      const pending = `${target}.pending`
      copyFileSync(join(shippedDir, entry.blob), pending)
      renameSync(pending, target)
      seeded += 1
    }
  }
  if (seeded === 0) return { status: "not-seeded", entries: 0, reason: "manifest is empty", directory: computedCacheDir }
  return { status: "seeded", entries: seeded, directory: computedCacheDir }
}

/**
 * Enable the compile cache for this process and seed it, swallowing everything.
 *
 * Returns an outcome rather than logging, so the boot path decides what to say
 * and the tests can assert on a real result instead of on a directory listing.
 */
export function enableShippedCompileCaches(input: {
  /** The server's profile directory; the writable cache base is derived from it. */
  dataDir: string | undefined
  /**
   * The shipped sets to install. `undefined` members are what a caller that
   * was handed no path for one artifact passes, so the caller never has to
   * assemble a filtered array and accidentally drop a set it did have.
   */
  sources: readonly (ShippedCompileCache | undefined)[]
  runtime?: {
    enableCompileCache(directory: string): { status: number; message?: string; directory?: string }
    getCompileCacheDir(): string | undefined
  }
}): OpenCodeCompileCacheOutcome {
  const { dataDir } = input
  let enabled = false
  try {
    if (!dataDir) return { status: "not-seeded", enabled, entries: 0, reason: "no server data dir" }
    const runtime = input.runtime ?? { enableCompileCache, getCompileCacheDir }

    // The cache is enabled even when nothing was shipped to seed it with. That
    // is not the win this slice is about — a cache written by launch one only
    // pays off from launch two — but it is free, and it is what lets a build
    // without a generated cache degrade to "slow first launch" instead of "no
    // caching at all".
    const baseDir = join(dataDir, OPENCODE_COMPILE_CACHE_BASE_DIR_NAME)
    mkdirSync(baseDir, { recursive: true })
    const result = runtime.enableCompileCache(baseDir)
    // 0 is FAILED; 1 ENABLED and 2 ALREADY_ENABLED are both usable.
    if (result.status === 0) {
      return { status: "not-seeded", enabled, entries: 0, reason: result.message ?? "compile cache was not enabled" }
    }
    enabled = true

    // Never construct this path: only the runtime knows the node version, arch,
    // V8 flag hash and uid that name it.
    const computed = runtime.getCompileCacheDir()
    if (!computed) {
      return { status: "not-seeded", enabled, entries: 0, reason: "runtime reported no compile cache directory" }
    }
    mkdirSync(computed, { recursive: true })

    // A build that shipped no cache is not a failure: the artifacts compile as
    // they always did, and this launch writes a cache for the next one. A
    // shipped directory that exists but cannot be read IS a failure, and is
    // reported as one rather than being disguised as an absent cache — which is
    // why `existsSync` is the only filter and a present-but-broken set is left
    // to throw into the catch below.
    const sources = input.sources.filter(
      (source): source is ShippedCompileCache => source !== undefined && existsSync(source.shippedDir),
    )
    if (sources.length === 0) {
      return {
        status: "not-seeded",
        enabled,
        entries: 0,
        reason: "no compile cache was shipped",
        directory: computed,
      }
    }

    return { ...seedShippedCompileCaches({ sources, computedCacheDir: computed }), enabled }
  } catch (error) {
    // A seeding failure is a slower launch, never a failed one.
    return { status: "failed", enabled, entries: 0, reason: error instanceof Error ? error.message : String(error) }
  }
}
