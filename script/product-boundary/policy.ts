/**
 * A product boundary, as DATA.
 *
 * The plan's requirement for this directory is that "package scripts are thin
 * invocations selecting a policy; they do not copy traversal". So everything a
 * product-specific check used to spell out in code — which packages are
 * forbidden, which source roots belong to the other product, how big the
 * closure may get — is a value here, and {@link evaluate} is the only thing
 * that walks.
 *
 * Every policy MUST declare `control`. That is not a convenience field: each
 * boundary assertion below is "the offenders list is empty", which is exactly
 * what a walk that resolved nothing also reports. A policy whose probes do not
 * appear in its own closure fails as a BROKEN MEASUREMENT before any boundary
 * result is reported, because a clean answer from a walk that read no files is
 * worse than no answer at all — it reads as coverage.
 */

import { shortestChain, walk, type Alias, type Closure, type FollowedPackage } from "./closure.ts"
import path from "node:path"
import { REPO_ROOT } from "./closure.ts"

export type Policy = {
  /** Selector used on the command line. */
  id: string
  /** One line a reader sees in the report. */
  summary: string
  /** Repo-relative package directory that owns this entry. */
  packageDir: string
  /** Repo-relative production entry file. */
  entry: string
  /** Repo-relative directories whose modules are followed. */
  roots: string[]
  aliases?: Alias[]
  followed?: FollowedPackage[]
  /**
   * Default true. Type-only statements are erased whole, so a type edge onto a
   * hosted contract puts nothing in the artifact and is not a breach.
   */
  runtimeOnly?: boolean

  /** Bare package names this entry may never reach, matched by package prefix. */
  forbiddenPackages: string[]
  /** Repo-relative module prefixes this entry may never reach. */
  forbiddenModules: string[]
  /**
   * Exceptions to `forbiddenModules`, matched as exact repo-relative ids or
   * `${prefix}/` roots. Present so a policy can permit ONE declared subpath of
   * an otherwise-forbidden package rather than dropping the whole rule.
   */
  permittedModules?: string[]
  /**
   * `from -> to` edges that leave every declared root and are known to be
   * harmless. Anything else that leaves the roots is a broken measurement:
   * source this product executes that this policy did not walk.
   */
  permittedOutsideRoots?: string[]

  /**
   * Proof the walk resolved and read what it claims. Not optional.
   */
  control: {
    /** The closure must reach at least this many modules. */
    minModules: number
    /**
     * Repo-relative module ids that MUST be in the closure. Pick modules whose
     * absence means the walk broke, not modules that merely happen to be there.
     */
    requiredModules: string[]
    /** Bare packages that MUST be reached. Empty only for a package with none. */
    requiredPackages?: string[]
  }

  /**
   * Measured size. Not a boundary — the rules above name specific modules and
   * packages; this catches the change that stays inside every named rule and
   * still doubles what a product carries, which is how a closure actually
   * grows.
   */
  ceilings?: { modules: number; packages: number }
}

export type Finding = { kind: string; detail: string }

export type Result = {
  policy: Policy
  closure: Closure
  /** A failed measurement. Reported first — nothing else means anything. */
  brokenMeasurement: Finding[]
  /** A real boundary violation in the walked source. */
  violations: Finding[]
  /** A recorded size that moved. */
  drift: Finding[]
}

function matchesPackage(specifier: string, names: readonly string[]) {
  return names.some((name) => specifier === name || specifier.startsWith(`${name}/`))
}

function underPrefix(id: string, prefixes: readonly string[]) {
  return prefixes.some((prefix) => id === prefix || id.startsWith(`${prefix}/`) || id.startsWith(prefix))
}

export function evaluate(policy: Policy): Result {
  const closure = walk({
    entry: path.join(REPO_ROOT, policy.entry),
    roots: policy.roots,
    aliases: policy.aliases,
    followed: policy.followed,
    runtimeOnly: policy.runtimeOnly ?? true,
  })

  const ids = new Set(closure.modules.map((module) => module.id))
  const brokenMeasurement: Finding[] = []

  if (closure.modules.length < policy.control.minModules) {
    brokenMeasurement.push({
      kind: "control",
      detail:
        `reached ${closure.modules.length} module(s), fewer than the ${policy.control.minModules} this policy ` +
        `declares — the walk did not read this product`,
    })
  }
  for (const required of policy.control.requiredModules) {
    if (!ids.has(required)) {
      brokenMeasurement.push({ kind: "control", detail: `required module not in the closure: ${required}` })
    }
  }
  for (const required of policy.control.requiredPackages ?? []) {
    if (!closure.packages.includes(required)) {
      brokenMeasurement.push({ kind: "control", detail: `required package not reached: ${required}` })
    }
  }
  for (const item of closure.unresolved) {
    // A single unresolved specifier makes every count and every clean offender
    // list a lower bound rather than an answer.
    brokenMeasurement.push({ kind: "unresolved", detail: item })
  }
  const allowedOutside = new Set(policy.permittedOutsideRoots ?? [])
  for (const item of closure.outsideRoots) {
    if (allowedOutside.has(item)) continue
    brokenMeasurement.push({
      kind: "outside-roots",
      detail: `${item} — a followable first-party edge this policy's roots do not cover`,
    })
  }
  for (const item of closure.opaque) {
    // `import(someVariable)` is invisible to this walk and to the typechecker.
    // One such edge in this repository survived a package move and broke at
    // runtime with a clean import graph the whole time.
    brokenMeasurement.push({ kind: "opaque", detail: item })
  }

  const permitted = policy.permittedModules ?? []
  const violations: Finding[] = []

  for (const name of policy.forbiddenPackages) {
    const hits = closure.packageEdges.filter((edge) => matchesPackage(edge.specifier, [name]))
    if (hits.length === 0) continue
    const chain = shortestChain(closure, (candidate) =>
      candidate.specifier !== undefined && candidate.package !== undefined
        ? matchesPackage(candidate.specifier, [name])
        : false,
    )
    violations.push({
      kind: "forbidden-package",
      detail: `${policy.entry} reaches ${name}\n    ${(chain ?? hits.map((hit) => hit.from)).join("\n    -> ")}`,
    })
  }

  for (const prefix of policy.forbiddenModules) {
    const hits = [...ids].filter((id) => underPrefix(id, [prefix]) && !underPrefix(id, permitted))
    if (hits.length === 0) continue
    const chain = shortestChain(
      closure,
      (candidate) => underPrefix(candidate.id, [prefix]) && !underPrefix(candidate.id, permitted),
    )
    violations.push({
      kind: "forbidden-module",
      detail: `${policy.entry} reaches ${prefix} (${hits.length} module(s))\n    ${(chain ?? hits).join("\n    -> ")}`,
    })
  }

  const drift: Finding[] = []
  if (policy.ceilings) {
    if (closure.modules.length > policy.ceilings.modules) {
      drift.push({
        kind: "ceiling",
        detail: `module closure grew to ${closure.modules.length} (recorded ${policy.ceilings.modules})`,
      })
    }
    if (closure.packages.length > policy.ceilings.packages) {
      drift.push({
        kind: "ceiling",
        detail: `package closure grew to ${closure.packages.length} (recorded ${policy.ceilings.packages})`,
      })
    }
  }

  return { policy, closure, brokenMeasurement, violations, drift }
}

export function isFailure(result: Result) {
  return result.brokenMeasurement.length > 0 || result.violations.length > 0 || result.drift.length > 0
}
