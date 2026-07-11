# Architecture

Charter for every top-level directory in `src/` as it actually exists today,
verified against the source tree (not the refactor plan docs, which predate
some of this and are occasionally stale). Where the plan's own directory
list differs from reality, that is called out explicitly below.

`src/` currently has 30 top-level entries: 21 directories, and 9 loose
(non-directory) entries — this doc and `VOCABULARY.md` themselves, plus 7
others: `app.tsx`, `main.tsx`, `desktop-menu.ts`, `index.tsx`, `index.css`,
`env.d.ts`, and `custom-elements.d.ts` (a symlink to
`../../ui/src/custom-elements.d.ts`, not a real file). The 21 directories are
`agent-runtime, architecture, assets, browser, claxedo-ui, cloud, components,
context, demo, extensions, i18n, marketplace, pages, pane, process, session,
session-client, shared, shell, terminal, utils` (WP-B10 renamed `runtime/` →
`agent-runtime/`). The Wave 1.5 reorg deleted
eight top-level directories that earlier revisions of this doc charter'd —
`providers/`, `analytics/`, `constants/`, `hooks/`, `vite-shims/`,
`overrides/`, `src/e2e/`, and `cloud/runtime/` (flattened) — merging their
contents into `context/`, `utils/`, `pages/`, and `cloud/` respectively; those
charters are gone below. The refactor plan
(`docs/plans/2026-07-10-002-...lld.md` WP-01 step 2) predates this reorg and
still names some now-deleted directories — trust the live tree (`ls src/`),
not the plan. All 21 directories are charter'd below.

## Import direction: current reality (guard now exists, baseline is legacy debt)

**A directional-layering guard exists as of this wave**:
`src/architecture/layering.ts` computes bidirectional cross-directory import
cycles, and `layering.guard.test.ts` fails CI if a cycle appears that isn't
already in `layering-baseline.json`. The baseline currently seeds 29
already-existing two-directory cycles (e.g. `context<->shell`,
`components<->shell`) and is shrink-only: a second test fails if the
baseline lists a pair that is no longer a live cycle, forcing removal as
cycles get fixed, while new cycles beyond the baseline fail outright. So the
guard cannot prevent today's tangle, but it does stop it from growing and
ratchets it toward zero over time. (A follow-up fix-up is in flight to
tighten the guard's own test quality alongside the `composer-mode`/
`model-key` scanners added the same wave — see those files' tests directly
for current specifics rather than this doc, which will drift.)
Treat the "legal direction" column per-directory below as the target state
this refactor is working toward — the guard enforces "no new debt," not the
target state itself.

Two confirmed cycles, verified live:

- **`context/` ↔ `shell/`**: numerous files under `src/context/`
  (`global-sync.tsx`, `session-selection.tsx`, `layout.tsx`, `permission.tsx`,
  `global-sdk.tsx`, `sdk.tsx`, `command.tsx`, `terminal.tsx`,
  `claxedo-events.tsx`, `global-sdk-event-fetch.ts`, `use-providers.ts`, and
  files under `context/global-sync/`) import from `@/shell/...` (e.g.
  `shell/data/query-options`, `shell/data/directory-cache-manager`,
  `shell/data/bootstrap`). In the other direction,
  `src/shell/app-shell-layout.tsx`, `app-shell-state.ts`, `app-shell-commands.ts`,
  and `app-state-snapshot.ts` import from `@/context/...`. Neither
  directory can be read or changed in isolation today. (Note: as of Wave 1.5,
  the global-sync data plumbing — `global-sdk-fetch.ts` and the
  `bootstrap-orchestrator`/`event-ingress`/`inventory-source` modules — moved
  out of `context/` into `shell/data/`; `context/global-sync/` retains the
  session-filter/pagination/trim logic.)
