/**
 * The transitive source closure of an entry module.
 *
 * A deployment's real ownership is not what its composition file says it mounts
 * — it is what its entry graph can reach. Emitted-artifact checks catch what a
 * bundler injects; this catches the architecture edge that put it there, and it
 * does so without a build. Every product-boundary gate in this repository is
 * ultimately a question about this set.
 */

import fs from "node:fs"
import path from "node:path"

export type SourceModule = {
  /** Absolute path of the resolved module. */
  file: string
  /** Path relative to the package root that owns it. */
  relative: string
}

export type SourceClosure = {
  /** Every first-party module reachable from the entry, including the entry. */
  modules: SourceModule[]
  /** Bare specifiers the closure depends on, deduped to their package name. */
  packages: string[]
  /** Specifiers that could not be resolved to a file on disk. */
  unresolved: string[]
  /**
   * `import(someVariable)` sites. Each is an edge this walk cannot follow, so a
   * closure containing any of them is a lower bound rather than an answer.
   */
  opaque: string[]
}

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"]

/**
 * Import specifiers, in source order.
 *
 * Deliberately regex-based rather than AST-based: this runs as a test gate over
 * hundreds of modules, and the shapes that matter here — static `import`,
 * `export ... from`, and dynamic `import()` — are unambiguous in this
 * repository's source. A comment containing something that looks like an import
 * would over-report, which fails safe for a boundary check.
 */
export function importSpecifiers(source: string): string[] {
  const found: string[] = []
  const patterns = [
    /\bimport\s+[^"';]*?\bfrom\s*["']([^"']+)["']/g,
    /\bexport\s+[^"';]*?\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\s+["']([^"']+)["']/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1]
      if (specifier) found.push(specifier)
    }
  }
  return found
}

/**
 * Specifiers that survive compilation.
 *
 * `import type X from "m"` and `export type { X } from "m"` are erased whole:
 * the module is never loaded, no capability becomes reachable, and nothing of
 * it lands in the emitted artifact. Counting those edges would report hosted
 * surface in a build that cannot execute a line of it.
 *
 * An INLINE type specifier (`import { type A, B } from "m"`) is different — the
 * statement still imports `B`, so the module is loaded and the edge is real.
 * Only the `import type` / `export type` statement forms are dropped.
 */
