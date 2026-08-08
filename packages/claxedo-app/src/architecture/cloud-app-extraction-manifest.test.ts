import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { allImportSpecifiers, importSpecifiers, resolveImport } from "./import-graph"
import { prodSourcePaths } from "./scanners"

const appRoot = path.resolve(import.meta.dir, "../..")
const srcRoot = path.join(appRoot, "src")

/**
 * What Unit 10's extraction actually costs, measured.
 *
 * Unit 10 creates `@claxedo/cloud-app` and physically moves the hosted renderer
 * out of `@claxedo/app`. It has to land as one slice — a half-moved package does
 * not build — so the only way to make it cheap is to know its shape BEFORE the
 * first file moves. This file is that measurement. It moves nothing.
 *
 * Two directions, and they cost completely different things:
 *
 *  1. LOCAL -> CLOUD. A local module that imports a hosted module is an edge the
 *     move BREAKS. Every one of them must be cut (delete the call), inverted
 *     (local declares a port, cloud registers into it), or followed (the local
 *     module was mis-filed and moves too). These are the edges that decide
 *     whether the slice is a day or a week, so they are counted per candidate
 *     root and the worst offenders are named individually.
 *
 *  2. CLOUD -> LOCAL. A hosted module that imports a local module names
 *     something `@claxedo/app` must EXPORT. The plan is explicit that
 *     "cloud-app receives no private alias into app source", so this list is not
 *     advisory: it is the public surface that must exist on the day of the move,
 *     minus whatever `package.json#exports` already publishes.
 *
 * Both are recorded as exact baselines. A number that MOVES is the signal:
 *
 *  - Direction 1 count DOWN  = good. An edge was cut or inverted; the extraction
 *    got cheaper. Lower the baseline.
 *  - Direction 1 count UP    = a new local dependency on hosted code was added
 *    after the split was planned. Cut it now, while it is one import.
 *  - Direction 2 count DOWN  = good. Fewer app internals need publishing.
 *  - Direction 2 count UP    = the public surface `@claxedo/app` must commit to
 *    just grew. Every entry is a contract someone outside the package can pin.
 *
 * Type-only imports are counted, deliberately, and differently from the boundary
 * guards next door. `local-product-boundary.guard.test.ts` excludes them because
 * it asks "does this reach the hosted RUNTIME", and the bundler erases types. This
 * file asks "what breaks when the file is in another package", and a type import
 * across a package boundary breaks exactly as loudly as a value one — it needs an
 * export either way. Value edges are tracked separately where the distinction
 * changes the remedy.
 */

/**
 * The starting manifest, copied from `hosted-operation-inventory.test.ts`.
 *
 * Copied rather than imported because that file is a test module with no
 * exports. The copy is checked against the original below, so the two cannot
 * drift silently.
 */
const HOSTED_CANDIDATE_ROOTS = [
  "features/workgraph",
  "features/documents",
  "platform/runtime/cloud",
  "features/workspaces",
  "features/settings",
  "features/onboarding",
  "app/routes",
]

/**
 * The files Unit 10's `Files:` section actually names, as path prefixes.
 *
 * Transcribed as the plan WROTE it, including the one entry that no longer
 * matches anything (see `STALE_PLAN_PREFIXES`). Correcting it here silently
 * would hide the defect the transcription exists to surface.
 *
 * This is NOT the same set as the candidate roots, and the gap is the single
 * most useful thing this file measures — see the "over-scoped" test below.
 * A trailing `/` means "the whole directory"; anything else is a literal file or
 * a filename stem the plan wrote with a `*` (`connections*`, `sandbox-section*`).
 */