- **`components/` ↔ `claxedo-ui/components/`**: `src/claxedo-ui/components/`
  imports from `src/components/` (e.g.
  `review-workspace/review-workspace.tsx` imports
  `@/components/session/session-context-tab` and
  `@/components/dialogs/select-file`; `layout-actions/project-actions.tsx`
  imports `@/components/dialogs/select-directory` and
  `@/components/dialogs/settings`). In the other direction, `src/components/`
  imports from `src/claxedo-ui/` via the `@claxedo/claxedo-ui/*` alias (e.g.
  `dialogs/select-file.tsx` → `@claxedo/claxedo-ui/state`;
  `prompt-input/frame.tsx`, `submit-control.tsx`, `toolbar-controls.tsx` →
  `@claxedo/claxedo-ui/components/...`; `session/session-header.tsx`,
  `titlebar/titlebar.tsx` → relative imports of
  `claxedo-ui/components/claxedo-icon`).
  See `src/components/README.md` for the intended (not yet enforced) layering.

## Directory charters

### `components/` (loose top-level files + `dialogs/`, `prompt-input/`,
`session/`, `settings/`, `titlebar/` subdirectories)
Fork-era first-party component library: dialogs (`dialogs/`), the prompt
input subsystem (`prompt-input/`), session UI (`session/`), settings panels
(`settings/`), the titlebar (`titlebar/`), and generic app chrome. This is
where most upstream-derived UI concepts were first ported after the hard fork.
Wave 1.5 folderized what used to be flat files: `dialog-*.tsx` → `dialogs/*`,
settings panels → `settings/*`, titlebar files → `titlebar/*`, and the old
`server/` subdirectory was flattened into top-level files (e.g.
`server-row.tsx`). Currently imports from and is imported by `claxedo-ui/`
(see cycle above) — see `src/components/README.md` for the layering this
refactor is working toward. **Add here:** a new dialog (in `dialogs/`), a
prompt-input feature, a settings panel (in `settings/`), or anything that is a
direct port/extension of an upstream component surface.

### `claxedo-ui/` (two `.css` files — `app-shell.css`, `ui-overrides.css` —
plus `compact-switcher/`, `components/`, `content-renderers/`, `context/`,
`harness/`, `layout-actions/`, `navigation-islands/`, `rail/`, `state/`,
`terminal/`, `utils/`, `workbench/`, `workspace-panel/`)
The rail/tab/pane app-shell layer — the multipane workbench, the rail
sidebar, layout persistence, and workspace-panel chrome that did not exist
upstream. Wave 1.5 renamed the two collision-prone directories and pulled
several concerns into named homes:
- `workbench/` (was `layout/`) — the workbench split/drag/keyboard engine,
  with its own `workbench/tests/` lettered suite (A–N).
- `rail/` (was `layouts/`) — the rail sidebar, workspace-panel shell,
  review-mount retention, etc. The old `layout/` vs `layouts/` one-letter
  naming collision is now resolved.
- `harness/` — the 20-odd `harness-*` config/store/runtime modules that used
  to sit loose under `claxedo-ui/context/`.
- `layout-actions/` (was `claxedo-layout-actions/`) — page/project/session/
  workspace/terminal action wiring.
- `utils/` — Claxedo-UI-scoped strays (active-workspace, workspace-display,
  session-title-sync, terminal-log-summary, etc.) collected out of the old
  top-level.
- `context/` — now holds exactly the five real UI providers (`pane-id`,
  `process-ownership`, `process-pane`, `session-params`, `session-sync`).
- `terminal/` — the centralized terminal-fit event and pane-terminal-recovery.
- `workspace-panel/`, `components/`, `content-renderers/`,
  `navigation-islands/`, `compact-switcher/`, `state/` (its `state/tests/`
  subfolder was flattened in Wave 1.5).

**Add here:** anything that is Claxedo-native workbench UI (new pane type,
rail feature, workspace-panel widget) with no upstream equivalent.

