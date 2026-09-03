/**
 * ONE definition of "closure", shared by every product policy.
 *
 * Five closure checks already existed when this was written, and each had
 * invented its own walk:
 *
 *   - `claxedo-server-core/src/platform/governance/source-closure.ts` — the
 *     canonical one, relative specifiers only.
 *   - `claxedo-app/src/architecture/import-graph.ts` — a second walk, because
 *     the app writes `@/...` and the canonical walker cannot resolve an alias.
 *   - `claxedo-host-connector/src/connector-closure.test.ts` — a third, a flat
 *     directory scan with its own regex.
 *   - `claxedo-desktop/scripts/host-connector-boundary.test.ts` — a fourth,
 *     with its own comment-stripping regex.
 *   - `claxedo-desktop/src/renderer/renderer-entry-closure.guard.test.ts` — a
 *     fifth, which had to patch the app's resolver because the naive
 *     `@claxedo/app/<x>` -> `src/<x>` mapping cannot see a followed package's
 *     internals at all. The desktop renderer reaches the app's browser
 *     identity SDK (`platform/auth/better-auth-browser-auth.ts`, the one
 *     module that imports `better-auth/client`) by walking straight into
 *     `@claxedo/app`'s source tree, not through any `exports` subpath, so the
 *     unpatched walk reported a clean desktop closure and was wrong.
 *
 * Four different answers to "what does this entry reach" is four places for the
 * boundary to be defined differently, and the fifth item above is what that
 * costs. This module is the single walk the policies share.
 *
 * It does NOT re-derive the hard part. Reading specifiers out of source — which
 * statement forms count, which are erased by compilation, which dynamic imports
 * are unfollowable — is owned by the canonical governance module and imported
 * from it. What is added here is RESOLUTION: aliases and workspace `exports`
 * maps, the two things that made the other walks exist.
 *
 * Imported by relative path because a bare `@claxedo/server-core` specifier
 * here would resolve against whichever package happens to link it and fail
 * from `script/`.
 */

import fs from "node:fs"
import path from "node:path"
import {
  importSpecifiers,
  opaqueDynamicImports,
  packageNameOf,
  runtimeImportSpecifiers,
} from "../../packages/claxedo-server-core/src/platform/governance/source-closure.ts"

export const REPO_ROOT = path.resolve(import.meta.dirname, "../..")

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]

/** A `@/x` style prefix and the directory it stands for. */
export type Alias = {
  /** Matched as an exact specifier or as `${prefix}/...`. */
  prefix: string
  /** Repo-relative directory the prefix maps onto. */
  target: string
}

/**
 * A workspace package whose edges are FOLLOWED rather than recorded.
 *
 * By default a bare specifier ends the walk — a dependency's internals are its
 * own manifest's problem. But a product's boundary can run straight through a
 * sibling: the desktop renderer composes `@claxedo/app`, so "what does the
 * unsigned desktop reach" is unanswerable without crossing into that package.
 * Naming it here is what makes the crossing deliberate rather than accidental.
 */
export type FollowedPackage = {
  name: string
  /** Repo-relative package directory. */
  dir: string
  /** Aliases that apply to files INSIDE that package. */
  aliases?: Alias[]
}

export type ClosureModule = {
  file: string
  /** Repo-relative, forward-slashed. Comparable across packages. */
  id: string
}

export type ClosureEdge = {
  from: string
  to: string
  specifier: string
}

export type Closure = {
  entry: string
  modules: ClosureModule[]
  /** Bare specifiers the walk stopped at, deduped to package name. */
  packages: string[]
  /** `module -> specifier` for every unresolvable relative/alias specifier. */
  unresolved: string[]
  /**
   * `module -> resolved` for edges that resolved to a real file OUTSIDE every
   * declared root.
   *
   * Kept apart from `packages` because it is a different fact and a different
   * fix. A first-party file reached across a root boundary is source this
   * product executes and this policy is not measuring; calling it a
   * "dependency" would let `import x from "../../other-package/thing"` read as
   * an ordinary package edge named `..`.
   */
  outsideRoots: string[]
  /** `module -> import(variable)` sites: edges no walk can follow. */
  opaque: string[]
  /** Every followed edge, for shortest-chain reporting. */
  edges: ClosureEdge[]
  /** `module -> package` for every bare edge, so a package hit names its owner. */
  packageEdges: Array<{ from: string; package: string; specifier: string }>
}

export type WalkOptions = {
  /** Absolute path of the entry module. */
  entry: string
  /** Repo-relative directories whose files may be followed. */
  roots: string[]
  aliases?: Alias[]
  followed?: FollowedPackage[]
  /**
   * Follow only edges that survive compilation. `true` answers "what can this
   * build execute", which is the question every product boundary is asking.
   */
  runtimeOnly?: boolean
}

function idOf(file: string) {
  return path.relative(REPO_ROOT, file).split(path.sep).join("/")
}

