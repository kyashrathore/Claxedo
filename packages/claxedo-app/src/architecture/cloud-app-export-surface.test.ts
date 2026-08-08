import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { allImportSpecifiers, importSpecifiers, resolveImport, stripComments } from "./import-graph"
import { prodSourcePaths } from "./scanners"

const appRoot = path.resolve(import.meta.dir, "../..")
const srcRoot = path.join(appRoot, "src")

/**
 * The design for the export surface `cloud-app-extraction-manifest.test.ts` measured.
 *
 * The manifest answers "how big is Unit 10's extraction". Its direction-2 answer
 * is a number: 58 `@claxedo/app` modules are imported by the modules Unit 10
 * moves, 4 of which `package.json#exports` already publishes, so 54 modules
 * would have to become public on the day of the move. The plan forbids the
 * escape hatch — "cloud-app receives no private alias into app source" — so
 * that number is not advisory.
 *
 * A number is not a design. 54 new entries in an `exports` map is 54 permanent
 * public contracts, and the cheapest way to produce that is to add 54 entries
 * and never look at them again. This file exists so that cannot happen: every
 * one of the 54 is classified, by hand, into exactly one of three dispositions.
 *
 *  (a) BELONGS IN AN EXISTING EXPORT PATH. The module is the same kind of thing
 *      an existing subpath already publishes — usually shared, dependency-neutral
 *      UI. Some are already reachable and only the import specifier is wrong.
 *      Cost: zero or one line in an existing barrel.
 *
 *  (b) NEEDS A NEW NAMED SUBPATH. The module is a designed contract that two
 *      packages legitimately share: a feature port, the identity route grammar,
 *      the one query client, the runtime startup seam. Cost: a real public
 *      contract, deliberately taken.
 *
 *  (c) SHOULD NOT BE EXPORTED AT ALL. The importing hosted module is reaching
 *      into an app internal, and the remedy is on the IMPORTER's side: re-point
 *      it at a port, invert the dependency, or let the module follow the move.
 *      Cost: work now, instead of a contract forever.
 *
 * Group (c) is the whole point of the file. Every entry in it carries a reason
 * and a named alternative, and the alternative is checked mechanically against
 * the module graph — because an entry in (c) with a vague alternative is an
 * entry that will quietly be re-classified into (a) by whoever does the move at
 * 6pm on the day of the cut.
 *
 * This file moves nothing and exports nothing. It is a review artifact with an
 * executable spine.
 *
 * WHAT MOVEMENT MEANS, per group:
 *
 *  - (a) UP: someone found more shared UI to publish. Cheap, but check it really
 *    is dependency-neutral and not a component dragging half the workbench.
 *  - (a) DOWN: usually good — an importer stopped needing shared UI.
 *  - (b) UP: `@claxedo/app` just took on another permanent contract. This is the
 *    number to defend in review; each entry is something an outside consumer can
 *    pin and the package can no longer refactor freely.
 *  - (b) DOWN: a contract was retired or absorbed. Good.
 *  - (c) UP: MORE work was correctly refused. Good — as long as each new entry
 *    has a real alternative.
 *  - (c) DOWN without the total falling: an entry was reclassified into (a)/(b),
 *    i.e. the export was granted after all. That is the regression this file
 *    exists to make visible in a diff.
 */

/* -------------------------------------------------------------------------- */
/* The move set, read from the manifest rather than re-transcribed             */
/* -------------------------------------------------------------------------- */

/**
 * The plan's Unit 10 move list, parsed out of the manifest's source.
 *
 * Parsed rather than copied because a third transcription of the same list is a
 * third thing to keep in sync, and the manifest already owns the correction for
 * the one prefix the plan wrote against a filename that no longer exists
 * (`browser-account-adapter.ts` -> `browser-account-port.ts`). The manifest
 * itself parses `HOSTED_CANDIDATE_ROOTS` out of `hosted-operation-inventory.test.ts`
 * for the same reason; this is that pattern one level further down.
 *
 * `stripComments` first, because the manifest's move list sits between two long
 * doc comments that mention module paths in prose. Matching prose instead of the
 * literal is exactly the failure mode that made six guards in one session pass
 * against their own documentation.
 */
const manifestSource = stripComments(
  readFileSync(path.join(import.meta.dir, "cloud-app-extraction-manifest.test.ts"), "utf8"),
)

const PLAN_PREFIXES = [
  ...(manifestSource.match(/const UNIT_10_MOVE_SET = \[([\s\S]*?)\n\]/)?.[1] ?? "").matchAll(/"([^"]+)"/g),
].map((match) => match[1]!)

const PLAN_PREFIX_CORRECTIONS = new Map(
  [
    ...(manifestSource.match(/const STALE_PLAN_PREFIXES[\s\S]*?\n\}\n/)?.[0] ?? "").matchAll(
      /"([^"]+)":\s*\{\s*actual:\s*"([^"]+)"/g,
    ),
  ].map((match) => [match[1]!, match[2]!] as const),
)

const MEASURED_MOVE_SET = PLAN_PREFIXES.map((prefix) => PLAN_PREFIX_CORRECTIONS.get(prefix) ?? prefix)

const isLeaving = (module: string) =>
  MEASURED_MOVE_SET.some((prefix) =>
    prefix.endsWith("/") ? module.startsWith(prefix) : module === prefix || module.startsWith(prefix),
  )

/* -------------------------------------------------------------------------- */
/* The measured surface                                                        */
/* -------------------------------------------------------------------------- */

type Edge = { from: string; to: string; typeOnly: boolean }