### `shell/` (top-level `app-shell*` files + `auth/`, `chat/`, `connection/`,
`contributions/`, `data/`, `durability/`, `harnesses/`, `identity/`,
`layout/`, `review/`, `workspace/` — 11 subdomains; Wave 1.5
renamed `chrome/`→`review/` and `state/`→`connection/`, and moved the
global-sync data plumbing — `global-sdk-fetch.ts`, `bootstrap-orchestrator`,
`event-ingress`, `inventory-source` — into `data/`)
App-shell composition and bootstrap: `app-shell*.ts(x)` files own top-level
route/command/state wiring. But the directory has grown well past an
"app shell" charter into a catch-all: `shell/data/` (bootstrap, directory
cache, query options — the actual query-cache writer for
`directory.path`/`directory.project`, see `shell/data/bootstrap.ts:172-195`),
`shell/identity/` (canonical `session-ref.ts`, see VOCABULARY.md), and
`shell/chat/` (conversation registry) each have real, load-bearing logic that
overlaps with the separately-named top-level `session/` and `context/`
directories. WP-D1 (Wave 4) closed most of this session-domain split:
`shell/session/` (session config selection, local-selection-handoff) moved
into `session/store/`, and the `session-client/{composer,harness,commands}`
subsystem moved into `session/`. What remains is a 2-way split — `session/`
plus the session-shaped providers in `context/` — and the residual
`session-client/index.ts` upstream-import barrel (WP-D2 formalizes that
boundary). **Add here today:** app-shell bootstrap/composition/routing only.
Session config/state logic now belongs in `session/` (see its charter below).

### `context/` (loose provider files + `file/`, `global-sdk/`, `global-sync/`)
SolidJS provider layer: the established home for every top-level app
provider (`command.tsx`, `config.tsx`, `file.tsx`, `layout.tsx`,
`notification.tsx`, `permission.tsx`, `server.tsx`, `terminal.tsx`,
`claxedo-events.tsx` — the SSE event bus, etc. — `ServerConnection`/server
context lives here, see VOCABULARY.md sense 5 of "workspace"). Imports from
`shell/data/*` for query primitives (part of the cycle documented above).
Wave 1.5 merged the former top-level `providers/` and `hooks/` directories
into here (`claxedo-events.tsx`, `use-providers.ts`). Wave 2 renamed the old
`local.tsx`/`command-upstream.tsx` providers to `session-selection.tsx`/
`command-palette.tsx`, added the `global-sdk/` subdir (`event-coalescer`,
`heartbeat-watchdog`, `reconnect-backoff`), and added `live-resource-cache.ts`.
**Add here:** a new SolidJS context/provider for app-wide state.

### `session/` (`helpers.ts`, `session-layout.ts`, `store/`, `submit/`, `composer/`, `harness/`, `commands/`)
Session store (`store/session-store.ts`, `store/session-controller.ts` — a
grandfathered god file, see `src/architecture/size-baseline.json`) and the
submit pipeline (`submit/dispatch.ts`, `submit/create-with-lifecycle.ts`).
Wave 1.5 moved `session-layout.ts` and `helpers.ts` here from the old
`pages/session/`. WP-D1 (Wave 4) consolidated the rest of the session domain
here: `store/` also holds the former `shell/session/` config-selection state
(`local-selection-handoff.ts`, `open-sessions.ts`, `session-config-selection.ts`),
and the harness-facing composer subsystem moved in from `session-client/` as
`composer/` (`composer/composer.tsx` — a grandfathered god file — plus
`mode.ts`, `model-strategy.ts` — the canonical `ModelKey` home — `role-gate.ts`),
`harness/` (harness resolution/store), and `commands/` (model/harness selection,
prompt-machine). **Add here:** session lifecycle (create/switch/status), submit
pipeline, harness selection, composer behavior, or prompt-machine logic.

### `session-client/` (`index.ts` only)
The `index.ts` barrel (renamed from `session-ui.barrel.ts` in Wave 1.5) is a
deliberate, documented upstream `@opencode-ai/session-ui/*` re-export boundary
— the sole remaining file here after WP-D1 moved `composer/`, `harness/`, and
`commands/` into `session/`. WP-D2 formalizes this barrel as the real
session-client boundary. **Do not add here:** composer/harness/commands logic
now lives in `session/` (see its charter above).

