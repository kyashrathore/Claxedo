import { describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { importSpecifiers, packageNameOf, sourceClosure } from "@claxedo/server-core/platform/governance/source-closure"

const ROOT = path.resolve(import.meta.dirname, "../..")

/**
 * What the desktop-local server closes over.
 *
 * When this measurement started, the desktop-local entry reached 259 first-party
 * modules and 42 packages — Convex, better-auth, WorkGraph, channels,
 * connections, wakes — from a build that never signs in. Most of that came from
 * sharing one package with the hosted product. The manifest now states
 * ownership directly, and this file is the check that the source agrees with the
 * manifest.
 */

type ExportTarget = string | null | { [condition: string]: ExportTarget }

type Manifest = {
  exports?: Record<string, ExportTarget>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

function manifest(): Manifest {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as Manifest
}

/** Every file target in an exports entry, across all of its conditions. */
function exportTargets(node: ExportTarget): string[] {
  if (node === null) return []
  if (typeof node === "string") return [node]
  return Object.values(node).flatMap(exportTargets)
}

function filesUnder(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    return entry.isDirectory() ? filesUnder(full) : [full]
  })
}

/**
 * The SOURCE producers this package publishes, derived from its `exports` map.
 *
 * This used to be a hand-written list of thirteen route and composition files,
 * and that made the gate silent for everything written after it: a new producer
 * that imported Convex was simply not walked, and every assertion below stayed
 * green about it. The manifest is the only statement of what a consumer can
 * import, so the manifest is what the measurement reads.
 *
 * Most exports are `./*` -> `./src/*.ts`, so every source module is publishable
 * and every source module is a producer. The production self-hosted entry also
 * has an `import` target under `dist/`; that emitted bundle is measured from
 * Bun's source map by Unit 12's shared verifier. Feeding the generated bundle
 * back into this SOURCE walk would count its dynamic-import expressions and
 * external packages as if they were authored modules, duplicating the emitted
 * gate and making a build artifact change the source answer.
 *
 * Two kinds of matched file are dropped. Tests match the pattern but are not
 * shipped and are allowed edges a product module is not — a test may reach for
 * a hosted package to assert it stays out. Ambient `.d.ts` declarations are
 * erased whole and carry no runtime edge at all.
 */