/**
 * Only the projection this file needs: leaving -> staying edges.
 *
 * The walkers are `prodSourcePaths` (scanners) and
 * `allImportSpecifiers`/`importSpecifiers`/`resolveImport` (import-graph) — the
 * same ones the manifest uses, so a resolver change moves both files together.
 * The manifest's own `measureExtraction` is not importable: it lives in a
 * `.test.ts` module, and importing that would re-register its 20 tests here.
 */
const modules = prodSourcePaths(appRoot)
  .map((file) => path.relative(srcRoot, file).split(path.sep).join("/"))
  .toSorted()

const outbound: Edge[] = []
for (const module of modules) {
  if (!isLeaving(module)) continue
  const file = path.join(srcRoot, module)
  const text = readFileSync(file, "utf8")
  const valueSpecifiers = new Set(importSpecifiers(text))
  for (const specifier of allImportSpecifiers(text)) {
    const resolved = resolveImport(appRoot, file, specifier)
    if (!resolved) continue
    const to = path.relative(srcRoot, resolved).split(path.sep).join("/")
    if (to === module || isLeaving(to)) continue
    outbound.push({ from: module, to, typeOnly: !valueSpecifiers.has(specifier) })
  }
}

const packageJson = JSON.parse(readFileSync(path.join(appRoot, "package.json"), "utf8")) as {
  exports?: Record<string, string>
}

/** Subpath keys `package.json#exports` publishes today. */
const publishedPaths = new Set(Object.keys(packageJson.exports ?? {}))

