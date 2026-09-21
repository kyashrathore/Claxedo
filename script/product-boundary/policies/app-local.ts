import type { Policy } from "../policy.ts"
import { APP_ALIASES, MANIFEST_READS, TASKS_CHUNK_MARKER } from "./shared.ts"

const SRC = "packages/claxedo-app/src"

/**
 * `@claxedo/app`'s LOCAL production entry.
 *
 * The local product exists so an unsigned desktop does not ship an identity
 * provider it can never use. The rules below are the same ones
 * `src/architecture/local-entry-closure.guard.test.ts` and
 * `vite.local.config.ts` state — this is the copy a reviewer runs with one
 * command, and the copy the other product policies are checked against.
 *
 * WHAT THIS DOES NOT COVER, stated because a green run here is otherwise easy
 * to over-read:
 *
 *  - It is a SOURCE walk. Rollup can put a module in a chunk with no import
 *    edge to follow — that is precisely how a vendored identity-provider chunk
 *    once reached a build whose whole purpose was to have no identity provider
 *    in it. The emitted half is `scripts/check-local-bundle-identity.ts`, which
 *    `verify:closure` runs after a real `build:local`.
 *  - The hosted IMPLEMENTATION SET is forbidden and absent, including its
 *    Documents renderer chunk. A small shared contract/data seam is still
 *    reachable today: seven modules under `features/documents/`, the unbound
 *    cloud workspace port module, anonymous auth-session abstraction, and login
 *    route. Those files stay co-located in this package; forbidding their whole
 *    roots here would fail on real code rather than gate anything. The exact
 *    ceiling keeps that seam shrinking.
 *
 * What IS enforced is the part that was actually finished: no module route to
 * `better-auth-browser-auth.ts` — the four routes that existed on 2026-08-09
 * were each cut to a port.
 */