function resolveFile(candidate: string): string | null {
  if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
  for (const extension of SOURCE_EXTENSIONS) {
    const withExtension = `${candidate}${extension}`
    if (fs.existsSync(withExtension) && fs.statSync(withExtension).isFile()) return withExtension
  }
  for (const extension of SOURCE_EXTENSIONS) {
    const asIndex = path.join(candidate, `index${extension}`)
    if (fs.existsSync(asIndex)) return asIndex
  }
  return null
}

/** `./x`, `../x`, `./x.js` standing for `./x.ts`, `./x` standing for `./x/index.ts`. */
function resolveRelative(fromFile: string, specifier: string): string | null {
  const base = path.resolve(path.dirname(fromFile), specifier)
  const direct = resolveFile(base)
  if (direct) return direct
  const rewritten = base.replace(/\.(m|c)?js$/, "")
  return rewritten === base ? null : resolveFile(rewritten)
}

function resolveAlias(specifier: string, aliases: readonly Alias[]): string | null {
  for (const alias of aliases) {
    if (specifier !== alias.prefix && !specifier.startsWith(`${alias.prefix}/`)) continue
    const rest = specifier === alias.prefix ? "" : specifier.slice(alias.prefix.length + 1)
    const resolved = resolveFile(path.join(REPO_ROOT, alias.target, rest))
    if (resolved) return resolved
  }
  return null
}

type ExportTarget = string | null | { [condition: string]: ExportTarget }

function exportTargets(node: ExportTarget): string[] {
  if (node === null) return []
  if (typeof node === "string") return [node]
  return Object.values(node).flatMap(exportTargets)
}

/**
 * A workspace package's `exports` map, as `subpath -> file target`.
 *
 * Conditions are flattened to their first file target: every condition in this
 * repository's workspace manifests points at the same TypeScript source, and a
 * boundary walk cares which FILE is reachable, not which runtime picked it.
 */
function exportsOf(dir: string): Map<string, string> {
  const manifestPath = path.join(REPO_ROOT, dir, "package.json")
  if (!fs.existsSync(manifestPath)) return new Map()
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { exports?: Record<string, ExportTarget> }
  const map = new Map<string, string>()
  for (const [subpath, node] of Object.entries(manifest.exports ?? {})) {
    const target = exportTargets(node)[0]
    if (target) map.set(subpath, target)
  }
  return map
}

/**
 * Resolve a followed package's subpath specifiers through that package's
 * `exports` map.
 *
 * The naive mapping — package name off the front, the rest onto `src/` — is
 * what the desktop renderer guard had to patch around: a followed package's
 * `exports` map can point a subpath at a file the naive guess would never
 * find, so the naive answer is "unresolvable", and an unresolvable edge
 * silently drops whatever lives behind that subpath out of the graph.
 */
function resolveFollowedPackage(specifier: string, followed: readonly FollowedPackage[]): string | null {
  for (const pkg of followed) {
    if (specifier !== pkg.name && !specifier.startsWith(`${pkg.name}/`)) continue
    const subpath = specifier === pkg.name ? "." : `./${specifier.slice(pkg.name.length + 1)}`
    const map = exportsOf(pkg.dir)
    const exact = map.get(subpath)
    if (exact) {
      const resolved = resolveFile(path.join(REPO_ROOT, pkg.dir, exact))
      if (resolved) return resolved
    }
    for (const [pattern, target] of map) {
      if (!pattern.includes("*")) continue
      const [prefix = "", suffix = ""] = pattern.split("*")
      if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue
      const star = subpath.slice(prefix.length, subpath.length - suffix.length)
      const resolved = resolveFile(path.join(REPO_ROOT, pkg.dir, target.replace("*", star)))
      if (resolved) return resolved
    }
    // Named as followed, and the specifier did not resolve. Reported as
    // unresolved by the caller rather than silently downgraded to a package
    // edge, because a followed package that answers nothing is the failure
    // shape this resolver exists to prevent.
    return null
  }
  return null
}

function isBare(specifier: string) {
  return !specifier.startsWith(".") && !specifier.startsWith("/")
}

function underRoots(file: string, roots: readonly string[]) {
  const id = idOf(file)
  return roots.some((root) => id === root || id.startsWith(`${root}/`))
}

/**
 * Walk every followable module reachable from one entry.
 *
 * Breadth-first, so `shortestChain` below reports the tightest coupling rather
 * than whichever path the traversal happened to descend — a depth-first answer
 * on a graph this size routinely sends a reader twelve hops into unrelated
 * code.
 */