### `pages/` (route files + `session/`)
Route-level page components: `home.tsx`, `login.tsx`, `cli-login.tsx`,
`config.tsx`, `permissions.tsx`, `error.tsx`, `session.tsx` (a grandfathered
god file), and `directory-layout*`. Also holds `dialog-matrix-harness.tsx` —
a production-bundled debug harness (`app.tsx` lazy-imports it at the
`/__e2e/dialog-matrix` route, driven by `e2e/playwright/dialog-matrix.spec.ts`)
that Wave 1.5 moved here from the deleted `src/e2e/` directory; despite the
name it is application code, not a test fixture, so it stays in `pages/`.
`pages/session/` holds the route-level composer/timeline/view-state split out
of `session.tsx` (`message-timeline.tsx`, ~1700 lines, is the largest file
under `pages/session/` and one of the package's remaining god files, though
`claxedo-ui/rail/rail-sidebar.tsx` is larger still); Wave 1.5 moved its
`session-layout.ts`/`helpers.ts` out
to the top-level `session/` directory. **Add here:** a new top-level route.

### `terminal/` (core files + `backend/`, `integration/`, `link-parsing/`,
`link-providers/`)
The terminal core: resize/geometry/stream/buffer coordination, xterm backend
(`backend/xterm.ts`), keyboard/capability handling. Exceptionally
well-tested at the pure-module level (`resize-coordinator.test.ts`,
`terminal-connection.test.ts`, etc.). Wave 2 dissolved the old grandfathered
`helpers.ts` DOM-facing glue into named `backend/` modules
(`backend/renderer.ts`, `backend/keyboard.ts`, `backend/clipboard.ts`,
`backend/resize-handlers.ts`), each now with its own colocated test. Wave 1.5
added `integration/`, the home
for the wider end-to-end terminal specs (`terminal-focus-switch.test.ts`,
`terminal-lifecycle.test.ts`, the headless-emulator pipeline, etc.).
**Add here:** terminal lifecycle, rendering, or protocol logic.
`src/components/terminal.tsx` (grandfathered, zero tests) is the top-level
component that composes this directory's modules — it is NOT part of
`terminal/` itself, it lives in `components/`.

### `shared/` (`data/`, `query/`)
Cross-cutting wire shapes, backend transport clients, and query helpers with no
SolidJS dependency. **Charter (post-WP-D3):**
- **`shared/data/` = wire shapes + transport.** The backend/service HTTP clients
  and the domain wire types they carry: the base HTTP client (`api.ts`),
  backend/service clients (`auth-client.ts`, `credential-request.ts`,
  `server.ts`, `server-health.ts`, `share-workspace.ts`), session/workspace
  domain logic (`session-url.ts`, `comment-note.ts`, `session-title.ts`,
  `worktree.ts`, `prompt.ts`), product clients (`pages-api.ts` Pages CRUD,
  `arena-api.ts` Arena swarm — split out of the former combined `pages-api.ts`),
  plus the capability types in `types.ts` (see VOCABULARY.md). These are the
  files WP-D3 pulled out of `utils/`. One documented exception to the
  "no-framework" rule: `server-health.ts` exposes a thin `useCheckServerHealth`
  Solid hook, which is why the layering baseline carries `context<->shared` (see
  `architecture/layering-baseline.json` and WP-D3 move-map §4).
- **`shared/query/` = TanStack-Query wrappers.** Query-key registries (`keys.ts`),
  query-client accessors, cache-accessor helpers (`directory-config-cache.ts`,
  `directory-search-cache.ts`, `file-request-cache.ts`), the `WorkspaceRuntimeSnapshot`
  runtime helpers, and the small sort/normalize primitives (`sort.ts` `cmp`,
  `provider-list.ts` `normalizeProviderList`, split out of the former
  `query/utils.ts`).

**Add here:** a backend wire client / wire type (`data/`) or a TanStack-Query
key/cache helper (`query/`) reused by 2+ directories with no framework dependency.