export const appLocal: Policy = {
  id: "app-local",
  summary: "@claxedo/app local entry (src/app/entry/local.tsx)",
  packageDir: "packages/claxedo-app",
  entry: `${SRC}/app/entry/local.tsx`,
  roots: [SRC],
  aliases: APP_ALIASES,

  forbiddenPackages: ["better-auth"],
  forbiddenModules: [
    // The module that MINTS a token. Every local module that needs one takes
    // it from `configureApiRuntime`/`configureAuthSession` instead.
    `${SRC}/platform/auth/better-auth-browser-auth.ts`,
    // The hosted browser entry. A local build reaching it would start the
    // signed-identity composition.
    `${SRC}/app/entry/main.tsx`,
    // The hosted implementation set. Its loaders are injected by main.tsx, so a
    // local build must not carry even their lazy chunks.
    `${SRC}/app/integrations/documents-content-surfaces.tsx`,
  ],
  permittedOutsideRoots: MANIFEST_READS,

  control: {
    // The local entry is the whole shared app shell; a walk that read only the
    // entry file would report 1.
    minModules: 700,
    requiredModules: [
      `${SRC}/app/entry/local.tsx`,
      // The shared shell. Absent means the walk stopped at the entry.
      `${SRC}/app/entry/app.tsx`,
      // Reached only through the `@/` alias, so its absence means alias
      // resolution silently died — the failure that would ALSO hide the
      // identity provider and report a clean local product.
      `${SRC}/platform/api/api.ts`,
      // Owns the loopback-vs-hosted route split without importing relay or
      // hosted workspace machinery into the local product closure.
      `${SRC}/platform/runtime/server-transport.ts`,
      // Reached only through `#terminal-backend`, the build-config virtual
      // module. Same reasoning, different resolver.
      `${SRC}/features/terminal/core/backend/xterm.ts`,
    ],
    requiredPackages: ["solid-js"],
  },

  // Measured 2026-08-09 with `runtimeOnly`, after the hosted loader moved to
  // the hosted entry, plus the dependency-light loopback transport owner.
  // No headroom: the remaining shared seam must only shrink.
  // Usage adds the chart, breakdown, quota view, and shared provider-brand
  // module to the local UI; all other dependencies were already in the
  // renderer closure.
  // Five reviewed local owners entered after the 2026-08 local-entry
  // baseline: live-session/project ownership, rail status, first-fold prefetch, and the
  // deferred message navigator. The session-switch performance campaign adds
  // another twenty-five narrow owners for reactive route snapshots, title and
  // pane projection, memory accounting, bounded prefetch, first-fold/history
  // hydration, progressive reveal, secondary status, files, and runtime URLs.
  // Removing the speculative Markdown preloader offsets one, so the complete
  // reviewed closure grows from 831 to 860 modules and adds no package edge.
  // The workspace-panel/review performance campaign splits twenty-nine more
  // narrow owners out of the same reachable surface (review window height
  // projection and diff prime, panel settle fact and body-hydration door,
  // timeline displayed-frame loop, content-backed file find, runtime
  // file-request cache, navigator hover prefetch, and the session-ui splits
  // those lean on). The subsequent virtualized-review validation replaces the
  // old open-diffs owner with separate toggle and loaded-identity owners, a net
  // increase of one. The session-navigation row's directly imported style
  // sheet is also a source-walk module: 860 + 30 + 1 = 891 modules, still no
  // package edge. The reviewed session/workbench follow-ups add eight focused
  // owners for app-shell navigation, UI flags, rail shortcuts, base branches,
  // parent navigation, terminal status, workspace routes, and project owners,
  // while retiring three AI-connect modules: 891 + 8 - 3 = 896 modules, with
  // no package-ceiling change. The ordered session-archive projection boundary
  // adds one local session owner: 896 + 1 = 897 modules, still no package edge.
  // Session markdown first-fold preload, environment-card persistence, Thinking
  // visibility hold, provider-settings detect/disconnect logic, models-settings
  // logic, provider setup row, and the settings-providers dialog opener add
  // eight named owners (897 + 8 = 905). Tenant-aware multiplayer adds four
  // already-reachable local owners: 905 + 4 = 909. Org→Team product UI adds six
  // local owners (settings org-team section + API, session share API + Share
  // control, rail org/team switcher): 909 + 6 = 915 modules.
  // Cloud workspace create routes through AccountPort via workspace-create-api:
  // 915 + 1 = 916. Shared AccountPort bridge (`hosted-control-call`) plus
  // connection mint/refresh and workspace.resolve: 916 + 1 = 917.
  // Integrations, documents, and optional-service AccountPort adapters:
  // 917 + 3 = 920.
  // Control-plane AccountPort fetch adapter: 920 + 1 = 921.
  // AccountPort SSE stream adapter (`account-stream-fetch`): 921 + 1 = 922.
  // Agent-config extensions AccountPort adapter (marketplace): 922 + 1 = 923
  // modules. Provider-settings translations are split into one lazy feature
  // dictionary per non-English locale: 923 + 16 = 939. The reviewed auth and
  // Cloudflare-deployable flow adds the service-contribution catalog,
  // bootstrap-owner route, and canonical private-session reservation client.
  // `@claxedo/service-contract` is their dependency-neutral vocabulary owner.
  // +2 `workspace/host-serving-routes.ts` and its loopback control routes —
  // the machine's ONE relay serving connection (reviewed owner: the
  // local-server workspace domain).
  // 2026-09-01: +1 `features/workspaces/data/auto-share-local-workspaces.ts`.
  // Remote access is machine level, so the published set is reconciled against
  // this machine's local workspace inventory instead of a per-workspace tick
  // list; reviewed owner is the workspaces data domain, which already owns both
  // halves (`share-workspace` decides what is local, `shared-workspaces` reads
  // what is published) and is the only layer allowed to import them —
  // `features/onboarding` may not.
  // Session open/switch instrumentation (`platform/performance/session-perf.ts`
  // and its screen-side owner `features/session/ui/session-open-perf.ts`)
  // adds two modules and no package edge.
  // `platform/runtime/agent/cached-signed-workspace.ts` — the one reader of the
  // signed inventory from the shared Query cache: one module, no package edge.
  // Removing the retired local UI extension view, registry, and loader
  // subtracts three modules.
  // The Goal-mode merge re-lands the universal-Goal session owners on top of
  // the local/cloud split: composer Goal intent/submission/draft lifecycle,
  // Goal authority cache/query/controller, runtime Goal client/event ingress,
  // the active-Goal dock, and the review-pass Stop fallback + shared JSON
  // reader: thirteen modules.
  // `features/workspaces/data/workspace-catalog.ts` (the single catalog owner):
  // one more module, no package edge.
  // Settings scope: the Settings feature gains its scope owner (`features/settings/scope/
  // settings-scope.tsx` and its pure `settings-scope-options.ts`) and the
  // picker that drives it (`features/settings/ui/scope-selector.tsx`). All
  // three are owned by the settings feature and reachable only through the
  // already-lazy Settings dialog; they read the catalog and the harness
  // inventory through existing owners, so this is three modules and no package
  // edge. The retired machine-scan module `features/settings/provider-detect.ts`
  // is deleted in the same slice, and the measured closure is 962.
  // The session event streams gain their single owner: `platform/runtime/
  // session-event-scope.ts` (which session's scoped streams must be open, and
  // whether each lane has one) plus `app/integrations/claxedo-event-targets.ts`
  // (the pure target list the events provider was already computing inline).
  // Reviewed owners: the platform runtime layer, which both the events provider
  // and the global-sdk provider already depend on, and the events integration
  // itself. Two modules, no package edge, and the measured closure is 964.
  // `app/providers/global-sdk/route-event-scope.ts` is the shell route's
  // workspace as the global-sdk provider reads it — the stand-in live session
  // and the signed-boundary decision — split out of the provider; one module,
  // no package edge; the measured closure is 965.
  // `app/providers/global-sdk/presentation-frames.ts` is what a frame off a
  // stream MEANS — which presentation events are admitted, and what a replay
  // gap invalidates — split out of the global-sdk provider. Reviewed owner:
  // the global-sdk provider itself, whose module this already was; one
  // module, no package edge; the measured closure is 966.
  // `@claxedo/agent-event-runtime`'s `contracts/turn-message-ids` is the one
  // owner of the runtime's turn message-id convention — the app reads a reply's
  // parent from it in `features/session/data/session-types` and
  // `features/session/conversation/opencode-conversation`, and the compat
  // projection the app already depends on mints and resolves ids through it.
  // Reviewed owner: the agent event contracts package, which this closure
  // already carries; one module, no package edge.
  // -10 modules / -1 package: retiring the hosted work-ledger service took the
  // hosted content-surface module, its app-ports seam, the shared rich-text
  // editor (its only consumer), the document work-source action chain, and the
  // service package itself out of this closure. Re-measured, no headroom.
  // +6 modules / 0 packages (2026-09-04): the Agent Plugins marketplace became a
  // Directory (search, source chips, cards, detail pane, add-source form) plus
  // an install sheet, the shared connections helper, and the signed desktop's
  // DirectoryApi over hosted operations, replacing the single catalog surface.
  // Reviewed owner: features/agent-plugins (this product's own surface); every
  // edge stays inside packages already in the closure. Re-measured, no headroom.
  // +7 modules / 0 packages (2026-09-04, polish): the Directory split into status,
  // facts, actions, MCP rows, skill view, overflow menu, pane width, and chrome
  // modules; every edge stays inside packages already in the closure. Re-measured, no headroom.
    // +1 module (2026-09-04): the Personal entry pane. Re-measured, no headroom.
  // +2 modules (2026-09-05): New Project now evaluates the server-mode flow
  // rule (`features/workspaces/actions/new-project-flow.ts`) and can reach the
  // folder-versus-cloud chooser (`ui/dialogs/new-project-kind.tsx`); the local
  // product opens the folder picker, the chooser only appears once signed.
  // +7 modules / 0 packages (2026-09-06): the oxlint type-aware sweep replaced
  // inline casts and duplicated helpers with named owners, and a named owner is
  // a module the walker counts. Nine appeared and one left. Reviewed owners, all
  // inside this package and all reached from `app/entry/local.tsx`:
  //   lib/total-record.ts, ui/event-handler.ts,
  //   platform/persistence/solid-store-erasure.ts, platform/account/preload-bridge.ts,
  //   features/session/conversation/agent-conversation-codec.ts,
  //   features/session/data/sync/session-event-info.ts,
  //   features/session/lib/request-error-message.ts (replaces the deleted
  //     features/session/composer/ui/submit-error-message.ts),
  //   features/settings/ui/keybind-map.ts, features/onboarding/error-text.ts.
  // Every edge stays inside packages already in the closure — the package count
  // is unchanged at 37 — so this is the same code under a name, not new reach.
  // Re-measured, no headroom.
  // +1 package (2026-09-06): @claxedo/helpers enters the closure. Reviewed
  // owner: packages/claxedo-helpers, the canonical home for helpers the
  // repository had been re-defining per file; this product reaches it through
  // the zero-import `/guards` subpath, so the edge adds one package and no
  // host-API surface. The package edge is paid once for the whole product no
  // matter how many call sites migrate. Re-measured after the test-quality
  // audit merge, which retired the per-file readers those sites replaced:
  // 958 modules, 38 packages, no headroom.
  // +1 module / 0 packages: a rail row for a workspace on another machine
  // carries the session's creator, which only the control plane knows. Reviewed owner:
  // features/session/data/sync/control-plane-sessions.ts — the one reader of
  // `GET /api/control/sessions`, extracted from `inventory-source.ts` so the
  // rail's owner join and the flat inventory share it instead of each spelling
  // out the bridge/HTTP pair. Both callers were already in this closure and it
  // reaches nothing new, so the package count is unchanged at 38. Re-measured,
  // no headroom.
  // +1 module / 0 packages (2026-09-07): reviewed owner
  // app/workbench/rail/rail-session-activity.ts — the rail's per-row status
  // projection, lifted out of `rail-sidebar.tsx` so that nothing in it reads
  // what it writes: pruning is keyed on the target set, and unseen-done is a
  // memo rather than an effect. It imports only siblings already in this
  // closure, so the package count is unchanged at 38. Re-measured, no headroom.
  // +30 modules / 0 packages (2026-09-07): the workspace panel's Changes column
  // is the source-control view (`app/workbench/source-control/`: view, commit
  // box, change groups, commit graph, remote lookup, stylesheet = 6) with its
  // 17 lazy `platform/i18n/source-control/` locale dictionaries, split out so
  // the base locale files stay inside their size ratchets; its git reads and
  // writes are `platform/runtime/workspace-git-client.ts`,
  // `platform/files/workspace-git-status-query.ts` and
  // `app/workbench/context/workspace-git-mutations.ts` (+3); the panel body's
  // Processes column is `app/workbench/workspace-panel/processes-navigator.tsx`
  // over `app/workbench/context/process-pane-registry.ts` (+2); and a session
  // pane floating under the full-view panel is
  // `app/workbench/workbench/pane-presentation.ts` with
  // `features/session/ui/session-presentation.css` (+2). Reviewed owner:
  // app/workbench/source-control (this product's own surface); every edge stays
  // inside packages already in the closure. Re-measured, no headroom.
  // +2 modules / 0 packages (2026-09-07): the Changes column's Compared changes
  // group, `app/workbench/source-control/compare-group.tsx`, over the diff
  // summary query `platform/files/workspace-diff-summary-query.ts` (the
  // `to-from` file list the pane's review selection names). Reviewed owner:
  // app/workbench/source-control; both edges stay inside packages already in
  // the closure. Re-measured, no headroom.
  // +1 module / 0 packages (2026-09-07): `features/session/ui/transcript-peek.ts`,
  // the floating card's peek reducer split out of session-screen so its rules
  // (a sent prompt opens the transcript, loading history does not) are unit
  // tested. Reviewed owner: features/session/ui; no new package edge.
  // Re-measured, no headroom.
  // +3 modules / 0 packages (2026-09-08): Settings → Providers' restored
  // harness sections — `features/settings/ui/agents-section.tsx`,
  // `features/settings/ui/harness-providers-section.tsx` and the detection
  // reader `features/settings/provider-detect.ts`. Reviewed owner: the settings
  // feature; the scan itself stays the onboarding engine
  // (`features/onboarding/ai-connect-*`), already in this closure, so no new
  // package edge. Re-measured, no headroom.
  // +2 modules / 0 packages (2026-09-08): the restored custom-provider dialog
  // `app/dialogs/custom-provider.tsx` and its validation
  // `app/dialogs/custom-provider-logic.ts`, reached from the provider picker.
  // Reviewed owner: app/dialogs; the credential write and the config write both
  // go through control-plane routes this closure already reaches, so no new
  // package edge. Re-measured, no headroom.
  // +1 module / 0 packages (2026-09-08): the restored `/mcp` catalog splits
  // across its two owners — `features/agent-plugins/mcp/catalog-dialog.tsx`
  // renders the catalog from props, and `app/dialogs/select-mcp.tsx` picks the
  // rails, the same shape the Directory already uses. The alternative, one
  // module under `features/session`, is the edge the ownership guard rejects:
  // a session surface reaching into another feature and into app composition.
  // Both files import only modules already in this closure. Re-measured, no
  // headroom.
  // -2 modules / 0 packages (2026-09-08): the session header's Open in… / Copy
  // path control is gone at the user's request, taking
  // `features/session/ui/components/session-header-open-in.tsx` with it; its
  // app-name allowlist moved to `claxedo-desktop/src/main/open-in-apps.ts`,
  // beside the `open-path` guard that is now its only reader. Re-measured, no
  // headroom.
  // +3 modules (2026-09-08): Settings reaches connected-apps-section,
  // connected-apps-api and better-auth-api-error for OAuth consent revocation.
  // server-routes replaces server-client-contract at the connection boundary.
  // Full verify:closure measured 1005 modules / 38 packages; no headroom.
  // +1 module: `platform/sync/local-event-websocket.ts` owns the loopback
  // WebSocket transport of the control-plane stream (`cp/events`) across
  // windows. Authoritative builds and identity checks passed; measured 1006 / 38.
  // +1 module (2026-09-09): the terminal agent catalog and the commands saved
  // for it move out of the Settings UI into their owner,
  // `features/terminal/core/{terminal-agents,terminal-commands}.ts` — the rail's
  // quick-launch buttons and the creator read the pair instead of reaching into
  // a settings pane, and `settings/ui/terminals.tsx` leaves this closure with
  // the lazy Settings dialog. Net +1; no new package edge. Measured 1007 / 38.
  // +1 module (2026-09-11): review-workspace-tab-button, the workspace panel's
  // one tab chip. It splits out of review-workspace.tsx, which the subagent tab
  // pushed past the 800-line budget, and imports only what that file already
  // did. It sits in the slot `session-order-hold` opened and never recorded,
  // which `session-bands` inherited one-for-one and freed when the rail's
  // ordering moved to the server's list. No new package edge. Measured 1008 / 38.
  // +3 modules (2026-09-12), each a canonical owner split out so a policy
  // becomes readable without importing the module that hosts it:
  //   app/workbench/rail/workspace-panel-working-set.ts — the panel's
  //     retained-surface identity, read by the top-level open and full-width
  //     policies (from workspace-panel-body.tsx);
  //   features/session/store/pending-prompt-registry.ts — the in-flight
  //     prompt set, a leaf so the status dispatcher can read it without a
  //     cycle through submit/ (from submit/pending.ts);
  //   features/session/ui/timeline-link-open.ts — routes claxedo:open-link
  //     from the transcript to a Browser tab, the OS opener or platform.openLink
  //     (from message-timeline.tsx).
  // No new package edge. Measured at a clean checkout: 1010 / 38.
  // +1 module (2026-09-12): app/workbench/review/review-workspace-subagent-tabs.ts,
  // the conversation-scoped policy for subagent tabs, split out of
  // review-workspace.tsx at its 800-line budget; imports only what that file
  // already did. No new package edge. Measured at a clean checkout: 1011 / 38.
  // +3 −2 modules (2026-09-12), Settings → Models rebuilt around the harness:
  //   + features/session/harness/harness-model-options.ts — the loader that
  //     reads a harness's reported model list over the composer's options
  //     transport; owned by the session harness feature, reached eagerly
  //     through the settings ports in app/integrations/secondary-feature-ports.ts;
  //   + features/settings/harness-models.ts and settings/ui/models.css — the
  //     page's query hook and its two reveals, behind the lazy Settings dialog;
  //   − app/dialogs/connect-ai.tsx — the Connect-your-AI dialog, replaced by
  //     the Agents rows connecting in place;
  //   − features/settings/ui/scope-selector.tsx — the workspace/harness
  //     pickers, gone with per-workspace model visibility.
  // No new package edge. Measured 1012 / 38.
  // +1 module (2026-09-12): features/session/ui/timeline-mount-cache.ts, what a
  // session's first paint knows about its turns — the measurement/open-state
  // snapshot lifted out of message-timeline.tsx at its size budget, plus the
  // per-turn foldable count it now resolves so a switch cannot re-fold rows
  // under the reader. It reaches the prefetched page and the view key through
  // owners the rail and the session controller already put in this closure.
  // No new package edge.
  // +2 modules (2026-09-13): features/settings/ui/agent-harness-row.tsx and
  // features/settings/ui/provider-connect-card.tsx, the Agents-on-this-machine
  // row and the inline connect card lifted out of provider-setup-row.tsx so the
  // catalog row and the agent row stop sharing one component with two jobs. Both
  // are reached only from the settings feature already in this closure.
  // No new package edge.
  // +1 module (2026-09-13): platform/identity/harness-catalog.ts, the single
  // owner of the words a harness and its vendor are named by. The connect card
  // used to render the registry's provider id when the model catalog had never
  // heard of it; both the card and the agent rows now resolve through here, and
  // it reaches nothing but the harness-id union already in this closure.
  // No new package edge.
  // +1 module (2026-09-13): platform/identity/connect-methods.ts, the single
  // owner of a vendor's sign-in methods — their display order, the words that
  // explain each one, the command that mints a token and the vendor's key page.
  // The connect card reads it beside harness-catalog.ts, already in this
  // closure, and it imports nothing.
  // No new package edge.
  // +1 module (2026-09-13): lib/percent.ts, the single owner of how a usage
  // percentage is read. The vendors report the fraction they measured, and the
  // Settings agent rows and the Usage quota cards each spelled it out in full;
  // both round through here now. It imports nothing.
  // No new package edge.
  //
  // `app/workbench/rail/first-project-canvas.{tsx,css}`: the rail canvas is the
  // screen this entry boots to before a project exists, and it renders the
  // create form inline rather than mounting the draft composer with an empty
  // project, so both modules belong to the local product.
  //
  // `app/integrations/settings-sections.ts` is the shell's registry for
  // contributed settings sections; Tasks registers its Presets section through
  // it.
  //
  // Tasks and Presets. `@claxedo/tasks` is the package edge; the HLD makes both
  // catalogs part of every build that renders the shell, so the surface is
  // registered from `app/integrations/secondary-feature-ports.ts` — the
  // first-party surface list is reached from the published local entry, whose
  // closure must stay clear of hosted capability modules — and everything
  // behind it hangs off the one module that list dynamic-imports,
  // `app/integrations/tasks-contributions.ts`. The reviewed owners are the
  // `app/integrations/tasks` modules that bind the ports (the catalog and
  // navigation ports, the contributed Presets settings section, and the
  // `ProseEditor` binding) and the `features/tasks` modules behind them: the
  // app ports, the catalog client and its queries, the filter/draft store, the
  // preview-and-start pair, the view-model and preset-editor model, and the
  // surface with its two pages, dialogs, detail panel, list, board and shared
  // row controls. The kit keeps domain, http, client and conformance; its UI
  // lives here, which is why those modules are visible to this walk at all.
  //
  // Task descriptions and preset instructions use the Documents editor, which
  // the user reviewed and accepted on 2026-09-13 — "task description and preset
  // instructions use the Documents editor" — because the alternative was a
  // second markdown surface with its own subset. That is where the Tiptap
  // package edges come from: @tiptap/core, /pm, /starter-kit, /markdown,
  // /suggestion, solid-tiptap, and the extensions the Documents configuration
  // mounts. The owner is `app/integrations/tasks/tasks-prose-editor.tsx`, and
  // the Documents modules it reaches are the rich editor, its extension list
  // (including the markdown input rules and paste path), the mermaid block,
  // slash commands, and the markdown detector and frontmatter pair that keep
  // the stored value markdown. The hosted Documents set stays out: no store,
  // route or content-surface module is reachable from here, and
  // `documents-content-surfaces` remains a forbidden chunk marker.
  //
  // The account Settings section carries the "Agents may act on my other
  // machines" switch, so `features/settings/data/agent-settings-api.ts` — the
  // signed control plane's GET/PUT of that one setting — is reached from the
  // General settings page beside the account section that already was. No new
  // package edge; the module is the setting's only reader and writer.
  //
  // +2 modules (2026-09-15): queued messages drawn in the timeline.
  // `features/session/queue/queued-messages-controller.ts` owns the runtime
  // queue query and its send-now / remove / edit controls;
  // `features/session/ui/timeline-queued-messages.tsx` draws the records after
  // the last row; `composer/ui/submit-queued-edit.ts` turns a send into a
  // replace while the draft holds a queued message. The composer overlay
  // `session-queued-messages.tsx` they replace is gone. No new package edge.
  //
  // +1 module (2026-09-15): `features/session/ui/idle-return-scroll.ts` — the
  // session feature's idle-return scroll policy, reached through
  // `session-screen.tsx`. Re-measured, no headroom.
  //
  // +2 modules (2026-09-14): task images. `features/tasks/ui/dialogs/image-drafts.ts`
  // reads a pasted, dropped or picked file into the base64 a create carries and
  // shrinks an oversized one on a canvas; `features/tasks/ui/detail/task-attachments.tsx`
  // fetches a stored image through the Tasks client and shows it. Both are the
  // Tasks feature's own, reached from its create form and detail page over the
  // `@claxedo/tasks` edge this product already carried. No new package edge.
  //
  // +1 module (2026-09-16): `app/workbench/rail/rail-transcript-typography-panel.tsx`
  // — the dev-only rail panel that picks the transcript pairing beside the
  // open transcript (it replaced the Settings → General card of the same
  // purpose); the pairing model itself lives in
  // `@opencode-ai/ui/theme/transcript-typography`, an edge already carried.
  //
  // +1 module (2026-09-16): `app/workbench/context/pane-ctx.tsx` — the
  // workbench slot's `PaneCtx` published as Solid context (`PaneCtxProvider` /
  // `usePaneCtx`), so a surface binds pointer input to its slot and receives
  // window keys through the workbench's router instead of listening on
  // `document`; mounted by `workbench.tsx`, consumed through the session and
  // tasks app-ports. No new package edge.
  //
  // +1 module (2026-09-16): `features/tasks/ui/shared/title-field.tsx` — the
  // Tasks title textarea that wraps a long title and refuses line breaks,
  // reached from the task detail page and the create form. No new package edge.
  //
  // +1 module (2026-09-17): `features/session/composer/collapsed-state.ts` —
  // `composerCollapsed`, the rule that folds the floating session composer to
  // one row while it is idle, read by `composer.tsx`. No new package edge.
  //
  // +1 module (2026-09-17): `platform/settings/transcript-typography.ts` —
  // `useTranscriptTypography`, where the stored transcript choice is composed
  // over the active theme's (`DesktopTheme.transcript`), read by
  // `message-timeline.tsx` and the rail typography panel. No new package edge.
  //
  // +1 module (2026-09-17): `features/session/store/session-history-resync.ts`
  // — the request an event stream's gap notice raises so the session
  // controller re-reads history and todo; raised by `claxedo-events.tsx` and
  // `session-events/event-router.ts`. No new package edge.
  //
  // -4 modules (2026-09-17): `app/integrations/claxedo-events.tsx` is the
  // app's one stream reader (`cp/events` and each workspace's `wr/events`),
  // with its reconnect policy in `app/providers/claxedo-events-reconnect.ts`;
  // the global-sdk provider consumes its frames and opens nothing of its own.
  //
  // +1 module (2026-09-20): `features/onboarding/machine-provider-config.tsx`
  // — the owner's push/clear of sealed provider credentials for one enrolled
  // machine, rendered under each row of the Machines list by
  // `remote-access-surface.tsx`. It reaches the control plane only through
  // `MachineRemoteAccessPort.providerConfig`, which the HTTP binding serves
  // and the desktop leaves absent; no new package edge.
  //
  // +2 modules (2026-09-20): `app/boot/data/deployment-posture.ts` and
  // `app/connection/deployment-posture.ts` — the server's
  // `deployment.issuesSessions` declaration, read before the first render and
  // then per active server. The local entry needs it as much as the hosted
  // one: a loopback daemon is the deployment that declares it issues NO
  // sessions, and that answer is what keeps this build's sign-in gate open and
  // its identity provider unstarted. Both reach only `platform/query`, already
  // in this closure; no new package edge.
  //
  // +17 modules (2026-09-20): `platform/i18n/machines/<locale>.ts`, one per
  // locale in `platform/i18n/locales.ts`. The machine, placement and
  // session-sharing copy split out of the base dictionaries so `en.ts` stays
  // inside the 800-line size budget, following `source-control/` and
  // `provider-settings/`. The i18n manifest owns them, it already imports both
  // sibling directories, and a dictionary reaches nothing; no new package
  // edge. Measured 1097 modules / 58 packages, with no headroom.
  // Two retained shared owners: claxedo-tool-href routes tool resources through
  // existing workspace navigation; draft-session-start persists creation-owner
  // references and reads canonical session lifecycle status. ACP questions use
  // the unchanged question dock; its separate UI, worker, query and action
  // modules have been removed.
  // +2 modules (2026-09-21): `features/session/ui/recovery-outcome-copy.ts` is
  // the one owner of how a cancellation's three facts read, and
  // `features/session/ui/session-recovery.tsx` is the panel the composer region
  // shows while a recovery command is unresolved. Both live under the session
  // feature that already owns the composer and its docks, and both reach only
  // `@claxedo/agent-runtime-contract`, which this entry already carries; the
  // package closure is unchanged at 58. Exact measured 1101 modules /
  // 58 packages, with no headroom.
  ceilings: { modules: 1101, packages: 58 },

  emitted: {
    file: "packages/claxedo-app/.artifacts/u8-package-split/manifests/app-local.json",
    // Positive controls measured from the real Vite build. Deliberately loose
    // enough for dependency pruning, but far above an empty/partial manifest.
    minModules: 2_000,
    minChunks: 300,
    requiredModules: [
      `${SRC}/app/entry/local.tsx`,
      `${SRC}/app/entry/app.tsx`,
      `${SRC}/features/terminal/core/backend/xterm.ts`,
    ],
    requiredChunkMarkers: [TASKS_CHUNK_MARKER],
    forbiddenChunkMarkers: ["documents-content-surfaces"],
  },
}