const UNIT_10_MOVE_SET = [
  "app/entry/main.tsx",
  "app/routes/login.tsx",
  "app/routes/cli-login.tsx",
  "app/routes/cli-login-token.ts",
  "platform/auth/auth-client.ts",
  "platform/auth/auth-session.ts",
  "platform/account/browser-account-adapter.ts",
  "platform/runtime/cloud/",
  "features/workgraph/",
  "features/documents/",
  "features/onboarding/cloud-credentials-",
  "features/onboarding/code-host-",
  "features/onboarding/credential-sharing",
  "features/onboarding/project-remote-",
  "features/onboarding/sandbox-provider-",
  "features/onboarding/remote-access-marker.tsx",
  "features/settings/ui/account-section.tsx",
  "features/settings/ui/connections",
  "features/settings/ui/sandbox-driver-logo.tsx",
  "features/settings/ui/sandbox-section",
  "features/workspaces/data/share-workspace",
  "features/workspaces/data/workspace-connection",
  "features/workspaces/ui/cloud-auto-switch.tsx",
  "features/workspaces/ui/dialogs/create-cloud-project",
  "features/workspaces/ui/dialogs/provider-facts",
  "features/workspaces/ui/dialogs/provision-failure",
  "features/workspaces/ui/dialogs/repository-picker",
]

/**
 * Plan prefixes that match no file today, and what they were meant to name.
 *
 * A move list is written against a tree that then changes underneath it. A
 * prefix that matches nothing does not fail loudly — it just quietly contributes
 * zero modules, making the extraction look smaller than it is. So each one is
 * recorded with its real target, and the measured move set below uses the
 * correction while the transcription above keeps the plan's own words.
 */
const STALE_PLAN_PREFIXES: Record<string, { actual: string; reason: string }> = {
  "platform/account/browser-account-adapter.ts": {
    actual: "platform/account/browser-account-port.ts",
    reason:
      "Unit 6 planned this producer as `browser-account-adapter.ts` and landed it as `browser-account-port.ts`. Unit 10's Files list still names the pre-execution filename, so the move list must be corrected before the extraction, or the browser adapter is left behind in app.",
  },
}

/** The move list as it applies to the tree that exists now. */
const MEASURED_MOVE_SET = UNIT_10_MOVE_SET.map((prefix) => STALE_PLAN_PREFIXES[prefix]?.actual ?? prefix)

type Edge = { from: string; to: string; typeOnly: boolean }

type Extraction = {
  /** Every production module in the package, relative to `src`. */
  modules: string[]
  /** Modules the predicate assigns to cloud-app. */
  leaving: string[]
  /** Modules that stay in `@claxedo/app`. */
  staying: string[]
  /** Direction 1: staying -> leaving. The edges the move breaks. */
  inbound: Edge[]
  /** Direction 2: leaving -> staying. The export surface cloud-app needs. */
  outbound: Edge[]
}

/**
 * Split the package's production import graph by a leaving/staying predicate.
 *
 * The predicate is a parameter rather than a constant because the two manifests
 * that matter — the inventory's coarse roots and the plan's actual move list —
 * disagree, and the disagreement is a finding, not a bug to be normalized away.
 */
function measureExtraction(root: string, isLeaving: (module: string) => boolean): Extraction {
  const rootSrc = path.join(root, "src")
  const modules = prodSourcePaths(root)
    .map((file) => path.relative(rootSrc, file).split(path.sep).join("/"))
    .toSorted()

  const edges: Edge[] = []
  for (const module of modules) {
    const file = path.join(rootSrc, module)
    const text = readFileSync(file, "utf8")
    const valueSpecifiers = new Set(importSpecifiers(text))
    for (const specifier of allImportSpecifiers(text)) {
      const resolved = resolveImport(root, file, specifier)
      if (!resolved) continue
      const to = path.relative(rootSrc, resolved).split(path.sep).join("/")
      if (to === module) continue
      edges.push({ from: module, to, typeOnly: !valueSpecifiers.has(specifier) })
    }
  }

  return {
    modules,
    leaving: modules.filter(isLeaving),
    staying: modules.filter((module) => !isLeaving(module)),
    inbound: edges.filter((edge) => !isLeaving(edge.from) && isLeaving(edge.to)),
    outbound: edges.filter((edge) => isLeaving(edge.from) && !isLeaving(edge.to)),
  }
}