### `utils/` (slim dependency-free primitives, plus `test-support/`)
WP-D3 dissolved the former multi-tier dumping ground. What remains is meant to
be **dependency-free primitives only** — no cross-directory value imports:
string/array/id/encode/binary helpers (`array.ts`, `base64.ts`, `binary.ts`,
`encode.ts`, `id.ts`, `uuid.ts`, `path.ts`, `path-key.ts`, `same.ts`, `time.ts`,
`url.ts`, `iife.ts`, `retry.ts`, `debug.ts`, `agent.ts`, `fetch-throttle.ts`,
`scoped-cache.ts`, `server-errors.ts`, `diffs.ts`, `sound.ts`, `notification-click.ts`,
`notification-permission.ts`, `breakpoints.ts`, `reduced-motion.ts`), plus the
Wave-1.5 absorbees `analytics.ts`, `file-picker.ts`, `lru-map.ts` (from the former
top-level `analytics/`, `constants/`, `vite-shims/`). The transport/backend/
domain/product clients that used to live here moved to `shared/data`,
`shared/query`, and `agent-runtime` in WP-D3; the dead files earlier docs listed
(`agent-cache.ts`, `aim.ts`, `runtime-adapters.ts`, `terminal-writer.ts`,
`local-selection-handoff.ts`, `project-meta-cache.ts`, `index.ts`) were deleted
by WP-A1; `convex-client.ts` and `living-apps-api.ts` (prod-dead) were deleted by
WP-D3.

**Two documented residents that are NOT dependency-free** (deliberately kept per
WP-D3 move-map §7):
- `persist.ts` (+test) value-imports `@/context/platform`, so it sustains the
  `context<->utils` cycle in `architecture/layering-baseline.json`. Rehoming it
  would force a different cycle; it stays here with this note.
- `workspace-runtime-route-audit.test.ts` — the 193KB import-boundary linter (not
  a unit test). WP-D3 deferred its relocation to `architecture/` + scanner rewrite
  because it carries pre-existing `@claxedo/*`→`@/*` alias drift (~16 failing
  assertions predating WP-D3, from the WP-D2 alias consolidation) that a mechanical
  move would newly surface in the `test:architecture` gate. Tracked as a follow-up.

**Add here:** only genuinely dependency-free primitives, as a last resort — prefer
a named home (`shared/`, `agent-runtime/`, the relevant feature directory) first.
`utils/test-support/` is the sanctioned location for cross-suite test fakes (see
CONTRIBUTING.md).

### `pane/` (`store/`)
The generic (non-workbench) split-pane preferences store
(`store/pane-preferences.ts`) — distinct from `claxedo-ui/workbench/`'s
workbench pane reducer. See VOCABULARY.md's pane/tab/panel/group section for
the disambiguation between this and the workbench's pane concept.
**Known dependency knot (deferred):** Wave 1.5 considered folding
`pane-preferences` into `claxedo-ui/`, but that move would create a new
`shared/` ↔ `claxedo-ui/` layering cycle (the preferences store is consumed
from the shared/generic side, and `claxedo-ui/` already imports it), so the
directory was deliberately left standalone. Resolving this belongs to the
`utils/`-dissolution-scale work (LLD WP-D3), not to a Wave 1.5 move. Do not
relocate this store without first untangling that cycle.

### `browser/` (`components/`, `store/`)
The in-app browser tab: `browser-pane.tsx`, `browser-url.ts`,
`browser-history.tsx`, `browser-comments.tsx`, `browser-address-bar.test.ts`.
Genuinely well-tested per the audit (descriptive names, real edge cases:
caps, dedup, persistence round-trips). **Add here:** browser-tab-specific
UI or state.

### `agent-runtime/` (core runtime modules + transport trio + tests + `AGENTS.md`, was `runtime/`)
Agent runtime client, session-routing placement table, and session
projection: `agent-runtime-client.ts`, `placement-table.ts` (the pure,
tested routing decision — which transport a session read/write goes to),
`workspace-kind.ts` (the single `WorkspaceKind` union), `session-projection.ts`,
`signed-workspace.ts` (signed-workspace request handling — "workspace" here is
sense 2/5, control-plane/server, not a directory). WP-D3 moved the core
transport/routing modules here out of `utils/`: `workspace-relay-connection.ts`,
`workspace-runtime-request.ts`, `workspace-control-routes.ts` (the highest-fan-in
route builders), and `dialog-select-directory-routes.ts` (sibling URL builders).
Renamed from `runtime/` in WP-B10 to break the collision with `cloud/` (the
former `cloud/runtime/`).
**Add here:** agent-runtime request/response shaping, workspace-runtime route
builders, and session-routing decisions that aren't harness-specific enough to
live in `session-client/`.