function producers(): string[] {
  const sources = filesUnder(path.join(ROOT, "src")).map(
    (file) => `./${path.relative(ROOT, file).split(path.sep).join("/")}`,
  )
  const matched = new Set<string>()
  for (const target of new Set(Object.values(manifest().exports ?? {}).flatMap(exportTargets))) {
    if (!target.startsWith("./src/")) continue
    if (!target.includes("*")) {
      matched.add(target)
      continue
    }
    // Node's subpath patterns: a single `*` standing for any substring,
    // slashes included.
    const [prefix = "", suffix = ""] = target.split("*")
    for (const file of sources) {
      if (file.length >= prefix.length + suffix.length && file.startsWith(prefix) && file.endsWith(suffix)) {
        matched.add(file)
      }
    }
  }
  return [...matched]
    .map((file) => file.replace(/^\.\//, ""))
    .filter((file) => !file.includes(".test.") && !file.endsWith(".d.ts"))
    .sort()
}

/**
 * Packages that must never appear in this product's closure. Each is a hosted
 * capability the unsigned desktop has no way to use and no business carrying.
 */
const FORBIDDEN_PACKAGES = [
  "@claxedo/sandbox-manager",
  "@claxedo/server",
  "@claxedo/workgraph",
  "@claxedo/channels",
  "@claxedo/connections",
  "@claxedo/wakes",
  "convex",
  "better-auth",
  "posthog-node",
]

function closure(options: { runtimeOnly?: boolean } = {}) {
  const modules = new Set<string>()
  const packages = new Set<string>()
  const unresolved: string[] = []
  const opaque: string[] = []
  const entries = producers()
  for (const producer of entries) {
    const result = sourceClosure({ entry: path.join(ROOT, producer), root: ROOT, ...options })
    for (const module of result.modules) {
      if (!module.relative.includes(".test.")) modules.add(module.relative)
    }
    for (const name of result.packages) packages.add(name)
    unresolved.push(...result.unresolved)
    opaque.push(...result.opaque)
  }
  return { entries, modules, packages, unresolved: [...new Set(unresolved)], opaque: [...new Set(opaque)] }
}

/** `module -> package` for every direct edge onto one of `names`. */
function edgesOnto(modules: Iterable<string>, names: string[]) {
  const offenders: string[] = []
  for (const relative of modules) {
    const source = fs.readFileSync(path.join(ROOT, relative), "utf8")
    for (const name of new Set(importSpecifiers(source).map(packageNameOf))) {
      if (names.includes(name)) offenders.push(`${relative} -> ${name}`)
    }
  }
  return offenders.sort()
}

describe("@claxedo/local-server closure", () => {
  it("walks every module the manifest publishes, so an empty offender list means something", () => {
    // Positive control. Every boundary assertion below is "the offenders list
    // is empty", which is also what a derivation that matched nothing reports.
    const { entries, modules } = closure()

    expect(entries.length, "the exports map matched no producer").toBeGreaterThan(40)
    expect(modules.size, "the walk reached no module").toBeGreaterThan(40)
    // Every published module is walked as an entry, so each must appear in the
    // result. A producer missing here means its file could not be read.
    expect(entries.filter((entry) => !modules.has(entry)), "producers the walk did not reach").toEqual([])
  })

  it("reaches no hosted capability package", () => {
    const { modules, packages } = closure()
    // The package name alone says a hosted capability got in; the edge list
    // says which module to cut.
    expect(edgesOnto(modules, FORBIDDEN_PACKAGES)).toEqual([])
    expect(FORBIDDEN_PACKAGES.filter((name) => packages.has(name))).toEqual([])
  })

  it("declares every package it reaches", () => {
    // A package reached but not declared works only by hoisting — it is a
    // dependency this manifest does not own, and it can vanish under a
    // different install layout.
    const declared = new Set([
      ...Object.keys(manifest().dependencies ?? {}),
      ...Object.keys(manifest().devDependencies ?? {}),
    ])
    const undeclared = [...closure().packages]
      .filter((name) => !name.startsWith("node:"))
      .filter((name) => !declared.has(name))
      // Node built-ins reached without the `node:` prefix.
      .filter((name) => !["fs", "path", "os", "crypto", "url", "child_process", "module", "http", "https", "net", "util", "events", "stream", "buffer", "zlib", "tty", "assert", "dns"].includes(name))
    expect(undeclared).toEqual([])
  })

  it("resolves every relative specifier, so the measurement is complete", () => {
    expect(closure().unresolved).toEqual([])
  })

  it("contains no import the walk cannot follow", () => {
    // `import(someVariable)` is invisible to this walk and to the typechecker.
    // Three such edges lived in this codebase to keep Node-only modules out of
    // a Worker bundle; one survived a package move and broke at runtime with a
    // clean import graph the whole time. They are ports now, and this keeps
    // them from coming back.
    expect(closure().opaque).toEqual([])
  })

  it("stays within its measured size", () => {
    // Measured 2026-08-09 from the derived producer set, with `runtimeOnly`:
    // the edges that survive compilation, i.e. what this build can execute.
    //
    // These replace 41 modules / 18 packages, which were measured from the
    // thirteen hand-listed producers. Nothing grew — the old numbers were a
    // walk of part of the package. The producer set is now all 47 published
    // modules, which pulls in the six no listed producer reached (the app
    // composition, the extension and credential services, the session meta
    // tap) and with them `@hono/node-server`, `@claxedo/agent-sdk-runtime` and
    // `tokentracker-cli`.
    //
    // Because every published module is a producer, the module number is this
    // package's own production module count: the eight-module increase is the
    // local usage route, durable ledger and provenance ports, scanner, pricing
    // port, outbox, stable ledger identity, and their desktop composition.
    // Shared implementations live in server-core, so no hosted product edge is
    // introduced. The package count is 22 after adding the deliberately narrow
    // `@claxedo/opencode-runtime` owner of the public embedded SDK. A further
    // rise means the desktop product
    // gained surface, and a fall should lower the ceiling with it. The package
    // number is the reach that matters — a rise is a new dependency the
    // unsigned desktop now carries and is worth reading before it is bumped.
    const { modules, packages } = closure({ runtimeOnly: true })
    expect(modules.size).toBeLessThanOrEqual(56)
    expect(packages.size).toBeLessThanOrEqual(22)
  })
})
