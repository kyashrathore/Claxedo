import { describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { importSpecifiers, packageNameOf, sourceClosure } from "@claxedo/server-core/platform/governance/source-closure"

const ROOT = path.resolve(import.meta.dirname, "../..")

/**
 * What the desktop-local server closes over: the manifest states ownership,
 * and this file checks that the source agrees with it.
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
 * The source producers this package publishes, derived from its `exports` map.
 * The manifest is the only statement of what a consumer can import; a
 * hand-written producer list would leave every later module unwalked.
 *
 * Most exports are `./*` -> `./src/*.ts`, so every source module is a producer.
 * The self-hosted entry's `import` target under `dist/` is skipped: that bundle
 * is measured from Bun's source map by `script/product-boundary/verify.ts`, and
 * walking it here would count its dynamic-import expressions and external
 * packages as authored modules.
 *
 * Test code is dropped — a `.test.` file and anything under `test-support/`
 * (not shipped, and allowed edges a product module is not: a test may reach for
 * a hosted package to assert it stays out) — and so are ambient `.d.ts` files
 * (erased whole, no runtime edge).
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
    .filter((file) => !file.includes(".test.") && !file.includes("/test-support/") && !file.endsWith(".d.ts"))
    .sort()
}

/**
 * Packages that must never appear in this product's closure. Each is a hosted
 * capability the unsigned desktop has no way to use and no business carrying.
 */
const FORBIDDEN_PACKAGES = [
  "@claxedo/sandbox-manager",
  "@claxedo/server",
  "@claxedo/channels",
  "@claxedo/connections",
  "@claxedo/wakes",
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
    // `import(someVariable)` is invisible to this walk and to the typechecker;
    // one such edge broke at runtime behind a clean import graph, so none are
    // allowed — Node-only modules stay out of Worker bundles through ports.
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
    // introduced; the package count fell back to 21 after that ownership move.
    // The tenant-aware runtime principal composer adds one local module while
    // keeping the package closure unchanged and gives every runtime proxy the
    // same fail-closed identity path. A further rise means the desktop product
    // gained surface, and a fall should lower the ceiling with it.
    // The explicit external OpenCode server provider adds the reviewed 22nd
    // package at the desktop composition root; it contains only the isolated
    // HTTP/SSE adapter and no embedded engine or generated client. The package
    // number is the reach that matters — a rise is a new dependency the
    // unsigned desktop now carries and is worth reading before it is bumped.
    // AgentConfigRoutes owns the authenticated Pi catalog in provider-routes.ts;
    // shell project-routes owns authorized metadata edits and catalog replay.
    //
    // Agent Plugins adds its feature-owned modules — activation routes/store,
    // retained artifact storage, composition, generation, materialization,
    // plugin data, and the harness projections — reaching this package through
    // the composition's route contributions and the agent-config launch
    // projection. They use packages already present in this closure. The
    // `platform/json.ts` is the 80th module: one dependency-free leaf owned by
    // this package that every module reading untrusted JSON narrows through
    // instead of writing its own `record`/`text` pair. It adds no package edge,
    // and importing it from more modules cannot grow this set — it is already
    // in it. The 23rd package is `@claxedo/mcp`, the first-party MCP endpoint
    // the desktop composition mounts at `/api/claxedo/mcp` for the sessions it
    // launches; it reaches only the MCP SDK, hono, zod, helpers and the runtime
    // contract, all already present here. The 81st module is
    // `agent-config/hosted-mcp-install.ts`, the one-click write of the hosted
    // `claxedo` entry into the Claude Code, Cursor and Codex configs on this
    // machine — the desktop's own agent-config routes are what a user clicks,
    // so this is where it belongs; it reads node builtins only and adds no
    // package edge. The numbers below are the last MEASURED values
    // (81 modules, 23 packages) and must be re-run, never summed from
    // increments.
    const { modules, packages } = closure({ runtimeOnly: true })
    // The merged dev tree also publishes agent-plugins/discovery/skills.ts,
    // the restored machine-installed skill reader (82 modules at HEAD).
    // shell/event-stream-response.ts adds the central event transport owner;
    // the published closure now measures exactly 83 modules / 24 packages.
    // app/local-documents adds the desktop composition of shared Documents;
    // the published closure measures 84 modules / 24 packages.
    // credentials/broker.ts is the desktop's credential authority, which
    // derives a binding per active registry row and hands the loopback broker
    // its handler. Its one new package edge is @claxedo/egress-broker, the
    // request policy, header injection and runtime-token verification behind
    // that handler; it reaches only `jose` and `@hono/node-server`, both
    // already here. The table naming each provider's vendor host, allowed
    // methods and paths and header shape is a fact about the vendor rather
    // than about this machine, so it is owned by server-core, where the cloud
    // delivery adapter reads the same rows; it adds no package edge here.
    // credentials/machine-credentials.ts is the credential port for a server
    // running on the machine the harnesses live on. Asking a CLI what it is
    // signed in as, and withdrawing the stored mark so a harness runs on that
    // login, have no referent on a host where no harness is installed, so they
    // are composed here rather than in the shared default.
    // credentials/operations/drop-copied-harness-logins.ts is the one-time
    // delete of the harness logins an older Claxedo copied off this machine. It
    // belongs to this product because this is the process that ran that scan.
    // Both reach only the registry and the machine-login reader, which this
    // closure already holds.
    // usage/adapters/token-tracker-usage-limits.ts is the plan probe for every
    // agent installed on this machine, which only a server running on that
    // machine can ask. It reaches tokentracker-cli and this package's JSON
    // narrowing, both already here, so it adds no package edge — the history
    // adapter beside it already carries that dependency.
    // Tasks adds its two feature-owned modules -- the route composition and
    // the session bridge it hands the kit. The kit itself is reached through
    // server-core's tasks-host owners, and this package's only direct import
    // of `@claxedo/tasks` is a type, so it adds no package edge here. Nothing
    // outside `src/tasks/` imports either module, so a product entry that does
    // not mount the composition carries neither.
    // Measured: 90 modules, 25 packages.
    expect(modules.size).toBeLessThanOrEqual(90)
    // smol-toml is the hosted MCP installer's configuration validator.
    expect(packages.size).toBeLessThanOrEqual(25)
  })
})