### `cloud/` (flat)
Cloud-hosted workspace runtime store: `cloud/workspace-runtime-store.ts`
and its browser test (Wave 1.5 flattened the former `cloud/runtime/`
subdirectory). Distinct from the top-level `agent-runtime/` directory above —
`cloud/` is specifically the cloud-hosted-workspace provisioning/startup store.
**Add here:** cloud-workspace-runtime-specific state, not general
agent-runtime logic (that goes in `agent-runtime/`).

### `process/` (4 files)
Process/PTY client relay: `client.ts`, `client.relay.test.ts`, `process.ts`.
Backs `claxedo-ui/workspace-panel/process-pane-panel.tsx` (kebab-cased in
Wave 1.5; see VOCABULARY.md's pane/panel note) and the process-diagnostics
dialog. **Add here:** process lifecycle/relay logic.

### `extensions/` (5 files: `app.tsx`, `index.ts`, `server.tsx`,
`server.test.ts`, `types.ts`)
Single-tenant extension accessor (`getExtensions()`/`setExtensions()`),
explicitly documented in `extensions/index.ts`'s header comment as replacing
the old `@opencode-ai/app-shared` registry. **Add here:** extension-surface
wiring only. Note: `extensions/server.test.ts` imports from `vitest` but
keeps the `.test.ts` (bun:test-signaling) suffix — a known
extension/runner-naming mismatch per the org-review appendix, not yet fixed.

### `marketplace/` (`panel.tsx`, `cards.tsx`, `filters.tsx`, `install-flow.ts`,
`confirm-dialog.tsx`, plus `AGENTS.md`)
The MCP/extension marketplace panel UI. Wave 1.5 split the former
single-god-file `marketplace-panel.tsx` into `panel.tsx` (the shell),
`cards.tsx`, `filters.tsx`, and the `install-flow.ts` logic module; Wave 2
carved out the `confirm-dialog.tsx` install-confirmation surface.
**Add here:** marketplace-panel features, continuing the pattern of extracting
pure logic into a sibling module rather than regrowing `panel.tsx`.

### `i18n/` (locale dicts `ar.ts`...`zht.ts`, `cloud-strings.ts`, `en.ts`,
plus the `locales.ts` manifest, `locale-parity.test.ts`, and
`missing-keys-baseline.json`)
Hand-edited locale dictionaries. The WP-A6 work has landed: `locales.ts` is
the locale manifest, `locale-parity.test.ts` enforces key-set parity against
`en.ts` (with `missing-keys-baseline.json` recording the currently-tolerated
gaps, shrink-only), and the earlier dead `br` locale was renamed to `pt-BR.ts`.
**Add here:** new locale strings, keeping `en.ts` as the source of truth for
key sets and registering any new locale in `locales.ts`.

