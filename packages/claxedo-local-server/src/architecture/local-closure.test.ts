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
 * The daemon entry's (`./self-hosted-execution`) `import` target under `dist/`
 * is skipped: that bundle is measured from Bun's source map by
 * `script/product-boundary/verify.ts`, and walking it here would count its
 * dynamic-import expressions and external packages as authored modules.
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
    //  - `app/daemon-admission.ts` and
    //    `workspace/runtime-dispatch/relay-admission.ts` — who may drive this
    //    daemon, and the bound within which that answer defers to the relay.
    //    A loopback page is not the application, so this composition needs an
    //    authority of its own; shared server-core has no daemon to
    //    authenticate and no dispatcher to bound. `node:crypto`, server-core's
    //    error body, and the two dispatch modules already here.
    //  - `app/daemon-operation-store.ts` and `app/daemon-ownership-snapshot.ts`
    //    — machine-scope recovery receipts in this machine's own database, and
    //    the redacted inventory it republishes for a launcher that cannot reach
    //    its HTTP. Workspace ownership stays in each workspace's RuntimeStore;
    //    what lives here spans every workspace at once, so no single one of
    //    them can hold it. They reach `@claxedo/helpers`,
    //    `@claxedo/agent-runtime-contract` (which owns the recovery scope key)
    //    and the ClaxedoDB engine, all already here.
    //
    // And the packages: `@claxedo/harness` is the harness contract, registry
    // and provider list the embedded runtimes and the Agent Plugins projection
    // type against; `@claxedo/mcp` is the first-party endpoint mounted at
    // `/api/claxedo/mcp`; `@claxedo/egress-broker` is the request policy,
    // header injection and runtime-token verification behind the broker
    // handler; `@claxedo/process-ownership` supplies dependency-free data and
    // OS reads, with no server, runtime or store closure behind them;
    // `@claxedo/agent-runtime-contract` is the dependency-free data
    // this product reads rather than restating — the harness/provider-id table
    // the credential routes, the reaper and the agent-config auth route all
    // key on, and the login-document claim readers the provider-auth exchange
    // uses; `@claxedo/host-serving` owns the serving half of remote access —
    // the one relay loop for the assigned∩acked set and the per-workspace
    // surface a relayed request may reach — for this daemon and a
    // `claxedo connect` host alike, and reaches only server-core's log and
    // peer-address leaves and the runtime's relay subpath.
    // `@claxedo/account-contract` owns the account vocabulary the credential
    // routes validate against (whose account a person spends, where a stored
    // account may be delivered), the same words the app and the hosted server
    // read; this product reaches only its import-free `vocabulary` subpath.
    // `node:timers` is the device-code poll's sleep in
    // `credentials/provider-auth/service.ts` — bounded waits on the server
    // thread, which only a Node runtime has. `@claxedo/plugin-api` and
    // `@claxedo/plugin-build` with `plugins/*` are the daemon's live plugins,
    // an approved server addition in the app rebuild plan: it registers a
    // machine's plugins, builds each into a hashed bundle, serves it and
    // announces changes. Clone destination admission (`node:dns`) moved with
    // the projects route into server-core's projects module.
    //  - `session/publish/*` — the machine publisher: a signed-in machine
    //    publishes each served session's list row and status to the control
    //    plane, on change and in full whenever its serving credential or
    //    workspace set changes. Only the process that holds the projection,
    //    hosts the runtimes whose frames carry status, and receives the Host
    //    Tunnel Token can. The five modules reach the projection port and
    //    its change notices, host-serving's credential listener, the runtime
    //    registry and `platform/json.ts`, all here, and server-core's
    //    session-rows contract, which costs no package.
    //  - `session/list/session-list-page.ts` — the daemon's session list: one
    //    keyset page per project or workspace, from the projection for this
    //    machine and from the authority for a signed caller, each row carrying
    //    its runtime's status. It reaches the projection's keyset read and
    //    server-core's navigation list, both here.
    //  - `session/runtime-activity.ts` — a mounted runtime's statuses,
    //    permissions and questions read in process, for the list page and the
    //    machine publisher alike.
    //  - `plugins/authoring.ts` and `plugins/scaffold.ts` — app plugin
    //    authoring, the grant the first-party MCP's `app_plugin_*` tools call
    //    for a session of this machine's owner: a new plugin folder in the
    //    session's workspace, its check and its registration with the live
    //    plugins above.
    // +13 modules for the daemon's attention projection/history publishers,
    // per-reader routes and exact cleanup admission, including machine and
    // desktop grant handoffs. They compose existing local/runtime authorities
    // without a hosted package edge. Production and isolated frozen builds
    // with their built-entry smokes passed. The mounted reader and connection
    // secret resolver are the registry's extracted canonical read and credential
    // owners; the exact location route resolves a canonical workspace/project
    // after session authorization. They add no package. Measured 122/30, no headroom.
    // +2 canonical owners: embedded-runtime-ownership.ts describes serving and
    // retiring owners with durable launch reads; session-row-origins.ts owns
    // machine recovery policy over mounted root attention and the shared core
    // publication-origin mechanism. No package growth: exact 124/30.
    const { modules, packages } = closure({ runtimeOnly: true })
    expect(modules.size).toBeLessThanOrEqual(124)
    expect(packages.size).toBeLessThanOrEqual(30)
  })
})