/** Modules already reachable through those keys. Duplicated from the manifest for the same reason. */
const publishedModules = (() => {
  const published = new Set<string>()
  for (const target of Object.values(packageJson.exports ?? {})) {
    const normalized = target.replace(/^\.\//, "")
    if (!normalized.includes("*")) {
      published.add(normalized.replace(/^src\//, ""))
      continue
    }
    const [before, after = ""] = normalized.split("*")
    for (const module of modules) {
      if (`src/${module}`.startsWith(before!) && `src/${module}`.endsWith(after)) published.add(module)
    }
  }
  return published
})()

const surface = [...new Set(outbound.map((edge) => edge.to))].toSorted()
const required = surface.filter((module) => !publishedModules.has(module))

/* -------------------------------------------------------------------------- */
/* The classification                                                          */
/* -------------------------------------------------------------------------- */

type Disposition =
  | { group: "a"; path: string; note: string }
  | { group: "b"; path: string; note: string }
  | {
      group: "c"
      reason: string
      alternative: string
      /**
       * Modules the alternative actually names. Each must be a real production
       * module that is either classified here (so it becomes public) or on the
       * move list (so it lands in cloud-app). Prose alone is not an alternative.
       */
      alternativeModules: string[]
    }

/**
 * Every module `@claxedo/app` would have to publish for Unit 10's move list,
 * minus the four already published, with its disposition.
 *
 * Read this as the review, not as data: the (c) entries are decisions to refuse
 * an export, and each one is a small piece of work someone has to do before the
 * cut.
 */
const REQUIRED_EXPORTS: Record<string, Disposition> = {
  /* ---------------------------------------------------------------- group a */

  // The manifest names the two icon modules as the cheap half of the surface
  // (30 hosted importers between them across the coarse candidate roots, 17
  // under the plan's narrower move list). They are dependency-neutral controls
  // with no product coupling, which is precisely what `./components` is for.
  //
  // Note what `./components` publishes TODAY: `app/controls/index.ts` re-exports
  // five modules and ALL FIVE are on Unit 10's move list. The path survives the
  // move as an empty barrel. So this is not "add icons to the component
  // barrel", it is "the component barrel stops being the hosted-feature barrel
  // and becomes what its name always claimed". See the dedicated test below.
  "ui/controls/claxedo-icon.tsx": {
    group: "a",
    path: "./components",
    note: "Dependency-neutral brand icon. Highest fan-in on the whole surface and the cheapest entry on it.",
  },
  "ui/controls/claxedo-icon-button.tsx": {
    group: "a",
    path: "./components",
    note: "Same control family as claxedo-icon; splitting them across two paths would be arbitrary.",
  },
  "ui/semantic-icon.tsx": {
    group: "a",
    path: "./components",
    note: "Shared icon-name mapping used by Documents and WorkGraph chrome. No product state.",
  },
  "ui/context-card/context-card.tsx": {
    group: "a",
    path: "./components",
    note: "Presentational card shell used by the WorkGraph waiting card.",
  },
  "ui/rich-text/index.ts": {
    group: "a",
    path: "./components",
    note: "The shared Tiptap surface. Already the canonical editor for both products; the Documents editor is separate and moves.",
  },
  "ui/harness-display.ts": {
    group: "a",
    path: "./components",
    note: "A constant display-name map with zero imports. Belongs with the shared UI it labels.",
  },

  // These two are already reachable. The import specifier is simply wrong, and
  // the fix is on the hosted entry's side with no export change at all.
  "app/entry/app.tsx": {
    group: "a",
    path: ".",
    note: "`AppBaseProviders`/`AppInterface` are already re-exported by `app/entry/index.tsx`. `main.tsx` imports the module directly via `@/`; it should import the package root, which it already does for `PlatformProvider`.",
  },
  "app/providers/config.tsx": {
    group: "a",
    path: "./context",
    note: "`ConfigProvider` is already exported by `app/providers/index.ts` behind `./context`. Zero new surface; retarget the specifier.",
  },

  "platform/i18n/provider.tsx": {
    group: "a",
    path: "./i18n",
    note: "`./i18n` exists but points at `cloud-strings.ts` alone. The provider is the other half of the same contract — widen that path to a barrel rather than minting `./i18n/provider`.",
  },

  /* ---------------------------------------------------------------- group b */

  // The Unit 2 feature ports. These are the one shape on this list that is
  // unambiguously designed to be crossed: a feature declares what it needs from
  // the app shell, and the shell binds it. Publishing them is publishing the
  // seam the split is built on.
  //
  // Caveat recorded rather than hidden: these port modules derive their member
  // types with `typeof` over `@/`-aliased app internals, and
  // `features/onboarding/app-ports.ts` derives two of its five members from
  // `features/settings/ui/sandbox-section-logic.ts` and `sandbox-driver-logo.tsx`,
  // both of which MOVE. Exporting the port as-is therefore also exports its
  // derivation graph to the consumer's typechecker, and in the onboarding case
  // points it at cloud-app. The port members must be declared structurally
  // before these paths are published. That is the same remedy the type-only
  // entries in group (c) carry, applied to a module that still deserves to be
  // public.
  "features/onboarding/app-ports.ts": {
    group: "b",
    path: "./ports/onboarding",
    note: "The public onboarding port the plan names for the `local`/`shared` scope split. Its `typeof` derivation from two moving settings modules must be inverted first.",
  },
  "features/settings/app-ports.ts": {
    group: "b",
    path: "./ports/settings",
    note: "Settings keeps general/keybinds/models/providers/terminals; the moved connections and sandbox sections reach the shell through this port.",
  },
  "features/workspaces/app-ports.ts": {
    group: "b",
    path: "./ports/workspaces",
    note: "Workspaces keeps scope/actions/recovery/panel; the moved cloud dialogs and workspace-connection reach the shell through this port.",
  },

  // The identity route grammar. Both packages construct and parse the same URLs
  // and the plan requires hosted browser URLs to keep working, so this is a
  // shared contract in the strictest sense: divergence is a broken bookmark.
  "platform/identity/route.ts": {
    group: "b",
    path: "./identity",
    note: "Route construction/parsing. Preserving hosted URLs across the split means exactly one implementation of this grammar.",
  },
  "platform/identity/session-ref.ts": {
    group: "b",
    path: "./identity",
    note: "Session reference branding used by the moved Documents page content. Same contract family as route.ts.",
  },
  "platform/identity/legacy-resolver.ts": {
    group: "b",
    path: "./identity",
    note: "Legacy workspace-ref resolution used by share-workspace. Persisted-shape compatibility, so it cannot be forked.",
  },

  "platform/query/query-client.ts": {
    group: "b",
    path: "./query",
    note: "There must be exactly one TanStack client instance across both packages, or cache writes from cloud-app land in a second store the shell never reads.",
  },

  "platform/persistence/persist.ts": {
    group: "b",
    path: "./persistence",
    note: "`.` already leaks `Persist`/`persisted` from the entry barrel. Give persistence its own path and let the entry barrel drop them, rather than widening `.` further.",
  },
  "platform/persistence/keys.ts": {
    group: "b",
    path: "./persistence",
    note: "Storage key names are a persisted contract. Two packages writing local storage need one key list or they silently diverge per browser profile.",
  },

  // The workspace runtime seam. The manifest already records the win here: the
  // cloud runtime store went from 14 local importers to 1 by inverting behind
  // `workspace-startup-port.ts`. Publishing the port and its data types is what
  // makes that inversion survive the package boundary.
  "platform/runtime/workspace-startup-port.ts": {
    group: "b",
    path: "./runtime",
    note: "THE inversion seam. cloud-app implements it; app calls it. Nothing else on this list is more clearly a public contract.",
  },
  "platform/runtime/workspace-startup.ts": {
    group: "b",
    path: "./runtime",
    note: "The binder the hosted entry calls to register `cloudWorkspaceStartup`. Without it the port cannot be filled from outside the package.",
  },
  "platform/runtime/workspace-runtime-record.ts": {
    group: "b",
    path: "./runtime",
    note: "The runtime record readers thirteen local callers moved to. Cloud-app writes the record app reads.",
  },
  "platform/runtime/workspace-log.ts": {
    group: "b",
    path: "./runtime",
    note: "`WorkspaceRuntimeLog` is produced by the cloud runtime and rendered by the local shell. Shared data shape by construction.",
  },
  "platform/runtime/placement.ts": {
    group: "b",
    path: "./runtime",
    note: "`Placement` is the routing identity every runtime call is keyed on.",
  },
  "platform/runtime/connection-placement.ts": {
    group: "b",
    path: "./runtime",
    note: "Placement derivation for a hosted connection descriptor, consumed by the moved workspace-connection.",
  },
  "platform/runtime/http-backend.ts": {
    group: "b",
    path: "./runtime",
    note: "Backend selection for a resolved placement, used by the moved cloud runtime store.",
  },
  "platform/runtime/agent/workspace-relay-connection.ts": {
    group: "b",
    path: "./runtime",
    note: "The plan requires the moved signed user-hosted sequence to keep constructing Relay URLs here. Naming it in the plan and not exporting it is a contradiction; export it.",
  },
  "platform/runtime/agent/workspace-control-routes.ts": {
    group: "b",
    path: "./runtime",
    note: "Runtime control route builders used by the moved sandbox section and cloud project dialog.",
  },

  // The tokenless account/identity contract. Unit 9 built this specifically so a
  // renderer outside app can hold an account without holding a token, which is
  // the same reason the plan keeps `identity-provider.tsx` and `auth-display.ts`
  // in app while the Clerk producer moves.
  "platform/account/account-port.ts": {
    group: "b",
    path: "./account",
    note: "The tokenless `AccountPort` cloud-app's browser adapter implements. Publishing it is the point of Unit 9.",
  },
  "platform/account/account-provider.tsx": {
    group: "b",
    path: "./account",
    note: "`useAccountPort` is the read side of the same contract; the moved account settings section renders from it.",
  },
  "platform/auth/identity-provider.tsx": {
    group: "b",
    path: "./account",
    note: "`Principal` and `principalHasSignedAccess` are the sanitized identity the plan keeps in app. Documents' access check needs them and must not fork them.",
  },
  "platform/auth/auth-display.ts": {
    group: "b",
    path: "./account",
    note: "The plan keeps auth-display in app while `browser-account-port.ts` moves, so the moved adapter needs it published. Display-only, no credential.",
  },

  "platform/telemetry/analytics.ts": {
    group: "b",
    path: "./telemetry",
    note: "`initClaxedo` does not initialize PostHog; each entry does it. Both entries need the same deployment-mode and identity vocabulary, so it is a shared contract, not entry-private code.",
  },

  /* ---------------------------------------------------------------- group c */

  // c1-c3: the authenticated transports. This is the structural half of the
  // group. `platform/api/api.ts` has 54 staying importers and 13 moving ones,
  // so it cannot move.
  //
  // The CYCLE it used to carry is gone: it imported
  // `platform/auth/auth-client.ts`, which moves, and the test below now asserts
  // that it imports nothing on the move list at all. The transport takes a
  // bearer through `configureApiRuntime({ bearerToken })`, bound by
  // `app/entry/main.tsx` and the desktop renderer.
  //
  // The refusal STANDS, and cutting the cycle is what makes it honest rather
  // than what makes it unnecessary. Exporting api.ts would publish app's whole
  // fetch policy — base-URL resolution, the throttle, the 401/403 retry ladder,
  // the desktop basic-auth fallback — as a contract cloud-app pins, and hand
  // cloud-app a transport it would then feed its own credential into from
  // outside the package. That is the confused-deputy shape
  // `platform/account/account-port.ts` exists to prevent.
  "platform/api/api.ts": {
    group: "c",
    reason:
      "App's private fetch policy, not a contract. api.ts stays (54 app importers) and is the single largest entry on the surface, so a wrong shape here is repeated 13 times. It no longer imports `auth-client.ts` — the boundary cycle is cut — but publishing it would still export base-URL resolution, the throttle and the auth-retry ladder as a pinnable contract, and let cloud-app inject its credential into an app-owned transport instead of naming an operation.",
    alternative:
      "cloud-app owns its Hosted Server client, built on the tokenless `AccountPort` and the declarative operation set the unit already requires (`required-hosted-operations.ts`). app keeps api.ts private; it names a bearer source rather than importing one, which is what already broke the cycle.",
    alternativeModules: ["platform/account/account-port.ts"],
  },
  "platform/runtime/transport.ts": {
    group: "c",
    reason:
      "Same cycle, one level up: transport.ts imports `authFetch` from api.ts. All four moving importers take `centralTransportForServer` — a transport to the HOSTED server — which is cloud-app's own concern after the split, not an app internal it should be allowed to borrow.",
    alternative:
      "The hosted-server transport becomes a cloud-app operation client over the account port. `workgraph/api.ts` additionally takes `unsignedLocalFetch`; that branch is app's local path and should be reached through the runtime seam rather than the transport module.",
    alternativeModules: ["platform/account/account-port.ts", "platform/runtime/workspace-startup-port.ts"],
  },
  "platform/api/credential-request.ts": {
    group: "c",
    reason:
      "A thin authenticated wrapper over api.ts, imported only by the moving `cloud-credentials-api.ts`. Exporting it exports api.ts's auth coupling under a second name.",
    alternative:
      "Credential requests are hosted operations; they belong in cloud-app's declared operation set over the account port, like every other authenticated call the unit inventories.",
    alternativeModules: ["platform/account/account-port.ts"],
  },

  // c4-c13: the `typeof`-derived port cluster. Every one of these edges is TYPE
  // ONLY, and every one exists because a feature port writes
  // `typeof SomeAppInternal.member` instead of declaring the member's shape.
  // That idiom is free inside one package and expensive across two: it drags a
  // private module into the public surface purely to name a type. The remedy is
  // identical for all of them and touches only cloud-app's own port files.
  "app/integrations/claxedo-events.tsx": {
    group: "c",
    reason:
      "Type-only, four importers. Three are `app-ports.ts` files deriving `typeof useClaxedoEventsOptional`; the fourth pair are workspaces modules that already have a port. The events provider is app shell internals — publishing it would let cloud-app subscribe to the shell's event bus directly, which is the coupling the ports exist to prevent.",
    alternative:
      "Documents' and WorkGraph's port files declare the hook's signature structurally (app's binder satisfies it by assignment, so it is still typechecked at the binding site). The two direct workspaces importers go through `features/workspaces/app-ports.ts`, which already carries the events port.",
    alternativeModules: ["features/documents/app-ports.ts", "features/workspaces/app-ports.ts"],
  },
  "app/workbench/state/index.ts": {
    group: "c",
    reason:
      "Type-only, three importers, 35 staying ones. This is the workbench state root — the single most internal module on the list. Publishing it would make the shell's state shape a versioned contract and freeze the app-shell rewrite.",
    alternative:
      "`features/documents/app-ports.ts` declares `useClaxedoState` structurally; the two Documents content components take the type from their own feature port instead of reaching past it.",
    alternativeModules: ["features/documents/app-ports.ts"],
  },
  "app/workbench/workbench/index.ts": {
    group: "c",
    reason:
      "Type-only, and its two importers are the same two Documents content components that bypass their port for workbench state. Same internal, same bypass.",
    alternative:
      "Add the tab/workbench types the two components need to `features/documents/app-ports.ts` and consume them from there.",
    alternativeModules: ["features/documents/app-ports.ts"],
  },
  "app/workbench/actions/shared.ts": {
    group: "c",
    reason:
      "Type-only, one importer (`features/documents/actions/page-actions.ts`). Layout action helpers are shell internals; `features/workspaces/app-ports.ts` already models them as a port for exactly this reason.",
    alternative: "Declare the action members on `features/documents/app-ports.ts`, mirroring the workspaces port.",
    alternativeModules: ["features/documents/app-ports.ts"],
  },
  "app/workbench/lib/open-markdown-page-tab.ts": {
    group: "c",
    reason:
      "Type-only, one importer, and that importer is the Documents port itself deriving `typeof markdownPathFromHref`. The module opens a tab in the shell's workbench — publishing tab-opening would let cloud-app drive the shell's layout directly instead of asking for it.",
    alternative:
      "Declare `markdownPathFromHref` structurally on `features/documents/app-ports.ts`. The shell's binder still typechecks against the real function at the binding site, so nothing is weakened.",
    alternativeModules: ["features/documents/app-ports.ts"],
  },
  "app/workbench/state/surface-route.ts": {
    group: "c",
    reason:
      "Type-only, one importer, and that importer is the Documents port deriving `typeof surfaceRoute`. It maps workbench surfaces to shell routes — internal routing policy that the app-shell rewrite is expected to change.",
    alternative:
      "Declare `surfaceRoute` structurally on `features/documents/app-ports.ts`, so the mapping stays private and only its signature crosses.",
    alternativeModules: ["features/documents/app-ports.ts"],
  },
  "app/integrations/sync/query-options.ts": {
    group: "c",
    reason:
      "Type-only, one moving importer: the Documents port deriving `typeof useShellQueryOptions`. The staying Settings port derives the same member, so the module is squarely shell-internal cache policy — publishing it makes those defaults a contract two packages pin instead of a tuning knob.",
    alternative:
      "Declare `useShellQueryOptions` structurally on `features/documents/app-ports.ts`, matching how the Settings port will have to declare it once the same idiom is cleaned up.",
    alternativeModules: ["features/documents/app-ports.ts"],
  },
  "features/session/providers/session-sync.tsx": {
    group: "c",
    reason:
      "Type-only, imported only to type `useSessionSyncOptional` on the Documents port. The session sync provider is app-owned session internals with no reason to be public.",
    alternative: "Declare `useSessionSyncOptional` structurally on `features/documents/app-ports.ts`.",
    alternativeModules: ["features/documents/app-ports.ts"],
  },
  "features/session/ui/components/session-pane-scope.tsx": {
    group: "c",
    reason:
      "Type-only, one importer, and that importer is the Documents port deriving `typeof SessionPaneScope`. The component itself imports the authenticated api transport, so publishing it would pull a refused module (api.ts) into the surface through a side door.",
    alternative:
      "Declare `SessionPaneScope` structurally on `features/documents/app-ports.ts`; the shell binds the real component, keeping its transport dependency private.",
    alternativeModules: ["features/documents/app-ports.ts"],
  },
  "features/workspaces/data/query/project-ensure.ts": {
    group: "c",
    reason:
      "Type-only, imported only to type `ensureLocalProject` on the Documents port. The plan keeps local project ensure in app; publishing it invites cloud-app to call it directly.",
    alternative: "Declare `ensureLocalProject` structurally on `features/documents/app-ports.ts`.",
    alternativeModules: ["features/documents/app-ports.ts"],
  },

  // c14: a cloud data shape stranded in a local view.
  "features/session/ui/components/cloud-startup-view.tsx": {
    group: "c",
    reason:
      "Type-only: the moved `workspace-connection.ts` imports `CloudLog` from a session VIEW component. The type describes cloud runtime output; the view is only where it happens to be declared. Exporting a Solid component to obtain a data type is the wrong contract.",
    alternative:
      "Move `CloudLog` next to the other runtime log types in `platform/runtime/workspace-log.ts` (already group b) and have both the local view and cloud-app import it from there.",
    alternativeModules: ["platform/runtime/workspace-log.ts"],
  },

  // c15-c19: the onboarding and settings journeys the plan explicitly keeps
  // local. Each of these is a moving module reaching sideways into a staying
  // sibling inside the same feature directory — an import that looks free today
  // because it is intra-feature, and becomes a public contract the moment the
  // feature is split down the middle.
  "features/onboarding/ai-connect-api.ts": {
    group: "c",
    reason:
      "The plan keeps the local AI-connect journey in app and moves only the shared-account credential producer. Exporting the local API module would leave cloud-app calling app's local credential path directly — the shared-credential fallback the unit forbids.",
    alternative:
      "The plan's own instruction: make the `scope: \"local\" | \"shared\"` split explicit at `features/onboarding/app-ports.ts` and register the moved producer through it.",
    alternativeModules: ["features/onboarding/app-ports.ts"],
  },
  "features/onboarding/ai-connect-surface.tsx": {
    group: "c",
    reason:
      "A local onboarding surface component imported by two moving hosted surfaces. Publishing a journey step turns onboarding's internal composition into a contract cloud-app can pin.",
    alternative:
      "The hosted surfaces receive the shared step through `features/onboarding/app-ports.ts`, the same way they already receive `ProviderList` and `ProviderConnectForm`.",
    alternativeModules: ["features/onboarding/app-ports.ts"],
  },
  "features/onboarding/state.ts": {
    group: "c",
    reason:
      "Onboarding journey state stays local by the plan. Two moving modules read it directly; exporting it makes the local journey's state machine public and unrefactorable.",
    alternative: "Expose only the scope-aware slice the hosted producer needs on `features/onboarding/app-ports.ts`.",
    alternativeModules: ["features/onboarding/app-ports.ts"],
  },
  "features/onboarding/remote-access-api.ts": {
    group: "c",
    reason:
      "The plan keeps the dependency-light machine Remote Access controller/state/surface in app and moves only `remote-access-marker.tsx`. Exporting the API module re-creates the authenticated browser call in app that the same paragraph forbids.",
    alternative:
      "The marker's authenticated calls become declared hosted operations in cloud-app; anything the local controller still needs to share crosses `features/onboarding/app-ports.ts`.",
    alternativeModules: ["features/onboarding/app-ports.ts", "platform/account/account-port.ts"],
  },
  "features/onboarding/remote-access-state.ts": {
    group: "c",
    reason:
      "Same split as remote-access-api. The plan keeps the machine Remote Access controller, state and surface in app precisely because they are dependency-light and desktop-usable; exporting the state module would make the local enrollment machine's internal shape a hosted contract and block the Unit 11 desktop rewiring it exists for.",
    alternative:
      "Publish only the reads the moved marker needs as members on `features/onboarding/app-ports.ts`, leaving the state machine itself private to app.",
    alternativeModules: ["features/onboarding/app-ports.ts"],
  },
  "features/settings/ui/network-policy.tsx": {
    group: "c",
    reason:
      "The plan keeps network settings in app; the moving sandbox section renders `NetworkPolicySettings` inline. Exporting a settings pane so another package can nest it makes settings composition a public contract.",
    alternative:
      "The sandbox section receives the pane as a port member on `features/settings/app-ports.ts`, exactly as it already receives its other shell dependencies.",
    alternativeModules: ["features/settings/app-ports.ts"],
  },

  // c20-c21: modules that are mis-filed rather than internal. Both are hosted
  // code sitting in app directories, and both should follow the move.
  "app/demo/browser.ts": {
    group: "c",
    reason:
      "Hosted-only demo bootstrap, imported solely by the hosted entry, built solely by `build:demo` on the cloud config. The plan already moves `public/demo/` to cloud-app; leaving the bootstrap behind splits one feature across two packages.",
    alternative: "Follow `app/entry/main.tsx` into cloud-app with the rest of the demo target.",
    alternativeModules: ["app/entry/main.tsx"],
  },
  "app/integrations/doc-workgraph.ts": {
    group: "c",
    reason:
      "Type-only here, but the module bridges Documents and WorkGraph — BOTH of which move — and imports `authFetch`. It is cloud-app code that happens to live under `app/integrations/`.",
    alternative:
      "Follow Documents and WorkGraph into cloud-app; the Documents port keeps `turnDocumentIntoWork` as a structurally declared member so app never needs the module at all.",
    alternativeModules: ["features/workgraph/api.ts", "features/documents/app-ports.ts"],
  },
}

const groupOf = (group: Disposition["group"]) =>
  Object.entries(REQUIRED_EXPORTS)
    .filter(([, disposition]) => disposition.group === group)
    .map(([module]) => module)
    .toSorted()

const groupA = groupOf("a")
const groupB = groupOf("b")
const groupC = groupOf("c")

/* -------------------------------------------------------------------------- */

describe("the measured surface this design covers", () => {
  test("reads Unit 10's move list from the manifest without re-transcribing it", () => {
    // Positive controls first: a parse that silently returned nothing would make
    // `isLeaving` false for everything, the outbound set empty, and every
    // classification test below vacuous.
    expect(PLAN_PREFIXES.length).toBe(27)
    expect(PLAN_PREFIX_CORRECTIONS.size).toBe(1)
    expect(PLAN_PREFIX_CORRECTIONS.get("platform/account/browser-account-adapter.ts")).toBe(
      "platform/account/browser-account-port.ts",
    )
    expect(MEASURED_MOVE_SET).toContain("platform/account/browser-account-port.ts")

    // And the parsed list selects the manifest's measured move set, not some
    // other 87 files.
    expect(modules.filter(isLeaving).length).toBe(87)
  })

  test("records the surface and how little of it is published today", () => {
    // Must equal the manifest's own direction-2 measurement for the plan move
    // set (58) and its already-published count (4). If these diverge, one of the
    // two files is measuring a different graph and the classification below is
    // being applied to the wrong list.
    expect(surface.length).toBe(58)
    expect(surface.filter((module) => publishedModules.has(module)).length).toBe(4)
    expect(required.length).toBe(54)

    // Positive control: the exports map really resolved. An empty
    // `publishedModules` would inflate `required` to 58 and look like a worse,
    // wrong answer.
    expect(publishedModules.size).toBeGreaterThan(0)
    expect(publishedModules.has("app/entry/index.tsx")).toBe(true)
  })

  test("classifies the measured surface exactly — no gaps, no ghosts", () => {
    const classified = Object.keys(REQUIRED_EXPORTS).toSorted()

    const unclassified = required.filter((module) => !(module in REQUIRED_EXPORTS))
    const stale = classified.filter((module) => !required.includes(module))

    // A module that appears here is a new export requirement nobody reviewed.
    expect(unclassified).toEqual([])
    // A module that appears here stopped being required — good news, but the
    // entry must be deleted so the counts stay honest.
    expect(stale).toEqual([])
    // Paired proof both lists were computed against a populated scan.
    expect(classified.length).toBe(54)
    expect(required.length).toBe(54)
  })
})

describe("the three groups", () => {
  /**
   * The design in one line each.
   *
   *  a = 9  : shared UI plus three specifiers that already resolve. Nearly free.
   *  b = 23 : real new contracts, across 9 new subpaths. This is the number to
   *           argue about in review — every entry is something `@claxedo/app`
   *           can no longer change freely.
   *  c = 22 : exports refused. Each one is work moved onto the importer, and
   *           each one has a named alternative below.
   *
   * MOVEMENT:
   *  - b UP is the expensive direction. A module arriving in b that was in c
   *    means an alternative was abandoned; the reason and alternative text
   *    disappearing from the diff is the tell.
   *  - c UP with the total flat is good: something was reclassified as refusable.
   *  - Total UP means a hosted module took a new dependency on app internals
   *    after the design was reviewed. Fix it at the one import.
   */
  const GROUP_SIZES = { a: 9, b: 23, c: 22 }

  test("records the group sizes", () => {
    expect({ a: groupA.length, b: groupB.length, c: groupC.length }).toEqual(GROUP_SIZES)
    expect(groupA.length + groupB.length + groupC.length).toBe(required.length)
  })

  test("group (a) names export paths package.json already publishes", () => {
    const missing = groupA.filter((module) => {
      const disposition = REQUIRED_EXPORTS[module]!
      return disposition.group === "a" && !publishedPaths.has(disposition.path)
    })

    expect(missing).toEqual([])
    // Paired: the exports map was read and group (a) is non-empty, so the
    // emptiness above is a property of the design, not of an unread file.
    expect(publishedPaths.size).toBeGreaterThanOrEqual(12)
    expect(groupA.length).toBe(9)
  })

  test("group (b) names subpaths that do not exist yet, and only 9 of them", () => {
    const paths = groupB.map((module) => {
      const disposition = REQUIRED_EXPORTS[module]!
      return disposition.group === "b" ? disposition.path : ""
    })
    const collisions = [...new Set(paths)].filter((subpath) => publishedPaths.has(subpath)).toSorted()

    // A collision means the entry belongs in group (a): the path already exists,
    // so it is a barrel widening, not a new contract.
    expect(collisions).toEqual([])

    // Positive control for that emptiness, using the SAME predicate on a set
    // known to collide: every group (a) path must be published already. If the
    // predicate were broken, this would be empty too.
    const groupAPaths = [
      ...new Set(
        groupA.map((module) => {
          const disposition = REQUIRED_EXPORTS[module]!
          return disposition.group === "a" ? disposition.path : ""
        }),
      ),
    ]
    expect(groupAPaths.filter((subpath) => publishedPaths.has(subpath)).length).toBe(groupAPaths.length)
    expect(groupAPaths.length).toBeGreaterThan(0)

    // 23 modules behind 9 subpaths. The ratio is the design: contracts are
    // grouped by concept, not minted per file.
    expect([...new Set(paths)].toSorted()).toEqual([
      "./account",
      "./identity",
      "./persistence",
      "./ports/onboarding",
      "./ports/settings",
      "./ports/workspaces",
      "./query",
      "./runtime",
      "./telemetry",
    ])
  })
})

describe("group (c) — the exports being refused", () => {
  test("every refusal states a reason and an alternative", () => {
    const thin = groupC.filter((module) => {
      const disposition = REQUIRED_EXPORTS[module]!
      if (disposition.group !== "c") return true
      return disposition.reason.length < 80 || disposition.alternative.length < 60
    })

    // A refusal without a real reason or a real alternative is a refusal that
    // becomes an export on the day of the move.
    expect(thin).toEqual([])
    expect(groupC.length).toBe(22)
  })

  test("every alternative names modules that actually exist and have a known destination", () => {
    const check = (names: string[]) =>
      names.filter((name) => !modules.includes(name) || !(isLeaving(name) || name in REQUIRED_EXPORTS))

    const unresolved = groupC.flatMap((module) => {
      const disposition = REQUIRED_EXPORTS[module]!
      if (disposition.group !== "c") return [`${module}: not a refusal`]
      if (disposition.alternativeModules.length === 0) return [`${module}: alternative names no module`]
      return check(disposition.alternativeModules).map((name) => `${module} -> ${name}`)
    })

    // Each alternative must land somewhere real: either a module that becomes
    // public here (groups a/b), or one that moves to cloud-app with the code.
    expect(unresolved).toEqual([])

    // Positive control for that emptiness, using the SAME predicate on inputs
    // that must fail: a module that does not exist, and one that exists but is
    // neither moving nor being exported.
    expect(check(["platform/does-not-exist.ts"])).toEqual(["platform/does-not-exist.ts"])
    expect(check(["app/app-shell.tsx"])).toEqual(["app/app-shell.tsx"])
    expect(check(["features/documents/app-ports.ts"])).toEqual([])
  })

  test("the transport that carried the boundary cycle no longer does", () => {
    // The reason text claims api.ts imports NOTHING on the move list. Assert it
    // from resolved specifiers rather than trusting the prose next to it.
    const importsOf = (module: string) => {
      const file = path.join(srcRoot, module)
      const text = readFileSync(file, "utf8")
      return allImportSpecifiers(text)
        .map((specifier) => resolveImport(appRoot, file, specifier))
        .filter((resolved): resolved is string => resolved !== null)
        .map((resolved) => path.relative(srcRoot, resolved).split(path.sep).join("/"))
    }

    expect(REQUIRED_EXPORTS["platform/api/api.ts"]?.group).toBe("c")
    // The whole point of the change that cut it: a module app publishes to
    // nobody must at least not DEPEND on the package being carved out of it.
    expect(importsOf("platform/api/api.ts").filter(isLeaving)).toEqual([])

    // And `transport.ts` inherits the improvement, since its only route to the
    // identity provider was through api.ts.
    expect(REQUIRED_EXPORTS["platform/runtime/transport.ts"]?.group).toBe("c")
    expect(importsOf("platform/runtime/transport.ts")).toContain("platform/api/api.ts")
    expect(importsOf("platform/runtime/transport.ts").filter(isLeaving)).toEqual([])

    // Positive control for both emptinesses: the resolver is returning real
    // edges for these files, and the SAME predicate does report a leaving
    // import on a module that has one — otherwise an `isLeaving` that matched
    // nothing would make every line above pass.
    expect(importsOf("platform/api/api.ts").length).toBeGreaterThan(2)
    expect(importsOf("platform/runtime/transport.ts").length).toBeGreaterThan(2)
    expect(importsOf("app/entry/main.tsx").filter(isLeaving)).toContain("platform/auth/auth-client.ts")
  })

  test("the type-only refusals really are type-only", () => {
    // The `typeof`-port cluster's whole argument is that these edges cost
    // nothing at runtime and only exist to name a type. If one of them acquired
    // a value import, the alternative ("declare it structurally") stops working
    // and the entry has to be re-argued.
    const typeOnlyRefusals = [
      "app/integrations/claxedo-events.tsx",
      "app/integrations/doc-workgraph.ts",
      "app/integrations/sync/query-options.ts",
      "app/workbench/actions/shared.ts",
      "app/workbench/lib/open-markdown-page-tab.ts",
      "app/workbench/state/index.ts",
      "app/workbench/state/surface-route.ts",
      "app/workbench/workbench/index.ts",
      "features/session/providers/session-sync.tsx",
      "features/session/ui/components/cloud-startup-view.tsx",
      "features/session/ui/components/session-pane-scope.tsx",
      "features/workspaces/data/query/project-ensure.ts",
    ]

    const valueImported = typeOnlyRefusals.filter((module) =>
      outbound.some((edge) => edge.to === module && !edge.typeOnly),
    )

    expect(valueImported).toEqual([])
    // Paired: every module listed is genuinely on the measured surface, so the
    // emptiness above is not "the scan found none of them".
    expect(typeOnlyRefusals.filter((module) => !surface.includes(module))).toEqual([])
    expect(typeOnlyRefusals.length).toBe(12)
  })
})

describe("what the existing export paths look like after the move", () => {
  /**
   * `./components` is not the shared-UI barrel its name implies.
   *
   * `app/controls/index.ts` re-exports five feature components and EVERY ONE is
   * on Unit 10's move list, so the path empties out on the day of the cut. This
   * is why group (a) can point six shared UI modules at it without widening
   * anything: the barrel is being vacated, not extended.
   *
   * If a module ever appears here that is NOT moving, `./components` has become
   * a genuinely mixed barrel and the group (a) plan needs re-reading.
   */
  const COMPONENTS_BARREL_MOVES = [
    "features/settings/ui/account-section.tsx",
    "features/settings/ui/connections.tsx",
    "features/settings/ui/sandbox-section.tsx",
    "features/workspaces/ui/cloud-auto-switch.tsx",
    "features/workspaces/ui/dialogs/create-cloud-project.tsx",
  ]

  const barrelTargets = (module: string) => {
    const file = path.join(srcRoot, module)
    const text = readFileSync(file, "utf8")
    return [
      ...new Set(
        allImportSpecifiers(text)
          .map((specifier) => resolveImport(appRoot, file, specifier))
          .filter((resolved): resolved is string => resolved !== null)
          .map((resolved) => path.relative(srcRoot, resolved).split(path.sep).join("/")),
      ),
    ].toSorted()
  }

  test("`./components` publishes only modules Unit 10 moves out", () => {
    const targets = barrelTargets("app/controls/index.ts")

    expect(targets).toEqual(COMPONENTS_BARREL_MOVES)
    expect(targets.filter((module) => !isLeaving(module))).toEqual([])
    // Paired: the barrel was read and it does re-export something.
    expect(targets.length).toBe(5)
  })

  test("`.` and `./pages` both re-export a route that moves", () => {
    // `app/routes/login.tsx` is on the move list, and TWO published paths reach
    // it: the package root barrel and `./pages`. Neither is named in Unit 10's
    // Files list beyond "Modify: app/routes/index.ts", so the root entry's
    // re-export is an unlisted edit the cut needs.
    expect(isLeaving("app/routes/login.tsx")).toBe(true)
    expect(barrelTargets("app/routes/index.ts")).toContain("app/routes/login.tsx")
    expect(barrelTargets("app/entry/index.tsx")).toContain("app/routes/login.tsx")
    // Paired: both barrels resolved to real module lists.
    expect(barrelTargets("app/routes/index.ts").length).toBeGreaterThan(1)
    expect(barrelTargets("app/entry/index.tsx").length).toBeGreaterThan(10)
  })
})