### `architecture/` (`AGENTS.md` plus a growing set of scanner rules)
The structural-fitness-function suite: orphan-module detection, god-file
size ratchet, single-writer query-cache-family enforcement,
directional-layering (see above), and other numeric debt-ratchet counters.
The pattern is one manifest per scanner rule: each rule (a `*.ts` scanner
like `layering.ts`, or logic inline in its `*.guard.test.ts`) pairs with its
own `*-baseline.json` or `*-allowlist.json` recording the
currently-tolerated violations — new violations fail CI, and existing ones
may only be removed as the underlying code gets fixed, never added back.
Examples: `layering-baseline.json`, `orphan-baseline.json`,
`size-baseline.json`, `query-cache-writers.json`. Deliberately not giving an exact
file/manifest count here —
the set grows every time a new scanner rule is added, so a fixed number goes
stale immediately; count `find src/architecture -maxdepth 1 -type f` and
`*-baseline.json`/`*-allowlist.json` yourself if you need the current
number. This directory is itself sanctioned as an exception to normal test
colocation (see "Test placement standard" below) because its tests assert
repo-wide invariants with no single subject file. **Add here:** a new
structural/architectural invariant, expressed as a named scanner rule with a
baseline/allowlist, never as a feature-level source-text grep test (see
CONTRIBUTING.md's tests-as-specs standard).

### Single-file / small top-level directories with no stated policy
These exist with no documented charter (a real gap the audit calls out —
"no policy" is accurate, not an oversight in this doc):
- `assets/` (`ios.mp3`) — one static audio asset (terminal bell sound).
- `demo/` (`browser.ts`, `fixtures.ts`, `handlers.ts`, `tour-controller.tsx`)
  — demo-mode tour controller and fixtures, gated behind demo mode.
These two are legitimately small today; do not treat "single-file top-level
directory" as an invitation to create more of them — prefer adding to an
existing directory with a real charter unless the new concept is genuinely
orthogonal to all of them. (Wave 1.5 removed the other formerly-tiny
top-level directories: `analytics/` → `utils/analytics.ts`, `constants/` →
`utils/file-picker.ts`, `hooks/` → `context/use-providers.ts`, and
`vite-shims/` → `utils/lru-map.ts`.)

### Deleted directories worth knowing about
Two directories that older documentation and stale citations still reference
no longer exist:
- `overrides/` — was a tombstone directory holding only a `README.md`
  documenting the retired pre-fork override-resolution system. Wave 1.5
  deleted it (the README added nothing beyond its own explanation); that
  history now lives in CONTRIBUTING.md's "History: the override system"
  section. There is no `src/overrides/README.md` to link anymore.
- `src/e2e/` — held one file, `dialog-matrix-harness.tsx`, now moved into
  `pages/` (see the `pages/` charter above). The old `src/e2e/` vs root
  `e2e/` name collision is resolved.

## "Where do I add X" — the five commonest contribution types

1. **A new dialog or generic UI component** → `src/components/` if it is a
   direct extension of the upstream-derived dialog/component set (most
   dialogs live here); `src/claxedo-ui/components/` if it is workbench/rail
   chrome with no upstream equivalent. See `src/components/README.md` for
   the full layering rationale — this is presently a judgment call because
   the two directories are not yet cleanly separated (they still import each
   other, see the cycle above).
2. **A new locale string** → add the key to `src/i18n/en.ts` first (source
   of truth for key sets), then to every other locale file in `src/i18n/`.
3. **A new session-lifecycle or submit-pipeline behavior** → `src/session/`:
   `store/`+`submit/` for harness-agnostic lifecycle, and `composer/`+`harness/`
   +`commands/` for harness/composer-facing logic (WP-D1 consolidated these
   here from the former `session-client/` and `shell/session/`). Do not add to
   `src/session-client/` — it is now just the upstream-import barrel.
4. **A new terminal feature** → pure logic/protocol handling goes in
   `src/terminal/`; the top-level composing component is
   `src/components/terminal.tsx`.
5. **A new SolidJS provider/context** → `src/context/`. Do not create a new
   single-purpose top-level directory for one provider — the old `providers/`
   directory that did exactly that was flagged as a naming-vocab finding and
   folded back into `context/` in Wave 1.5, not a template to repeat.

## See also

- `src/VOCABULARY.md` — canonical noun list (workspace's five senses,
  harness/runner, host/toolSandbox, pane/tab/panel/group, opencode).
- `src/components/README.md` — the `components/` vs `claxedo-ui/components/`
  layering question in depth.
- `CONTRIBUTING.md` — the tests-as-specs standard and test-location
  conventions.
- `src/architecture/AGENTS.md` — the existing guard-suite's own
  owns/writerOf/mustNotImport pattern, the closest thing to a directional
  rule that exists in the repo today.