export function walk(options: WalkOptions): Closure {
  const read = options.runtimeOnly ? runtimeImportSpecifiers : importSpecifiers
  const aliases = options.aliases ?? []
  const followed = options.followed ?? []
  const roots = options.roots
  const entry = path.resolve(options.entry)

  const seen = new Set<string>()
  const modules: ClosureModule[] = []
  const packages = new Set<string>()
  const unresolved = new Set<string>()
  const outsideRoots = new Set<string>()
  const opaque = new Set<string>()
  const edges: ClosureEdge[] = []
  const packageEdges: Array<{ from: string; package: string; specifier: string }> = []

  let frontier = [entry]
  seen.add(entry)

  while (frontier.length > 0) {
    const next: string[] = []
    for (const file of frontier) {
      modules.push({ file, id: idOf(file) })
      let source: string
      try {
        source = fs.readFileSync(file, "utf8")
      } catch {
        unresolved.add(`${idOf(file)} -> <unreadable>`)
        continue
      }
      for (const name of opaqueDynamicImports(source)) opaque.add(`${idOf(file)} -> import(${name})`)

      for (const specifier of new Set(read(source))) {
        const applicable = aliasesFor(file, aliases, followed)
        const resolved = isBare(specifier)
          ? (resolveAlias(specifier, applicable) ?? resolveFollowedPackage(specifier, followed))
          : resolveRelative(file, specifier)

        if (resolved === null) {
          // An alias-shaped or followed-package specifier that did not resolve
          // is a HOLE, not a dependency. This is the exact failure the desktop
          // renderer guard had to patch around: a followed-package subpath
          // answering null quietly drops whatever lives behind it out of the
          // graph and the walk reports a clean product. Recording it as
          // `packages` would do the same thing one level up — the boundary
          // rules match package names, and `@/platform` is not one.
          if (isAliasShaped(specifier, applicable) || namesFollowedPackage(specifier, followed)) {
            unresolved.add(`${idOf(file)} -> ${specifier}`)
            continue
          }
          if (isBare(specifier)) {
            packages.add(packageNameOf(specifier))
            packageEdges.push({ from: idOf(file), package: packageNameOf(specifier), specifier })
            continue
          }
          unresolved.add(`${idOf(file)} -> ${specifier}`)
          continue
        }
        edges.push({ from: idOf(file), to: idOf(resolved), specifier })
        if (!underRoots(resolved, roots)) {
          outsideRoots.add(`${idOf(file)} -> ${idOf(resolved)}`)
          continue
        }
        if (seen.has(resolved)) continue
        seen.add(resolved)
        next.push(resolved)
      }
    }
    frontier = next
  }

  return {
    entry: idOf(entry),
    modules: modules.sort((a, b) => a.id.localeCompare(b.id)),
    packages: [...packages].sort(),
    unresolved: [...unresolved].sort(),
    outsideRoots: [...outsideRoots].sort(),
    opaque: [...opaque].sort(),
    edges,
    packageEdges,
  }

  function aliasesFor(file: string, base: readonly Alias[], pkgs: readonly FollowedPackage[]): Alias[] {
    const owner = pkgs.find((pkg) => underRoots(file, [pkg.dir]))
    return owner?.aliases ? [...owner.aliases, ...base] : [...base]
  }

  function isAliasShaped(specifier: string, applicable: readonly Alias[]) {
    return applicable.some((alias) => specifier === alias.prefix || specifier.startsWith(`${alias.prefix}/`))
  }

  function namesFollowedPackage(specifier: string, pkgs: readonly FollowedPackage[]) {
    return pkgs.some((pkg) => specifier === pkg.name || specifier.startsWith(`${pkg.name}/`))
  }
}

/**
 * The shortest module chain from the entry to the first module or package edge
 * that `isForbidden` accepts, or null when the closure is clean.
 */
export function shortestChain(
  closure: Closure,
  isForbidden: (candidate: { id: string; package?: string; specifier?: string }) => boolean,
): string[] | null {
  const outgoing = new Map<string, ClosureEdge[]>()
  for (const edge of closure.edges) {
    const list = outgoing.get(edge.from) ?? []
    list.push(edge)
    outgoing.set(edge.from, list)
  }
  const packagesFrom = new Map<string, Array<{ package: string; specifier: string }>>()
  for (const edge of closure.packageEdges) {
    const list = packagesFrom.get(edge.from) ?? []
    list.push({ package: edge.package, specifier: edge.specifier })
    packagesFrom.set(edge.from, list)
  }

  if (isForbidden({ id: closure.entry })) return [closure.entry]

  const seen = new Set([closure.entry])
  let frontier: Array<{ id: string; chain: string[] }> = [{ id: closure.entry, chain: [closure.entry] }]

  while (frontier.length > 0) {
    const next: Array<{ id: string; chain: string[] }> = []
    for (const { id, chain } of frontier) {
      for (const bare of packagesFrom.get(id) ?? []) {
        if (isForbidden({ id, package: bare.package, specifier: bare.specifier })) {
          return [...chain, `[package] ${bare.specifier}`]
        }
      }
      for (const edge of outgoing.get(id) ?? []) {
        if (seen.has(edge.to)) continue
        seen.add(edge.to)
        const nextChain = [...chain, edge.to]
        if (isForbidden({ id: edge.to, specifier: edge.specifier })) return nextChain
        next.push({ id: edge.to, chain: nextChain })
      }
    }
    frontier = next
  }
  return null
}