/** Distinct importers per imported module — the fan-in that makes an edge expensive. */
function fanIn(edges: Edge[]) {
  const map = new Map<string, Set<string>>()
  for (const edge of edges) {
    const importers = map.get(edge.to) ?? new Set<string>()
    importers.add(edge.from)
    map.set(edge.to, importers)
  }
  return map
}

/** Modules with at least `threshold` distinct importers, as `{ module: count }`. */
function heaviest(edges: Edge[], threshold: number) {
  return Object.fromEntries(
    [...fanIn(edges)]
      .filter(([, importers]) => importers.size >= threshold)
      .toSorted((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]))
      .map(([module, importers]) => [module, importers.size]),
  )
}

function prefixMatcher(prefixes: string[]) {
  return (module: string) =>
    prefixes.some((prefix) =>
      prefix.endsWith("/") ? module.startsWith(prefix) : module === prefix || module.startsWith(prefix),
    )
}

const isCandidate = (module: string) =>
  HOSTED_CANDIDATE_ROOTS.some((root) => module === root || module.startsWith(`${root}/`))
const candidateRootOf = (module: string) =>
  HOSTED_CANDIDATE_ROOTS.find((root) => module === root || module.startsWith(`${root}/`))
const isPlanned = prefixMatcher(MEASURED_MOVE_SET)

const byCandidateRoots = measureExtraction(appRoot, isCandidate)
const byPlanMoveSet = measureExtraction(appRoot, isPlanned)

/** Modules `package.json#exports` already publishes, so cloud-app can import them today. */
function publishedModules(root: string) {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
    exports?: Record<string, string>
  }
  const all = prodSourcePaths(root).map((file) => path.relative(path.join(root, "src"), file).split(path.sep).join("/"))
  const published = new Set<string>()
  for (const target of Object.values(pkg.exports ?? {})) {
    const normalized = target.replace(/^\.\//, "")
    if (!normalized.includes("*")) {
      published.add(normalized.replace(/^src\//, ""))
      continue
    }
    const [before, after = ""] = normalized.split("*")
    for (const module of all) {
      if (`src/${module}`.startsWith(before!) && `src/${module}`.endsWith(after)) published.add(module)
    }
  }
  return published
}

function fixtureApp(files: Record<string, string>) {
  const root = mkdtempSync(path.join(tmpdir(), "claxedo-extraction-"))
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fixture", exports: {} }))
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(root, "src", rel)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, text)
  }
  return root
}

