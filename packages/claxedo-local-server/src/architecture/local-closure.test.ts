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
    // `runtimeOnly`: the edges that survive compilation, i.e. what this build
    // can execute. Every published module is a producer, so the module number
    // is this package's own production module count. A rise means the desktop
    // product gained surface; a fall should lower the ceiling with it, and
    // neither number may be summed from increments — re-run and read what the
    // walk measures.
    //
    // Why the modules the desktop owns are owned here:
    //  - `platform/json.ts` — the one leaf every module reading untrusted JSON
    //    narrows through instead of writing its own `record`/`text` pair.
    //  - `agent-config/hosted-mcp-install.ts` — the one-click write of the
    //    hosted `claxedo` entry into the Claude Code, Cursor and Codex configs
    //    on this machine; the desktop's own agent-config routes are what a user
    //    clicks.
    //  - `shell/event-stream-response.ts` — the one writer that serves the
    //    daemon's `cp/events` over HTTP SSE or a loopback WebSocket alike.
    //  - `app/local-documents.ts` — the desktop composition of shared Documents.
    //  - `credentials/broker.ts` — the credential authority that derives a
    //    binding per active registry row and hands the loopback broker its
    //    handler. The table naming each provider's vendor host, methods, paths
    //    and header shape is a fact about the vendor rather than about this
    //    machine, so server-core owns it and the cloud delivery adapter reads
    //    the same rows.
    //  - `credentials/machine-credentials.ts` — asking a CLI what it is signed
    //    in as, and withdrawing the stored mark so a harness runs on that
    //    login, have no referent on a host where no harness is installed.
    //  - `credentials/operations/drop-copied-harness-logins.ts` — the one-time
    //    delete of the harness logins an older Claxedo copied off this machine;
    //    this is the process that ran that scan.
    //  - `usage/adapters/token-tracker-usage-limits.ts` — the plan probe for
    //    every agent installed on this machine, which only a server running on
    //    that machine can ask.
    //  - `tasks/` — the route composition and the session bridge it hands the
    //    kit; the kit itself is reached through server-core's tasks-host
    //    owners, and nothing outside `src/tasks/` imports either module.
    //  - `shell/host-events.ts` — the host aggregate `wr/events`: one
    //    connection carrying every embedded runtime's frames, read from the
    //    taps only a process that hosts those runtimes can reach.
    //  - `workspace/host-serving-routes.ts` — the loopback route that hands
    //    `@claxedo/host-serving` the embedded runtimes' `sessionAuthority`.
    //  - `workspace/runtime-dispatch/ingress-provenance.ts` and
    //    `deployments/local/host-session-authority.ts` — the two halves of
    //    admitting a RELAYED caller to a machine that also serves its own
    //    user: the first decides, per request, whether a caller is the relay
    //    replaying onto loopback or the owner at the keyboard; the second
    //    composes the private-session policy and the relay-token verifier the
    //    first asks. Only a process that hosts the runtimes has both callers.
    //  - `workspace/host-provider-config.ts` and
    //    `workspace/host-provider-config-routes.ts` — the provider rows the
    //    owner pushed to THIS machine and the loopback route Electron main
    //    installs them through; only the process whose runtimes resolve a
    //    turn's credentials can hold them. The parser and the `projectAuth`
    //    composition are server-core's `credentials/host-provider-config.ts`.
    //  - `platform/auth/project-access.ts` — the one authorization operation
    //    for the projects this server stores, shared by the shell `/project`
    //    routes and the `/api/claxedo/projects` router. Two route families in
    //    this package ask the same question, and a second implementation of it
    //    is a second answer; it reaches only server-core's authority port and
    //    branded-id leaves.
    //  - `app/daemon-admission.ts` and
    //    `workspace/runtime-dispatch/relay-admission.ts` — who may drive this
    //    daemon, and the bound within which that answer defers to the relay.
    //    A loopback page is not the application, so this composition needs an
    //    authority of its own; shared server-core has no daemon to
    //    authenticate and no dispatcher to bound. `node:crypto`, server-core's
    //    error body, and the two dispatch modules already here.
    //
    // And the packages: `@claxedo/opencode-server-adapter` is the isolated
    // HTTP/SSE provider, with no embedded engine or generated client;
    // `@claxedo/mcp` is the first-party endpoint mounted at
    // `/api/claxedo/mcp`; `@claxedo/egress-broker` is the request policy,
    // header injection and runtime-token verification behind the broker
    // handler; `smol-toml` is the hosted MCP installer's configuration
    // validator; `@claxedo/agent-runtime-contract` is the dependency-free data
    // this product reads rather than restating — the harness/provider-id table
    // the credential routes, the reaper and the agent-config auth route all
    // key on, and the login-document claim readers the provider-auth exchange
    // uses; `@claxedo/host-serving` owns the serving half of remote access —
    // the one relay loop for the assigned∩acked set and the per-workspace
    // surface a relayed request may reach — for this daemon and a
    // `claxedo connect` host alike, and reaches only server-core's log and
    // peer-address leaves and the runtime's relay subpath.
    const { modules, packages } = closure({ runtimeOnly: true })
    expect(modules.size).toBeLessThanOrEqual(96)
    expect(packages.size).toBeLessThanOrEqual(27)
  })
})