export function runtimeImportSpecifiers(source: string): string[] {
  // Delete the erased statements, then read what is left. Filtering by
  // specifier instead would drop a module that one statement imports as a type
  // and another imports as a value — that module IS loaded at runtime.
  const withoutTypeOnly = source
    .replace(/\bimport\s+type\s+[^"';]*?\bfrom\s*["'][^"']+["']/g, "")
    .replace(/\bexport\s+type\s+[^"';]*?\bfrom\s*["'][^"']+["']/g, "")
  return importSpecifiers(withoutTypeOnly)
}

/**
 * Dynamic imports whose specifier is not a literal.
 *
 * `const m = "../../deployments/local/x"; await import(m)` is an edge no
 * import-graph walker can follow and no typechecker can verify — and in this
 * repository one such edge, written with `@vite-ignore`, survived a package
 * move silently and broke at runtime. A closure that cannot see an edge must
 * say so rather than report a clean graph.
 */
export function opaqueDynamicImports(source: string): string[] {
  const found: string[] = []
  for (const match of source.matchAll(/\bimport\s*\(\s*(?:\/\*[^*]*\*\/\s*)?([A-Za-z_$][\w$.]*)\s*\)/g)) {
    if (match[1]) found.push(match[1])
  }
  return found
}

function resolveFile(candidate: string): string | null {
  if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
  for (const extension of SOURCE_EXTENSIONS) {
    const withExtension = `${candidate}${extension}`
    if (fs.existsSync(withExtension)) return withExtension
  }
  for (const extension of SOURCE_EXTENSIONS) {
    const asIndex = path.join(candidate, `index${extension}`)
    if (fs.existsSync(asIndex)) return asIndex
  }
  return null
}

/**
 * Resolve a relative specifier the way the TypeScript sources mean it: an
 * extensionless path, an explicit `.js` that stands for a `.ts` source, or a
 * directory with an index.
 */
export function resolveRelative(fromFile: string, specifier: string): string | null {
  const base = path.resolve(path.dirname(fromFile), specifier)
  const direct = resolveFile(base)
  if (direct) return direct
  const rewritten = base.replace(/\.(m|c)?js$/, "")
  return rewritten === base ? null : resolveFile(rewritten)
}

/** The package name a bare specifier belongs to (`@scope/name` or `name`). */
export function packageNameOf(specifier: string): string {
  const parts = specifier.split("/")
  if (specifier.startsWith("@")) return parts.slice(0, 2).join("/")
  return parts[0] ?? specifier
}

function isBare(specifier: string) {
  return !specifier.startsWith(".") && !specifier.startsWith("/")
}

/** Stable module identity for reports and architecture contracts on every OS. */
function relativeModulePath(root: string, file: string) {
  return path.relative(root, file).split(path.sep).join("/")
}

/**
 * Walk every first-party module reachable from `entry`.
 *
 * `root` is the package root the returned relative paths are expressed against.
 * Bare specifiers are recorded as package dependencies rather than followed:
 * the question this answers is "what does THIS package's source reach", and a
 * dependency's own internals are governed by its own manifest.
 */
export function sourceClosure(input: {
  entry: string
  root: string
  /**
   * Follow only edges that survive compilation. Default `false` keeps every
   * declared edge, which is what an architecture gate wants; `true` answers
   * "what can this build actually execute", which is what a capability gate
   * wants.
   */
  runtimeOnly?: boolean
}): SourceClosure {
  const read = input.runtimeOnly ? runtimeImportSpecifiers : importSpecifiers
  const entry = path.resolve(input.entry)
  const root = path.resolve(input.root)
  const seen = new Set<string>()
  const packages = new Set<string>()
  const unresolved = new Set<string>()
  const opaque = new Set<string>()
  const queue = [entry]

  while (queue.length > 0) {
    const file = queue.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    let source: string
    try {
      source = fs.readFileSync(file, "utf8")
    } catch {
      continue
    }
    for (const name of opaqueDynamicImports(source)) {
      opaque.add(`${relativeModulePath(root, file)} -> import(${name})`)
    }
    for (const specifier of read(source)) {
      if (isBare(specifier)) {
        packages.add(packageNameOf(specifier))
        continue
      }
      const resolved = resolveRelative(file, specifier)
      if (!resolved) {
        unresolved.add(`${relativeModulePath(root, file)} -> ${specifier}`)
        continue
      }
      queue.push(resolved)
    }
  }

  return {
    modules: [...seen]
      .map((file) => ({ file, relative: relativeModulePath(root, file) }))
      .sort((a, b) => a.relative.localeCompare(b.relative)),
    packages: [...packages].sort(),
    unresolved: [...unresolved].sort(),
    opaque: [...opaque].sort(),
  }
}

/**
 * The shortest import chain from `entry` to the first module matching
 * `isForbidden`, or `null` when the closure is clean.
 *
 * Breadth-first on purpose. A depth-first walk reports whichever chain it
 * happened to descend, which can be many hops long and sends a reader to the
 * wrong place; the shortest chain names the tightest actual coupling, which is
 * the edge worth cutting.
 */
export function shortestForbiddenChain(input: {
  entry: string
  root: string
  isForbidden: (module: SourceModule) => boolean
  /** See {@link sourceClosure}. */
  runtimeOnly?: boolean
}): SourceModule[] | null {
  const read = input.runtimeOnly ? runtimeImportSpecifiers : importSpecifiers
  const entry = path.resolve(input.entry)
  const root = path.resolve(input.root)
  const seen = new Set<string>([entry])
  let frontier: Array<{ file: string; chain: string[] }> = [{ file: entry, chain: [entry] }]

  while (frontier.length > 0) {
    const next: Array<{ file: string; chain: string[] }> = []
    for (const { file, chain } of frontier) {
      let source: string
      try {
        source = fs.readFileSync(file, "utf8")
      } catch {
        continue
      }
      for (const specifier of read(source)) {
        if (isBare(specifier)) continue
        const resolved = resolveRelative(file, specifier)
        if (!resolved || seen.has(resolved)) continue
        seen.add(resolved)
        const module = { file: resolved, relative: relativeModulePath(root, resolved) }
        const nextChain = [...chain, resolved]
        if (input.isForbidden(module)) {
          return nextChain.map((item) => ({ file: item, relative: relativeModulePath(root, item) }))
        }
        next.push({ file: resolved, chain: nextChain })
      }
    }
    frontier = next
  }
  return null
}