describe("the extraction analyzer", () => {
  // Positive controls. Every "the list is empty" and every recorded count below
  // is only meaningful if this walker can see an edge at all — a resolver that
  // silently returned null for everything would report a beautifully clean,
  // entirely fictional graph.

  test("finds an edge in each direction on a planted fixture", () => {
    const root = fixtureApp({
      "app/shell.ts": `import { openTask } from "../features/cloud/api"\nexport const shell = openTask\n`,
      "features/cloud/api.ts": `import { icon } from "../../ui/icon"\nexport const openTask = icon\n`,
      "ui/icon.ts": `export const icon = "icon"\n`,
    })
    try {
      const measured = measureExtraction(root, (module) => module.startsWith("features/cloud/"))

      expect(measured.modules).toEqual(["app/shell.ts", "features/cloud/api.ts", "ui/icon.ts"])
      expect(measured.leaving).toEqual(["features/cloud/api.ts"])
      expect(measured.inbound).toEqual([{ from: "app/shell.ts", to: "features/cloud/api.ts", typeOnly: false }])
      expect(measured.outbound).toEqual([{ from: "features/cloud/api.ts", to: "ui/icon.ts", typeOnly: false }])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("reports no edges for an already-separable fixture, and still sees the modules", () => {
    const root = fixtureApp({
      "app/shell.ts": `import { icon } from "../ui/icon"\nexport const shell = icon\n`,
      "features/cloud/api.ts": `export const openTask = "task"\n`,
      "ui/icon.ts": `export const icon = "icon"\n`,
    })
    try {
      const measured = measureExtraction(root, (module) => module.startsWith("features/cloud/"))

      expect(measured.inbound).toEqual([])
      expect(measured.outbound).toEqual([])
      // Paired proof the emptiness is a property of the graph, not of the scan.
      expect(measured.modules.length).toBe(3)
      expect(measured.leaving.length).toBe(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("counts a type-only cross-package import as an edge", () => {
    // The distinction that separates this file from the runtime boundary guards.
    // `import type` is free at runtime and NOT free across a package boundary:
    // the type still has to be exported.
    const root = fixtureApp({
      "app/shell.ts": `import type { Task } from "../features/cloud/api"\nexport type T = Task\n`,
      "features/cloud/api.ts": `export type Task = { id: string }\n`,
    })
    try {
      const measured = measureExtraction(root, (module) => module.startsWith("features/cloud/"))

      expect(measured.inbound).toEqual([{ from: "app/shell.ts", to: "features/cloud/api.ts", typeOnly: true }])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("ranks fan-in so the expensive edge is the one reported first", () => {
    const edges: Edge[] = [
      { from: "a.ts", to: "hot.ts", typeOnly: false },
      { from: "b.ts", to: "hot.ts", typeOnly: false },
      { from: "b.ts", to: "hot.ts", typeOnly: true },
      { from: "c.ts", to: "cold.ts", typeOnly: false },
    ]

    // `b.ts` imports `hot.ts` twice; fan-in counts MODULES, not import statements,
    // because two imports from one file is one file to fix.
    expect(heaviest(edges, 2)).toEqual({ "hot.ts": 2 })
    expect(Object.keys(heaviest(edges, 1))).toEqual(["hot.ts", "cold.ts"])
  })
})

describe("the candidate manifest", () => {
  test("still matches the inventory that seeded it", () => {
    const inventory = readFileSync(path.join(import.meta.dir, "hosted-operation-inventory.test.ts"), "utf8")
    const literal = inventory.match(/const HOSTED_CANDIDATE_ROOTS = \[([\s\S]*?)\]/)?.[1] ?? ""
    const roots = [...literal.matchAll(/"([^"]+)"/g)].map((match) => match[1])

    // Positive control: the parse must find the real list, not an empty one that
    // would make the comparison below vacuously pass.
    expect(roots.length).toBe(7)
    expect(roots).toEqual(HOSTED_CANDIDATE_ROOTS)
  })

  test("every candidate root still contains modules", () => {
    const empty = HOSTED_CANDIDATE_ROOTS.filter(
      (root) => byCandidateRoots.modules.filter((module) => candidateRootOf(module) === root).length === 0,
    )

    expect(empty).toEqual([])

    // Paired: the scan found the package, so the emptiness above is real.
    //
    // The candidate total is pinned exactly because it IS the measurement
    // subject — it must equal the per-root counts recorded below. The package
    // total is only a floor: pinning it would turn every unrelated file added
    // anywhere in `@claxedo/app` into a failure in a file about cloud
    // extraction, which teaches people to bump numbers without reading them.
    expect(byCandidateRoots.leaving.length).toBe(142)
    expect(byCandidateRoots.modules.length).toBeGreaterThan(800)
    expect(byCandidateRoots.leaving.length + byCandidateRoots.staying.length).toBe(byCandidateRoots.modules.length)
  })
})

describe("direction 1 — local code that imports hosted candidates", () => {
  /**
   * Per candidate root: how big it is, and how much of it local code reaches.
   *
   * `importedByLocal` is the number of modules inside the root that at least one
   * staying module imports — each one is a symbol that must survive the move as
   * a port, a deletion, or a package export. `localImporters` is the number of
   * distinct LOCAL files that must be edited, which is the closer proxy for
   * review size.
   *
   * DOWN is progress: an edge was cut or inverted. UP means new local code took
   * a dependency on hosted code after the split was planned — fix it at the one
   * import, before it becomes three.
   */
  const CROSS_EDGES_BY_ROOT = {
    "features/workgraph": { modules: 28, importedByLocal: 8, localImporters: 7 },
    "features/documents": { modules: 28, importedByLocal: 8, localImporters: 11 },
    // 14 -> 1. The root was inverted behind
    // `platform/runtime/workspace-startup-port.ts`: local callers name an
    // operation, `app/entry/main.tsx` binds `cloudWorkspaceStartup`, and it is
    // now the ONLY staying module that imports the root. It is itself on Unit
    // 10's move list, so by the plan's own manifest the edge is already zero
    // (see PLAN_MOVE_SET below). Twelve of the fourteen callers did not need a
    // port at all — they only read the runtime RECORD, which works in a local
    // build and moved to `platform/runtime/workspace-runtime-record.ts`.
    "platform/runtime/cloud": { modules: 1, importedByLocal: 1, localImporters: 1 },
    "features/workspaces": { modules: 24, importedByLocal: 21, localImporters: 32 },
    "features/settings": { modules: 16, importedByLocal: 13, localImporters: 12 },
    "features/onboarding": { modules: 32, importedByLocal: 2, localImporters: 7 },
    "app/routes": { modules: 13, importedByLocal: 9, localImporters: 4 },
  }

  test("records the per-root cross-edge cost", () => {
    const measured = Object.fromEntries(
      HOSTED_CANDIDATE_ROOTS.map((root) => {
        const inbound = byCandidateRoots.inbound.filter((edge) => candidateRootOf(edge.to) === root)
        return [
          root,
          {
            modules: byCandidateRoots.modules.filter((module) => candidateRootOf(module) === root).length,
            importedByLocal: new Set(inbound.map((edge) => edge.to)).size,
            localImporters: new Set(inbound.map((edge) => edge.from)).size,
          },
        ]
      }),
    )

    expect(measured).toEqual(CROSS_EDGES_BY_ROOT)
  })

  test("records the whole-package totals", () => {
    // 62 hosted modules reached from 52 local files. The module count is
    // unchanged by the cloud-runtime inversion — the store is still reached,
    // by one file — but the FILE count fell from 63, because thirteen of the
    // fourteen callers stopped importing hosted code entirely. That asymmetry
    // is the point of inverting rather than re-exporting: the review size is
    // the file count.
    expect(new Set(byCandidateRoots.inbound.map((edge) => edge.to)).size).toBe(62)
    expect(new Set(byCandidateRoots.inbound.map((edge) => edge.from)).size).toBe(52)
  })

  /**
   * The edges that actually cost something, by fan-in.
   *
   * Fan-in is the right ranking because a module with fourteen local importers
   * cannot be moved at all until it is inverted — there is no "just update the
   * import" for it — while a module with one importer is a one-line change.
   *
   * The top two are the whole story:
   *
   *  - `features/workspaces/ui/panel/workspace-panel-state.ts` (13) is read
   *    almost entirely by `app/workbench/rail/*` — the local rail. Its own
   *    inventory entry already says the panel stays local.
   *  - `features/workspaces/data/workspace-connection.ts` (9) is on the plan's
   *    move list and is imported by the local shell, the rail, and the session
   *    and terminal app-ports.
   *
   * `platform/runtime/cloud/workspace-runtime-store.ts` used to head this list
   * at 14 and is GONE from it — one importer now, so it does not clear the
   * threshold. See the test below, which still names its importers by hand.
   *
   * A count going UP here is the loudest signal in the file: it means the module
   * that was already hardest to move got harder.
   */
  const HEAVIEST_CROSS_EDGES = {
    "features/workspaces/ui/panel/workspace-panel-state.ts": 13,
    "features/workspaces/data/workspace-connection.ts": 9,
    "features/onboarding/index.ts": 6,
    "features/settings/ui/terminals.tsx": 5,
    "features/workgraph/api.ts": 4,
    "features/workspaces/data/use-workspace-query.ts": 4,
    "features/workspaces/lib/workspace-display.ts": 4,
    "features/documents/access.ts": 3,
    "features/documents/data/documents-api.ts": 3,
    "features/workspaces/actions/workspace-recovery.tsx": 3,
    "features/workspaces/data/query/project-ensure.ts": 3,
    "features/workspaces/data/workspace-scope.tsx": 3,
  }

  test("names every hosted module with three or more local importers", () => {
    expect(heaviest(byCandidateRoots.inbound, 3)).toEqual(HEAVIEST_CROSS_EDGES)
  })

  test("names the local importers of the once-most-expensive edge", () => {
    // This list used to hold fourteen files — bootstrap, the rail, terminals,
    // processes, review, the session composer and harness — which is why "move
    // the cloud runtime store to cloud-app" could not be done as a file move.
    //
    // It now holds one, and that one is the COMPOSITION ROOT: the hosted entry
    // binds `cloudWorkspaceStartup` into
    // `platform/runtime/workspace-startup.ts`, and every product caller reaches
    // the three hosted operations through `workspaceStartup()`. `main.tsx` is
    // itself on Unit 10's move list, so the edge leaves with the code.
    //
    // Kept as a named list rather than a count so a second importer has to be
    // written down here, next to the reason there is only supposed to be one.
    const importers = [
      ...new Set(
        byCandidateRoots.inbound
          .filter((edge) => edge.to === "platform/runtime/cloud/workspace-runtime-store.ts")
          .map((edge) => edge.from),
      ),
    ].toSorted()

    expect(importers).toEqual(["app/entry/main.tsx"])
    // Positive control: the walker still sees this module at all. An empty list
    // would otherwise be indistinguishable from a resolver that stopped
    // resolving `@/platform/runtime/cloud/...`.
    expect(byCandidateRoots.leaving).toContain("platform/runtime/cloud/workspace-runtime-store.ts")
    // And the binding really is the hosted entry's, not a leftover in the port
    // itself: the seam local callers import must reach no hosted module.
    expect(byCandidateRoots.inbound.filter((edge) => edge.from === "platform/runtime/workspace-startup.ts")).toEqual([])
  })
})

describe("direction 2 — the export surface cloud-app needs from app", () => {
  /**
   * Local modules that hosted candidates import.
   *
   * The plan says cloud-app "receives no private alias into app source", so on
   * the day of the move every one of these is either an entry in
   * `@claxedo/app`'s `exports` map or a broken import. Four are already
   * published; the rest are the work.
   *
   * UP is a real cost: each addition is a public contract an outside consumer
   * can pin, and `@claxedo/app` cannot refactor it afterwards without a
   * breaking change. DOWN means a hosted module stopped reaching into app
   * internals — the direction the plan wants.
   */
  const EXPORT_SURFACE = {
    modules: 83,
    valueImported: 52,
    alreadyPublished: 4,
    newExportsRequired: 79,
  }

  test("records the surface size and how little of it is published today", () => {
    const surface = [...new Set(byCandidateRoots.outbound.map((edge) => edge.to))]
    const published = publishedModules(appRoot)

    expect({
      modules: surface.length,
      valueImported: new Set(byCandidateRoots.outbound.filter((edge) => !edge.typeOnly).map((edge) => edge.to)).size,
      alreadyPublished: surface.filter((module) => published.has(module)).length,
      newExportsRequired: surface.filter((module) => !published.has(module)).length,
    }).toEqual(EXPORT_SURFACE)

    // Positive control: `publishedModules` must actually resolve the exports map.
    // An empty set would make `newExportsRequired` equal the whole surface and
    // look like a much worse (and wrong) result.
    expect(published.size).toBeGreaterThan(0)
    expect(published.has("app/entry/index.tsx")).toBe(true)
  })

  /**
   * The surface entries that carry the most hosted importers.
   *
   * These are the ones to design deliberately, because a bad shape here is
   * repeated across every consumer:
   *
   *  - `ui/controls/claxedo-icon.tsx` (23) and `claxedo-icon-button.tsx` (7) are
   *    plain shared UI. Cheap: one `./components` style export covers both.
   *  - `platform/api/api.ts` (17) is NOT cheap and is NOT on the plan's move
   *    list. It is the authenticated transport, and it imports `auth-client.ts`
   *    — which DOES move. See the auth-leak test below.
   *  - `platform/i18n/provider.tsx` (11) already has an `./i18n` export subpath
   *    pointed at `cloud-strings.ts`, not at the provider.
   */
  const SURFACE_HOT_SPOTS = {
    "ui/controls/claxedo-icon.tsx": 23,
    "platform/api/api.ts": 17,
    "platform/i18n/provider.tsx": 11,
    "platform/runtime/transport.ts": 8,
    "ui/controls/claxedo-icon-button.tsx": 7,
    "app/integrations/claxedo-events.tsx": 6,
    "platform/identity/route.ts": 6,
    "platform/query/query-client.ts": 6,
    "platform/runtime/platform-provider.tsx": 6,
    "app/workbench/actions/shared.ts": 5,
    "app/workbench/state/index.ts": 5,
    "platform/runtime/agent/workspace-control-routes.ts": 5,
  }

  test("names every local module five or more hosted candidates import", () => {
    expect(heaviest(byCandidateRoots.outbound, 5)).toEqual(SURFACE_HOT_SPOTS)
  })
})

describe("the plan's move list versus the candidate manifest", () => {
  /**
   * The candidate roots are a coarse manifest; Unit 10's `Files:` section is the
   * real one, and it is much narrower. Measuring both is how "extract cloud-app"
   * stops being a guess.
   *
   * 142 modules live under the candidate roots. Unit 10 names 87, of which 83
   * are inside those roots — so 59 candidate modules are NOT moving. That gap is
   * not slop, it is deliberate: `features/settings` keeps
   * general/keybinds/models/providers/terminals, `features/workspaces` keeps
   * scope/actions/recovery/panel, `features/onboarding` keeps the whole local
   * destination and AI-connect journey, and `app/routes` keeps every route
   * except `login`/`cli-login`.
   *
   * So a reader who sizes Unit 10 from `HOSTED_CANDIDATE_ROOTS` over-estimates
   * it by 71%, and — worse — would move files the plan wants kept.
   */
  const PLAN_MOVE_SET = {
    movedModules: 87,
    // 55 -> 41 and 42 -> 41 after the cloud runtime store was inverted. Under
    // the plan's own move list the store is now imported by ZERO staying
    // modules: its one remaining importer, `app/entry/main.tsx`, is itself on
    // the list. The thirteen other files that dropped out did so because the
    // record reader they actually wanted moved to `platform/runtime/`.
    stayingModulesThatImportThem: 41,
    movedModulesImportedByStaying: 41,
    exportSurface: 58,
  }

  test("records the real move set and its edges", () => {
    expect({
      movedModules: byPlanMoveSet.leaving.length,
      stayingModulesThatImportThem: new Set(byPlanMoveSet.inbound.map((edge) => edge.from)).size,
      movedModulesImportedByStaying: new Set(byPlanMoveSet.inbound.map((edge) => edge.to)).size,
      exportSurface: new Set(byPlanMoveSet.outbound.map((edge) => edge.to)).size,
    }).toEqual(PLAN_MOVE_SET)
  })

  test("the candidate roots over-scope the move by a measured margin", () => {
    // Named as a number so it cannot be waved away. If Unit 10's `Files:` list
    // grows to cover the rest, this shrinks — which is a plan change worth
    // noticing in a diff.
    const overScoped = byCandidateRoots.leaving.filter((module) => !isPlanned(module))

    expect(overScoped.length).toBe(59)
    expect(byCandidateRoots.leaving.length - byPlanMoveSet.leaving.filter(isCandidate).length).toBe(59)
  })

  test("records exactly which plan prefixes have gone stale", () => {
    // The move list is written as prefixes against a moving tree. A stale prefix
    // does not fail loudly — it contributes zero modules and makes the
    // extraction look cheaper than it is. This is the one that has already
    // rotted; a second appearing here means the plan drifted again.
    const unmatched = UNIT_10_MOVE_SET.filter((prefix) => !byPlanMoveSet.modules.some(prefixMatcher([prefix])))

    expect(unmatched).toEqual(Object.keys(STALE_PLAN_PREFIXES))
    // And the corrections must themselves resolve, or the measured move set is
    // wrong in the other direction.
    const unresolved = Object.values(STALE_PLAN_PREFIXES).filter(
      ({ actual }) => !byPlanMoveSet.modules.includes(actual),
    )
    expect(unresolved).toEqual([])
    // Paired positive control for both empty-ish assertions above: the move list
    // was transcribed and it does match real files.
    expect(UNIT_10_MOVE_SET.length).toBe(27)
    expect(byPlanMoveSet.leaving.length).toBeGreaterThan(UNIT_10_MOVE_SET.length)
  })

  test("every stale prefix carries a reason", () => {
    for (const [prefix, { reason }] of Object.entries(STALE_PLAN_PREFIXES)) {
      expect(reason.length, `${prefix} needs a reason`).toBeGreaterThan(40)
    }
  })

  /**
   * `@claxedo/app` modules that still import the browser identity producers
   * AFTER the plan's move list is applied.
   *
   * Unit 10's own security scenario reads: "a source-graph test rejects any
   * surviving app import of `auth-client.ts` or `auth-session.ts`". These nine
   * modules are exactly what stands between the plan and that assertion, and
   * none of them is on the move list. Two are structural rather than cosmetic:
   *
   *  - `platform/api/api.ts` is the authenticated transport that 17 hosted
   *    modules depend on. It imports `auth-client.ts` and stays. That is a
   *    cycle across the new package boundary, and Unit 9's account port is what
   *    is supposed to break it.
   *  - `platform/runtime/agent/agent-runtime-client.ts` does the same thing for
   *    the runtime client.
   *
   * Empty here would mean the move list is sufficient on its own. It is not, and
   * the counts below say by how much.
   */
  const SURVIVING_IDENTITY_IMPORTERS = {
    "platform/auth/auth-client.ts": [
      "app/entry/index.tsx",
      "features/workspaces/actions/project-actions.tsx",
      "platform/api/api.ts",
      "platform/runtime/agent/agent-runtime-client.ts",
    ],
    "platform/auth/auth-session.ts": [
      "app/entry/app.tsx",
      "app/entry/index.tsx",
      "app/workbench/rail/rail-account-menu.tsx",
      "platform/account/account-provider.tsx",
      "platform/auth/principal-provider.tsx",
    ],
  }

  test("records which app modules still import the moving identity producers", () => {
    const measured = Object.fromEntries(
      Object.keys(SURVIVING_IDENTITY_IMPORTERS).map((target) => [
        target,
        [...new Set(byPlanMoveSet.inbound.filter((edge) => edge.to === target).map((edge) => edge.from))].toSorted(),
      ]),
    )

    expect(measured).toEqual(SURVIVING_IDENTITY_IMPORTERS)
  })

  test("both identity producers are in fact on the move list", () => {
    // Positive control for the test above: if these stopped being classified as
    // leaving, `byPlanMoveSet.inbound` would hold no edges to them and the
    // recorded importer lists would collapse to empty while looking like
    // progress.
    expect(isPlanned("platform/auth/auth-client.ts")).toBe(true)
    expect(isPlanned("platform/auth/auth-session.ts")).toBe(true)
    expect(isPlanned("platform/account/browser-account-port.ts")).toBe(true)
    expect(isPlanned("platform/api/api.ts")).toBe(false)
  })
})
