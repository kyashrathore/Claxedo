import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs"
import path from "node:path"

const repoRoot = path.resolve(import.meta.dir, "../../../..")
const packagesRoot = path.join(repoRoot, "packages")

/**
 * Packages that pin `solid-js` 2.x, discovered from their own package.json
 * rather than listed here.
 *
 * The list is derived on purpose. Every scan during the Solid 2 migration was
 * hardcoded to claxedo-app/ui/session-ui, so `claxedo-desktop` — which pins
 * 2.0.0-rc.1 like the others — was missed entirely and kept two
 * `createTrackedEffect` call sites long after they were reported as gone. A
 * guard with a hand-maintained package list would inherit exactly that bug.
 *
 * `tui` and `opencode` pin 1.9.12 through the catalog and are deliberately
 * excluded by the version check: they are terminal UI running in a separate
 * process, not part of the Solid 2 app graph.
 */
type Manifest = Partial<Record<"dependencies" | "devDependencies" | "peerDependencies", Record<string, string>>> & {
  name?: string
}

function solid2Packages(): { name: string; dir: string }[] {
  const out: { name: string; dir: string }[] = []
  for (const entry of readdirSync(packagesRoot)) {
    const dir = path.join(packagesRoot, entry)
    let manifest: Manifest
    try {
      manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"))
    } catch {
      continue
    }
    // `ui` is a library and declares solid-js as a dev + peer dependency, not a
    // runtime one, so all three fields have to be consulted.
    const declared = (["dependencies", "devDependencies", "peerDependencies"] as const)
      .map((field) => manifest[field]?.["solid-js"])
      .find(Boolean)
    if (!declared || !/^\^?2\./.test(declared)) continue
    if (!existsSync(path.join(dir, "src"))) continue
    out.push({ name: manifest.name ?? entry, dir })
  }
  return out
}

/** The solid-js version a package actually resolves on disk, not the range it asks for. */
function resolvedSolidVersion(dir: string): string | undefined {
  const local = path.join(dir, "node_modules", "solid-js", "package.json")
  const manifestPath = existsSync(local) ? local : path.join(repoRoot, "node_modules", "solid-js", "package.json")
  if (!existsSync(manifestPath)) return undefined
  return JSON.parse(readFileSync(realpathSync(manifestPath), "utf8")).version
}

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (current: string) => {
    for (const entry of readdirSync(current)) {
      if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue
      const full = path.join(current, entry)
      if (statSync(full).isDirectory()) {
        walk(full)
        continue
      }
      if (!/\.tsx?$/.test(entry)) continue
      // Tests may use `createTrackedEffect` as a probe for the primitive's own
      // semantics; the ban is on shipping it.
      if (/\.(test|vitest)\./.test(entry)) continue
      out.push(full)
    }
  }
  walk(dir)
  return out
}

describe("solid 2 runtime", () => {
  test("finds the packages that pin solid-js 2.x", () => {
    // A sanity check on the discovery itself: if this ever returns nothing the
    // two tests below would pass vacuously.
    const names = solid2Packages()
      .map((pkg) => pkg.name)
      .sort()
    expect(names.length).toBeGreaterThanOrEqual(4)
    expect(names).toContain("@claxedo/app")
  })

  test("resolves one solid-js runtime across the whole app graph", () => {
    // Asserted on the RESOLVED version, not the declared range: `ui` peers on
    // `^2.0.0-rc.1` while the apps pin it exactly, and both resolve to the same
    // copy. What matters is the copy.
    //
    // Two Solid runtimes in one bundle means two owner stacks and two
    // schedulers — context would not cross them and disposal would not
    // propagate. `solid-js@1.9.12` IS installed (tui, opencode and a few
    // transitive deps pin it), so this is a live hazard, not a theoretical one;
    // bun nests those copies so they stay out of the app graph.
    const resolved = solid2Packages().map((pkg) => [pkg.name, resolvedSolidVersion(pkg.dir)] as const)
    expect(resolved.filter(([, version]) => !version)).toEqual([])
    expect([...new Set(resolved.map(([, version]) => version))]).toHaveLength(1)
  })

  test("ships no createTrackedEffect call sites", () => {
    // `createTrackedEffect` tracks and applies in the SAME scope, which its own
    // docblock warns "may run multiple times for a single change or show
    // tearing (reading inconsistent state)", and reserves for the case where
    // "dynamic subscription patterns require same-scope tracking". Nothing in
    // this repo needed that: every site was a two-phase `createEffect(compute,
    // effect)` in disguise, and several were reading a source they also wrote.
    //
    // A same-scope body is also children-forbidden, so calling a primitive that
    // registers its own `onCleanup` (e.g. `createResizeObserver`) throws
    // CLEANUP_IN_FORBIDDEN_SCOPE — and an uncaught throw from an effect halts
    // the entire reactive system. Two such crashes were live before the
    // migration.
    //
    // If you genuinely need same-scope dynamic subscription, add the site here
    // with the reason rather than deleting the guard.
    const offenders = solid2Packages().flatMap(({ name, dir }) =>
      sourceFiles(path.join(dir, "src")).flatMap((file) => {
        const text = readFileSync(file, "utf8")
        if (!text.includes("createTrackedEffect(")) return []
        return [`${name}: ${path.relative(dir, file)}`]
      }),
    )
    expect(offenders).toEqual([])
  })
})
