# Claxedo App OSS-Quality Refactor — LLD (Worker Packages)

Date: 2026-07-10
Status: proposed
Scope: `packages/claxedo-app` (paths below are relative to it unless noted)
Read first: HLD `2026-07-10-001-refactor-claxedo-app-oss-quality-hld.md` (waves, vocabulary, tests-as-specs standard §5, global DoD §7)
Evidence: appendix `2026-07-10-003-claxedo-app-audit-findings-appendix.md` — each WP names its appendix section; workers MUST read that section before editing.

## How to execute (leader instructions)

Run each wave as one workflow of Sonnet workers; waves are barriers, WPs within a wave
run in parallel with **disjoint file ownership** (ownership lists below are the law —
a worker needing to touch another WP's files stops and reports instead).

Per-WP worker loop (repo `packages/claxedo-app/AGENTS.md` applies):
1. Read your WP + its appendix section + the actual source files. Source wins over plan.
2. Write/upgrade tests for intended behavior FIRST where the WP names test gaps.
3. Smallest complete change; one canonical path per responsibility; delete the losing copy.
4. Verify: targeted test files + `bun run typecheck` from `packages/claxedo-app`.
   (Do NOT run the full local vitest suite — it hangs; run explicit file lists.)
5. Report evidence: files changed, tests run + results, risks found, anything skipped + why.

After each wave: spawn 2–3 adversarial reviewers (per AGENTS.md staged shape) over the
wave's combined diff — one for correctness/regressions, one for test quality against
HLD §5, one for missed duplication/dead code in touched areas. Confirmed findings become
fix-ups before the next wave starts.

Effort tags: S ≈ ≤1h, M ≈ half-day, L ≈ 1–2 days of agent work.

---

## Wave 0 — Foundations

### WP-01 · Vocabulary, charters, and test standard docs (M)
**Appendix:** naming-vocab, architecture, tests-as-specs.
**Owns:** `src/VOCABULARY.md` (new), `src/ARCHITECTURE.md` (new), `CONTRIBUTING.md`,
`AGENTS.md` (append-only), `src/components/README.md` (new), `src/overrides/README.md`.
**Steps:**
1. Write `src/VOCABULARY.md` from HLD §4: term → definition → canonical file → what it
   replaces (include the five current senses of "workspace" explicitly).
2. Write `src/ARCHITECTURE.md`: one-paragraph charter per top-level src dir
   (components, claxedo-ui, shell, context, session, session-client, pages, terminal,
   shared, utils, pane, browser, runtime, cloud, process, providers, extensions,
   marketplace, i18n, architecture), legal import direction, and "where do I add X"
   for the 5 commonest contribution types.
3. Document components/ vs claxedo-ui/components/ layering (they are layers, not
   duplicates — components/ is the fork-era component library; claxedo-ui is the
   tab/pane app shell composing it) in `src/components/README.md`.
4. Publish the tests-as-specs standard (HLD §5 verbatim) + one exemplary template test
   into CONTRIBUTING.md; document the bun:test vs vitest file-extension convention AND
   the test-location standard (appendix-004 test-placement): colocation everywhere, the
   suffix taxonomy (`.test.ts` = bun, `.vitest.ts(x)` = vitest, qualifier segments like
   `.integration`/`.bugs`), sanctioned exceptions (`src/architecture/*.guard.test.ts`,
   per-feature ordered spec suites like workbench/tests/), and where shared fakes live
   (`src/utils/test-support/` — only fakes reused by 2+ unrelated suites).
5. Rewrite `src/overrides/README.md` for post-hard-fork reality (no packages/app,
   `@/*` → `./src/*`, no upstream diffing) or delete it if the dir is empty.
**DoD:** docs exist, cross-linked from AGENTS.md; no code changes.

### WP-02 · Architecture guards (M)
**Appendix:** architecture, tests-as-specs, platform, naming-vocab.
**Owns:** `src/architecture/**` only.
**Steps:**
1. Add a directed import-layering guard (alongside the orphan guard) failing CI on
   cycles between named top-level dirs; seed with today's `context↔shell` and
   `components↔claxedo-ui` cycles as a shrink-only baseline.
2. Add a retired-vocabulary rule: `runner`/`runnerHost` may not appear outside the one
   documented compat site (`src/utils/session-url.ts`) and labeled legacy-migration tests.
3. Rename manifests for clarity: `size-allowlist.json`→`size-baseline.json`,
   `writers.json`→`query-cache-writers.json`; update scanners.
4. Convert or delete the migration-frozen guard tests (`harness-model-key.guard.test.ts`,
   `composer-mode.guard.test.ts`, `model-key`, `p5-solid-composer`): keep only rules that
   defend a live invariant, expressed as named scanner rules, not string-pins of finished
   migrations.
5. Add a scanner rule ready to receive Wave 1/2's displaced grep-tests: raw
   `Bun.file(...).text()+toContain` assertions are forbidden outside `src/architecture/`
   (baseline = current ~49 offenders, shrink-only).
**DoD:** new guards green on current tree with baselines; `bun test src/architecture`.

### WP-03 · Test infrastructure (M)
**Appendix:** responsive, a11y, tests-as-specs, utils-shared.
**Owns:** `playwright.config.ts`, `e2e/playwright/mobile-*.spec.ts` (new),
`e2e/playwright/a11y-*.spec.ts` (new), `src/utils/test-support/` (new), `package.json`
(scripts only).
**Steps:**
1. Add a mobile Playwright project (`devices['iPhone 13']`) + smoke suite: sidebar
   drawer open/close, WorkspacePanel full-width below 640px, chat scroll. Expect and
   mark known failures (multipane, DnD) as `test.fixme` — they become Wave 3's gate.
2. Add an axe-core sweep spec over: home, session page, settings dialog, command
   palette, prompt input focused. Baseline current violations shrink-only if needed.
3. Add `src/utils/test-support/mock-api.ts` shared fixture replacing the hand-copied
   `mock.module("./api")` blocks (consumers migrate in Wave 2).
4. Rename script `test:ui`→`test:vitest`; name live-credential e2e specs with a
   `.live.spec.ts` suffix and exclude them from the default project.
**DoD:** `bunx playwright test --project=mobile` and the axe spec run (with fixmes);
typecheck green.

---

## Wave 1 — Mechanical cleanup (parallel)

### WP-A1 · Dead code sweep (S)
**Appendix:** utils-shared, components, ui-misc, context, i18n, terminal, architecture.
**Owns (deletions only, plus their importers' import lines):**
`src/utils/{agent-cache,aim,runtime-adapters,terminal-writer,local-selection-handoff,project-meta-cache,index}.ts`,
`src/components/debug-bar.tsx`, `src/context/index.ts`, dead `SwitcherKind` variants in
`src/claxedo-ui/compact-switcher/switcher-items.ts`, `ServerConnection.Sidecar/Ssh` in
`src/context/server.tsx`, `src/terminal/terminal.connection.test.tsx` (fold unique
assertions into `terminal-connection.test.ts` first), dead `onTerminalResponse` path in
`src/terminal/backend/xterm.ts`, `language.uk` key in `src/i18n/en.ts`, stale
`dist-desktop`/`dist-opencode` dirs + their gitignore stanzas (confirm no script
produces them, incl. claxedo-desktop's prebuild/predev).
**Step:** verify zero importers (grep) per file → delete → typecheck → add a
SwitcherKind↔ContentType parity test so dead variants can't drift back silently.
**DoD:** typecheck green; a grep for each deleted symbol returns nothing.

### WP-A2 · Shell alias-pair collapse (M)
**Appendix:** shell.
**Owns:** `src/shell/identity/legacy-resolver.ts(+test)`, `src/shell/data/bootstrap.ts`,
`src/shell/data/directory-cache-manager.ts`, plus call-site import lines app-wide.
**Steps:** collapse the 4 duplicate-name pairs in legacy-resolver.ts (keep
`isFilesystemDirectory`, `workspaceIdFromRef`, `isUserHostedWorkspaceDirectory`, per
appendix rename table); pick one name for `bootstrapGlobal`/`bootstrapDirectory` and
`createDirectoryCacheManager`; delete losing aliases + redundant test assertions;
rename `contributions/legacy-command.ts`→`compat-command-trigger.ts`.
**DoD:** one exported name per function; all call sites migrated; shell tests green.

### WP-A3 · page-editor file renames (S)
**Appendix:** ui-components, responsive.
**Owns:** `src/claxedo-ui/components/tab-page-utils.ts(+.test)`,
`tab-page-state-flow.test.ts`, `tab-page.integration.vitest.tsx`, `tab-page.css`, importers.
**Step:** rename all `tab-page-*` → `page-editor-*` (incl. css) to match the PageEditor
component; update imports.
**DoD:** `grep -r "tab-page" src/` → zero hits; renamed tests green.

### WP-A4 · Portal-slot unification (M)
**Appendix:** ui-components, components.
**Owns:** `src/claxedo-ui/components/{browser-toolbar-slot,review-toolbar-slot,review-tab-header-slot}.ts`,
new `src/claxedo-ui/components/portal-slot.ts`, `src/components/titlebar.tsx` +
`src/components/session/session-header.tsx` (slot contract only).
**Steps:** one `createPortalSlot(name)` factory replacing the three copies; migrate the
`getElementById("opencode-titlebar-left/center/right")` string contract between
titlebar.tsx and session-header.tsx onto typed slots; spec-test the factory
(set/clear/single-binding semantics).
**DoD:** three duplicate modules deleted; no `opencode-titlebar-` DOM-id strings remain.

### WP-A5 · Terminal-fit event centralization (S)
**Appendix:** ui-layout, ui-misc.
**Owns:** `src/claxedo-ui/terminal/terminal-fit.ts` + every dispatch site (~6:
`WorkspacePanel.tsx`, `rail-sidebar-shell.tsx`, `rail-workbench-canvas.tsx`, others per grep).
**Steps:** export `FIT_EVENT` const + the dispatch helper; route all callers through it;
rename the raw string event away from `opencode:` prefix (`claxedo:terminal-fit`) in the
same pass; behavior test: helper dispatch received by a listener.
**DoD:** the string literal appears exactly once in src.

### WP-A6 · i18n tooling + dead keys (M)
**Appendix:** i18n.
**Owns:** `src/i18n/**`, `src/context/language.tsx`.
**Steps:** delete verified-unused `cloud-strings.ts` keys incl. the "Legacy project
strings" block; add `src/i18n/locales.ts` manifest ({code, loader, intlTag, labelKey,
matches}) and derive language.tsx's five hand-synced structures from it; add a parity
test failing on (a) keys missing vs en.ts, (b) `{{placeholder}}` token mismatch,
(c) manifest/file drift (both this dir and @claxedo/ui's i18n); backfill or explicitly
baseline the 36 missing keys; rename `br.ts`→`pt-BR.ts` if the code is wrong.
**DoD:** parity test green and wired into the default test run.

### WP-A7 · Shared-helper dedup (M)
**Appendix:** utils-shared.
**Owns:** `src/utils/{api,worktree,same}.ts`, `src/shared/query/{keys,utils,inventory,directory,shell,agent-config-routes,project-meta,control-plane}.ts`.
**Steps:** consolidate URL normalization onto `utils/api.ts`'s `normalizeUrl` (5+ sites);
delete duplicate `cmp()` in inventory.ts and `sameQueryKey()` in worktree.ts; extract the
copy-pasted 3-way transport branch from `agentListQuery`/`commandListQuery` into one
helper with a drift-proof spec test; remove hardcoded E2E-test substrings from
production project filtering in control-plane.ts.
**DoD:** each deduped helper has exactly one definition; shared/query tests green.

### WP-A8 · Fork-legacy strings and links (S)
**Appendix:** components, pages, ui-layout, session.
**Owns:** string/identifier literals only in: `src/pages/error.tsx`,
`src/claxedo-ui/claxedo-layout-actions/project-actions.tsx`, `src/components/terminal.tsx`
(localStorage key + migration read), `src/components/dialog-select-server.tsx`,
`src/components/prompt-input/submit.test.ts` (test names only).
**Steps:** feedback + help links → Claxedo docs/channels; `opencode.pty.{id}.reload`→
`claxedo.pty.{id}.reload` with one-time read-old-write-new migration; DEFAULT_USERNAME
"opencode"→neutral; rename "runner" wording in submit.test.ts test names to "harness"
(names only — assertions untouched).
**DoD:** no user-visible opencode branding outside deliberate compat surfaces.

---

## Wave 1.5 — Organization moves (parallel; runs AFTER Wave 1, BEFORE Wave 2)

Source: org-review appendix `2026-07-10-004-claxedo-app-org-review-appendix.md` (each WP
reads its sections, including the proposed-tree sketches). These are move/rename-only
packages: `git mv` + import updates + test-file moves — **no behavior changes**. They run
as their own batch so Wave 1's renames land first and Wave 2's deep refactors operate on
the final tree. Verification per WP: typecheck + the moved files' tests + a grep proving
the old paths are gone.

### WP-ORG-1 · Root topology (M)
**Appendix-004:** root-topology, test-placement. **Owns:** the moved/deleted dirs + importers.
Steps: delete `src/overrides/` (fold its README's historical content into CONTRIBUTING.md);
merge single-file top-level dirs: `providers/claxedo-events.tsx`→`context/`,
`pane/store/pane-preferences.ts`→`claxedo-ui/state/`, `analytics/posthog.ts`→`utils/analytics.ts`,
`constants/file-picker.ts`→`utils/`, `hooks/use-providers.ts`→`context/`,
`vite-shims/lru-map-default.ts`→`utils/lru-map.ts` (update the vite alias);
flatten `cloud/runtime/`→`cloud/workspace-runtime-store.ts` and relocate the unrelated
`agent-event-runtime.browser.test.ts` (→ `architecture/` or beside global-sdk.tsx);
move `src/e2e/dialog-matrix-harness.tsx`→`src/pages/` (it is a production route; kills
the src/e2e vs root e2e/ name collision); move the 3 root `e2e/restoration-e2e-*.spec.ts`
into `e2e/playwright/` and `e2e/playwright/real-provider-preflight.test.ts`→`e2e/bun/`.
Result target: src/ top level drops from 28 dirs to ≤20, every survivor a real subsystem.

### WP-ORG-2 · claxedo-ui reorganization (L)
**Appendix-004:** claxedo-ui-org, test-placement. **Owns:** `src/claxedo-ui/**` minus components/.
Steps: rename `layout/`→`workbench/` (its own main file is workbench.tsx) and
`layouts/`→`rail/` — kills the one-letter collision; move the loose
`claxedo-layout-actions.tsx` into the same-named dir as `index.ts` and rename the dir
`layout-actions/` (drop the product-prefix stutter; same for `claxedo-layout-commands.ts`,
which moves next to `rail/rail-keyboard-commands.ts`); `claxedo-layout.css`→`app-shell.css`
(it is global chrome CSS, not engine styling); move the 21 `context/harness-*` files to a
new `claxedo-ui/harness/` (27 of 31 files in context/ are the harness subsystem, not
SolidJS contexts), leaving context/ with its 5 real providers; root strays
`session-title-sync.ts` + `workspace-scope-ids.ts` (+tests)→`utils/`;
flatten `state/tests/` (3 files colocate with their subjects); kebab-case the PascalCase
outliers in `workspace-panel/` and `compact-switcher/`; `state/process-pane.ts`→
`process-pane-slice.ts` (vs context/process-pane.tsx same-name trap); `styles.css`→
`pane-controls.css` (57 lines, only touches .pane-ctrl-icon).
Decision recorded here: `workbench/tests/` keeps its lettered A–N spec files (sanctioned
ordered-spec suite) but gains a README naming the convention.

### WP-ORG-3 · Feature folders (L)
**Appendix-004:** claxedo-ui-org, components-pages-session-org. **Owns:**
`src/claxedo-ui/components/**`, `src/components/**` (moves only), `src/marketplace/**`.
Steps: in claxedo-ui/components — create `page-editor/` (the verified 20-file slice incl.
slash-commands, mermaid-block, status-editor-dialog, page-index) and `review-workspace/`
(15-file slice incl. claxedo-session-review.tsx) feature folders; split `dialogs.tsx`'s
3 inline dialogs into `dialogs/` with one file each. In components/ — `dialogs/` (24
dialog-* files, drop the prefix inside the folder), `settings/` (15 settings-* +
network-policy-settings cluster), `titlebar/` (5 files), flatten `server/server-row.tsx`
up and delete the dir; `session.ts`→`session/index.ts`;
`session-client/session-ui.barrel.ts`→`index.ts` (kill the one-off .barrel.ts suffix);
pick ONE "extracted pure logic" suffix (`-logic.ts`) and apply to the mixed
-core/-helpers/-form strays; `pages/session/handoff.ts`→`prompt-preview-handoff.ts`.
Marketplace: `marketplace-panel.tsx` becomes `marketplace/{panel,filters,cards,install-flow}`
skeleton ONLY if WP-B10 hasn't run yet — otherwise skip (B10 owns the real split).

### WP-ORG-4 · Cross-boundary moves + test placement (M)
**Appendix-004:** shell-context-org, support-dirs-org, test-placement. **Owns:** the named files.
Steps: move the files whose own `// target-layer:` comments point at shell/data —
`context/global-sdk-fetch.ts`, `context/global-sync/{bootstrap-orchestrator,event-ingress,inventory-source,session-filter}.ts`,
`context/global-sdk-event-fetch.ts` — into `shell/data/` (turns the known context↔shell
cycle into one-directional; coordinates with WP-02's baseline, which should shrink);
`shell/chrome/app-state-snapshot.ts`→shell root, then rename `shell/chrome/`→`shell/review/`
and `shell/state/`→`shell/connection/`; move `pages/session/{session-layout,helpers}.ts`
to the session domain (they're imported by components/session — backwards layering);
`components/dialog-select-directory-routes.ts`→`utils/`;
`components/dialog-provider-stack.vitest.tsx`→packages/ui (it tests that package's dialog
context) or rename to state its integration nature; terminal: create `terminal/integration/`
for the 6 cross-module scenario tests, `terminal-backend.d.ts`→`backend/`,
`utils/terminal-websocket-url.ts`→`terminal/`.
Test hygiene: relocate `claxedo-ui/layouts/review-mount-retention.vitest.tsx`→
`shell/review/` beside its subject; fix the two runner-suffix liars
(`extensions/server.test.ts`→`.vitest.ts`, `navigation-islands/session-navigation.test.ts`→
`.vitest.ts`); rename `utils/resolve-runtime-target.test.ts`→
`workspace-runtime-request.test.ts`; fix the three files whose docstrings cite the
deleted `rail-layout.tsx` (point at rail-sidebar.tsx / app-shell-layout.tsx);
rename mis-named `shell/harnesses/profile.test.tsx`→`.test.ts` and the misfiled
open-sessions / session-inventory tests to colocate with their subjects.
(`workspace-project-integrity.test.ts`'s move to `context/layout-projects.test.ts`
belongs to WP-B2's rewrite of it — leave the file alone here.)

---

## Wave 2 — Directory deep refactors (parallel, one worker per WP)

Common contract for every B-package: extract pure logic into tested modules following
the directory's own best-in-class siblings; split god files behind an unchanged public
surface; replace in-scope grep-tests with behavior specs (move any real boundary rule to
the WP-02 scanner); close the WP's named test gaps with HLD §5-grade tests; delete
superseded copies. Verify with the WP's test list + typecheck; browser-verify anything
touching layout/chat/terminal visuals.

### WP-B1 · claxedo-ui/components (L)
**Appendix:** ui-components. **Owns:** `src/claxedo-ui/components/**` (minus WP-A3/A4
files; WP-ORG-3 has already grouped these into `page-editor/`, `review-workspace/`, and
`dialogs/` folders — operate on the new paths).
Key steps: split `dialog-process-diagnostics.tsx` (1050) into `process-diagnostics/`
with pure, tested `groups.ts` (buildExternal/groupStatus/scoring — this logic decides
what gets SIGKILLed; test before touching); unit-test `page-editor-ai.ts`'s
createPageEditorAiActions (session-creation fallback, run-invalidation, abort path);
test + split `page-arena-dock.tsx`'s SSE parser and start/stop/pause/retry machine;
replace `page-index.test.ts`'s fake "optimistic mutations" block with real
movePage/dropPage rollback-on-error tests; make `slash-commands.test.ts` invoke the
shipped filter; deepen `claxedo-session-review` coverage (line-comment CRUD,
focus-scroll, expand/collapse, large-diff override); add tests for
`retain-mounted-tabs-policy.ts` and `add-process-dialog.tsx`; keyboard equivalents for
mermaid zoom/pan; replace `window.prompt()` in slash-commands with the app dialog pattern.

### WP-B2 · claxedo-ui layout engine + layouts (L)
**Appendix:** ui-layout, architecture, responsive. **Owns:** `src/claxedo-ui/layout/**`,
`src/claxedo-ui/layouts/**`, `src/claxedo-ui/claxedo-layout-actions/**`,
`src/claxedo-ui/claxedo-layout-commands.ts`.
Key steps: extract `ProjectItem/SessionItem/WorkspaceItem/WorkspaceInfo` from
rail-sidebar.tsx into a dependency-free `layouts/domain-types.ts` (fixes the
dependency inversion for the whole actions layer); split rail-sidebar.tsx (2684) into
`rail-sidebar/{index,session-list,view-persistence,workspace-status,filter-menu}`;
replace `workspace-project-integrity.test.ts`'s 1186 lines of hand-copied shadow logic
with imports of the real functions (this is the audit's only CRITICAL test finding);
reconcile the two keyboard systems' double-bound mod+w / mod+alt+Arrow into one
dispatch path (full registry consolidation is WP-C2 — here just eliminate the
double-binding with an integration test proving no double-fire); ARIA + keyboard for the
pane resize divider; fix Help link if WP-A8 didn't own it. Directory renames
(layout→workbench, layouts→rail) already landed in WP-ORG-2 — operate on the new paths;
when rewriting workspace-project-integrity.test.ts, relocate it to its subject
(`context/layout-projects.test.ts` per appendix-004 test-placement).

### WP-B3 · claxedo-ui misc (M)
**Appendix:** ui-misc. **Owns:** `src/claxedo-ui/{workspace-panel,compact-switcher,content-renderers,navigation-islands,utils}/**`.
Key steps: shared row primitive for session/terminal navigation rows (native `<button>`,
drag wiring, status dot — coordinates with WP-C1's semantics, land the primitive now);
dedup process-status color/label tables; merge `terminal-session-preview.ts` +
`terminal-log-summary.ts` cache/transport plumbing; extract terminal-id-swap helper in
terminal-content.tsx; keyboard resize for the workspace-panel separator; component
tests for WorkspaceFilesNavigator/WorkspaceProcessesNavigator; unit-test
`buildScreenshotAttachment()`; split `utils/text.ts`; rewrite the Bun.file-grep test in
`pane-terminal-recovery.test.ts` as a behavioral shared-inflight test.

### WP-B4 · components/ (L)
**Appendix:** components, a11y. **Owns:** `src/components/**` (minus prompt-input ARIA
work reserved for WP-C1 and files owned by A4/A8).
Key steps: **terminal.tsx (1194, zero tests) is the priority** — extract and spec-test
the reconnect/backoff, buffer-restore ordering, resize-desync recovery, and
initial-command gating against a fake WebSocket (build on @claxedo/terminal pure
helpers; run the perf harness after); split titlebar.tsx into legacy/v2 behind a thin
switcher, delete the broken DesktopTitlebarIconButton stub, schedule legacy removal;
test file-tree.tsx's exported pure helpers + add role=tree/treeitem/aria-expanded and
arrow-key navigation; add labels to settings-general/dialog-select-file controls; split
`submit.ts`'s PromptSubmitInput flag bag into cohesive sub-objects and carve
submit.test.ts (2826) into per-concern suites on the WP-03 shared fixture.

### WP-B5 · shell/ (M)
**Appendix:** shell. **Owns:** `src/shell/**` (minus WP-A2 files),
`src/session-client/harness/profile.ts` (read-only reference for the kind-unification).
Key steps: unify harness-kind vocabulary into one source of truth consumed by
`shell/harnesses/profile.ts`, `shell/identity/session-ref.ts`,
`session-client/harness/profile.ts`; replace the unchecked `as HarnessKind` cast in
durability/projections.ts with a validating parse + round-trip tests for 'pi'/'cursor-sdk';
extract one shared workspace-meta-from-group constructor (4 inline copies in
queries.ts + inventory-writers.ts); replace the source-regex "loopback inventory"
test with a real merge-path scenario; dedupe the splice+trim+cleanup block in
session-list-events.ts; add a dedicated rehydrator.ts spec.

### WP-B6 · context/ (M)
**Appendix:** context. **Owns:** `src/context/**` (minus WP-A1 deletions).
Key steps: split layout.tsx (964) into UI-panel-state provider + project-catalog module
(test the two createEffect blocks' sandbox-to-parent resolution and color assignment);
extract global-sdk.tsx's (870) SSE reconnect/backoff/coalescing engine into a typed
module with fake-timer spec tests (reconnect schedule, heartbeat timeout, event
coalescing, dispose); collapse useQueryOptions/useShellQueryOptions to one definition
site; rename `local.tsx`→`session-selection.tsx` and `command-upstream.tsx`→
`command-palette.tsx`; replace live-resource grep-tests with real acquire/release
dispose-once tests.

### WP-B7 · terminal/ (L)
**Appendix:** terminal, a11y. **Owns:** `src/terminal/**` (minus WP-A1 deletions).
Key steps: split helpers.ts (907) into `renderer.ts` / `keyboard.ts` / `clipboard.ts` /
`resize-handlers.ts` — landing INSIDE `backend/`, of which helpers.ts is already an
undeclared part (appendix-004 support-dirs-org) — with matching spec files; direct tests for setupResizeHandlers
(ResizeObserver wiring, fontSize-nudge, retry-fit exhaustion) and loadRenderer (WebGL
probe, MAX_WEBGL_RENDERERS ceiling, coarse-pointer fallback) via jsdom + fake
ResizeObserver; make capability-responder.ts the single OSC 10/11 implementation
(WP-A1 deletes the dead path — add the drift-proof test here); refactor
FilePathLinkProvider to extend MultiLineLinkProvider; add a real screen-reader-mode
toggle (config + settings surface) instead of hardcoded false — full addon-a11y wiring
lands in WP-C1; rename `terminal-tui.ts`→`reconnect-heuristics.ts`. Run the perf
harness after renderer/resize changes.

### WP-B8 · pages/ (L)
**Appendix:** pages. **Owns:** `src/pages/**`.
Key steps: extract session.tsx (1547) and message-timeline.tsx (1725) stateful-pure
logic (scroll-anchor cursor, diff-tree kinds, keyboard dispatch, title-edit reducer,
archive-next-sibling selection) into tested modules beside view-state.ts; dedupe
title-edit / archiveSession / previewPrompt+handoff into one owned module consumed by
all three current copies (incl. session-composer-region.tsx); split both god components
into single-purpose subcomponents; replace override-batch-contract.test.ts's
string-grep suite (real rules → WP-02 scanner); spec-test error.tsx's
formatErrorChain/formatInitError/safeJson (9 InitError variants, cycle detection);
test cli-login.tsx's localhost restriction + token exchange; test
session-question-dock keyboard contract; `Page()`→`SessionPage()`; normalize
same-package imports to relative paths.

### WP-B9 · session/ + session-client/ (M)
**Appendix:** session. **Owns:** `src/session/**`, `src/session-client/**` (minus B5's
profile.ts read).
Key steps: decompose session-controller.ts (1079) by concern (active-status-polling,
history-pagination, hydration-gate, capabilities-todo-sync) behind the unchanged
createSessionController surface, with direct effect-wiring tests; collapse the two
submit-directory resolvers (resolve.ts vs workspace-resolver.ts) into one decision
function — or an orchestrator/sub-decision split with a property test proving agreement
on shared inputs; extract "big-pickle" into a documented named constant
(SIGNED_WORKSPACE_DEFAULT_MODEL) with failure-mode test; rename syncCompat* →
syncSession*; replace in-scope grep-tests. (Real import-boundary enforcement for
session-client = WP-D2; do not start it here.)

### WP-B10 · platform dirs (M)
**Appendix:** platform. **Owns:** `src/{browser,runtime,cloud,process,providers,pane,extensions,marketplace,demo}/**`.
Key steps: split agent-runtime-client.ts's routing into an explicit, testable placement
table; rename `src/runtime`→`src/agent-runtime` (or session-transport) to break the
collision with `src/cloud/runtime`; unify AgentRuntimeWorkspaceKind/SignedWorkspaceKind
into one WorkspaceKind; split marketplace-panel.tsx (1074) — data layer with unit tests,
app-dialog confirms replacing native confirm(); spec-test ClaxedoEventsProvider's
reconnect/backoff/heartbeat machine; add origin check to DemoTourController's window
message listener; fold providers/claxedo-events into context/ per WP-01 charter (or
document why not); add per-dir AGENTS.md ownership notes.

### WP-B11 · claxedo-ui state + context (L)
**Appendix:** ui-state. **Owns:** `src/claxedo-ui/state/**`, `src/claxedo-ui/context/**`,
`src/claxedo-ui/{session-title-sync,workspace-scope-ids}.ts`.
Key steps: the harness-config test suite (harness-config.test.ts, 1031 lines/82 tests,
plus ~11 sibling harness-*.test.ts files) is dominated by Bun.file grep-assertions —
delete or convert each: real invariants ("store facade never touches localStorage")
become runtime assertions against injected fakes; file-placement rules go to the WP-02
scanner; freed real estate funds behavior specs for switch/hydrate/model-write races
and error paths. Split `context/process-pane.tsx` (1007) along its internal seams
(HTTP client + timeout wrapper, 5 SSE handlers, wake-detector, imperative
start/stop/restart API) composed the way harness-config-store.ts already composes its
modules; split `state/route-bridge.tsx` (785) into resolution / deep-links /
title-badge-sync modules. Fix the two module-level singleton Maps
(`route-intent.ts` closedRouteKeys, `workspace-panel.ts` sessionPanelSnapshots —
the latter has NO eviction: an unbounded leak in long-running Electron): lift into
provider-instance scope or add bounded eviction, with a test asserting the bound.
Add direct fake-timer specs for the two riskiest untested state machines:
`state/rail.ts` hover/hot-zone/mute/cooldown and `state/terminal.ts` lifecycle
transition table + process-pty expect/resolve counters (incl. the bare 15s setTimeout
at terminal.ts:92 — give it onCleanup). Rename harness-config.test.ts →
harness-config-store.test.ts (no harness-config.ts exists).

---

## Wave 3 — Product-goal features

### WP-C1 · Accessibility remediation (L)
**Appendix:** a11y. **Owns:** `src/components/prompt-input/{frame,slash-popover}.tsx`
(ARIA only), `src/claxedo-ui/workspace-panel/WorkspacePanel.tsx` (separator),
navigation row components (semantics), `src/pages/session/composer/session-question-dock.tsx`,
terminal a11y wiring, `src/components/dialog-release-notes.tsx`, e2e a11y specs.
Steps: full combobox/listbox ARIA on @-mention and slash popovers (aria-expanded/
controls/activedescendant, arrow-key aria-selected) + vitest specs; ArrowLeft/Right +
aria-valuenow on resize separators; native `<button>` + aria-current on rows (on
WP-B3's primitive); labelled group + roving tabindex on question dock; wire
`@xterm/addon-a11y` behind WP-B7's toggle; pause control on the release-notes video;
JS-side prefers-reduced-motion helper; promote WP-03's axe sweep from baseline to
enforced for touched surfaces.

### WP-C2 · Keyboard-shortcut consolidation (L)
**Appendix:** a11y, ui-layout. **Owns:** `src/context/command.tsx`,
`src/claxedo-ui/layout/keyboard.ts`, `src/claxedo-ui/layouts/rail-keyboard-commands.ts`,
`src/claxedo-ui/claxedo-layout-commands.ts`.
Steps: one command-registry-backed dispatch path for all shortcuts (UI, voice, remote,
server-pushed use the same typed command path per AGENTS.md); collision detection test
enumerating the full binding surface; discoverability surface (command palette lists
bindings); delete the parallel systems after migration. Behavior decisions (which mod+w
semantics win) get recorded in the WP report.

### WP-C3 · Responsive/mobile (L, may split into 3 workers by surface)
**Appendix:** responsive. **Owns:** `src/claxedo-ui/layout/workbench.tsx` (interaction
layer), DnD call sites, `src/claxedo-ui/claxedo-layout.css` + `tab-page.css` (breakpoints;
note WP-A3 renamed it page-editor.css), terminal mobile surface, mobile e2e specs.
Steps: pointer-events-based (or library) touch-capable reorder/split replacing/augmenting
native HTML5 DnD; narrow-viewport workbench collapse mode (single-pane + switcher —
design note required before code); terminal accessory key row (Esc/Tab/Ctrl/arrows) for
soft keyboards; one breakpoint token set aligned to the Tailwind scale replacing ad hoc
420/639/767/900/1200; convert WP-03's `test.fixme` mobile specs to enforced; replace the
vendored-package compiled-class CSS override in styles.css with a supported hook while in
the file.

---

## Wave 4 — Structural migrations (serialize, one at a time)

### WP-D1 · Session-domain consolidation (L)
Pick the one home (per HLD: `src/session/{store,submit,composer,harness,commands}`),
migrate `session-client/` and `shell/session` content additively, repoint imports,
delete old paths, update charters + layering baseline. Gate: Wave 2 landed.

### WP-D2 · Real session-client boundary (M)
Collapse the `@claxedo/*`≡`@/*` tsconfig alias duplication; give the (post-D1) client
layer a real path + WP-02-enforced import rule (no pane/, shell/, claxedo-ui/, root
context/); shrink composer-isolation mocks as proof (~20 → single-digit).

### WP-D3 · utils/ dissolution (M)
Execute the full cluster→home map in appendix-004 support-dirs-org (its proposed_tree
table is the authority): route-audit test → WP-02's scanner framework (split by concern);
TanStack cache accessors + directory-config-cache → `shared/query/`; transport/infra
(workspace-relay-connection, workspace-runtime-request, workspace-control-routes) →
`runtime/`; backend clients (api.ts, convex-client, auth-client, prompt.ts, worktree.ts)
→ `shared/data/`; split pages-api.ts into pages-api + arena-api; keep a slim utils/ of
dependency-free primitives only; close remaining test gaps (auth-client, prompt.ts,
scoped-cache, server-errors, diffs). Also split `shared/query/utils.ts` into
`sort.ts` + `provider-list.ts` and document shared/'s charter (data = wire shapes +
transport; query = TanStack wrappers) in `src/ARCHITECTURE.md`.

### WP-D4 · Package scope rename @opencode-ai/* → @claxedo/* (M, repo-wide)
claxedo-app/server/desktop/web package.json names + all cross-package references +
lockfile. Coordinates outside claxedo-app; solo change, own PR.

### WP-D5 · workspace vs directory identifier split (L, highest risk)
Disambiguate the directory-path sense from the control-plane-id sense of
workspaceId (HLD §4); align with plan `2026-07-09-001-refactor-host-owned-runtime-state`
and the known directory-string-routing debt (~44 sites). Requires its own detailed
design note before execution; do not improvise this one.

---

## Wave 2 written waivers (leader, 2026-07-11 — per goal DoD "fixed or waived in writing")

Low-severity review findings waived after live-tree verification (full triage table in the
session record; verdicts re-checked against the post-fix-up tree):
- W1. resolveSandboxRootActions idempotence: adversarial non-idempotent `rootFor` case
  untested; catalog's rootFor is single-level by construction — latent-risk note only.
- W2. loadRenderer WebGL ceiling/dispose internals + screenReaderMode seed untestable
  without module mocking; decision table covered; perf harness gates regressions.
- W3. size-baseline pins 8/1 lines above actual for two files — ceilings, not pins; passes.
- W4. useQueryOptions/useShellQueryOptions dual definition — deliberate deferral to
  D2/D3; the split is itself enforced by the route-audit suite.
- W5. window.prompt in slash-commands — deferred to WP-C1 dialog work.
- W6. add-process-dialog / review-session CRUD DOM tests — heavy Solid-mount cost;
  pure logic covered.
- W7. file-tree DOM keyboard adapter untested (pure resolveTreeKeyAction covered) —
  integration-mount effort, not a quick fix.
- W8. rail-width vitest re-implements the inline derivation — real fix requires extracting
  the binding from app-shell-layout.tsx first (D-wave scale).
- W9. desktop last-pane Quit keyboard reachability — handed to WP-C2 with the registry
  consolidation; palette path exists.
- W10. route-bridge.tsx component-internal wiring untested (resolution logic + deep-links
  covered in extracted modules) — Solid-mount integration test deferred.
- W11. review finding "history-window 2 failures" — FALSE POSITIVE (reviewer ran bun
  test without --conditions=browser; suite is 186/0 with correct flags).

## Dependency notes
- **Leader re-scope 2026-07-11 (Wave 0 dispatch):** the live e2e session (separate
  thread) owns `e2e/**`, helpers, perf-harness, `.github/workflows/test.yml`, and the
  pending debt-ratchet baseline bump. Consequences: (a) WP-02 **step 3** (manifest
  renames `size-allowlist.json`→`size-baseline.json`, `writers.json`→
  `query-cache-writers.json`) is deferred until that session's baseline commit lands;
  (b) WP-03 is split — **WP-03a** (`src/utils/test-support/mock-api.ts` fixture) runs in
  Wave 0 now; **WP-03b** (mobile Playwright project, axe sweep, `playwright.config.ts`,
  `test:ui`→`test:vitest` script rename, `.live.spec.ts` naming) is dispatched only
  after the e2e session lands. Wave 0's gate item "mobile project + axe sweep run"
  transfers to the WP-03b dispatch.
- **Leader re-scope 2026-07-11 (fixme-ledger reconciliation):** see
  `2026-07-11-002-fixme-ledger-wp-reconciliation.md` — the authoritative map from e2e
  `test.fixme` pins to WPs; flipping a pinned fixme IS the WP's falsifiable evidence.
  Ownership additions: `src/app.tsx`, `src/main.tsx`, `src/index.tsx` → **WP-B8**;
  `src/shared/query/session-list.ts` (+ its confirmed `mergeSessionListResponses`
  stale-nextCursor bug, pinned by core-sidebar-tree:671) → **WP-A7** with a named test
  gap. Out-of-scope orphan bugs (agent-event-runtime projection, claxedo-mcp routes,
  session-ui part renderers, agent-sdk-runtime codex driver) are spun off to separate
  sessions — not any WP's job.
- WP-02's layering guard baseline must land before Wave 2 so B-packages can only shrink it.
- Wave 1.5 (WP-ORG-*) runs strictly after Wave 1 (renames first, then moves) and strictly
  before Wave 2 (deep refactors operate on the final tree). Within 1.5 the four packages
  are disjoint; WP-ORG-4's shell/data moves should shrink WP-02's context↔shell baseline.
- Wave 2+ WPs reference PRE-move paths in their prose where written before Wave 1.5
  executed — workers resolve against the actual tree and the appendix-004 rename maps.
- WP-B3's row primitive precedes WP-C1's row semantics (same files otherwise — that's why rows land in B3 and only ARIA polish in C1).
- WP-B7's a11y toggle precedes WP-C1's addon-a11y wiring.
- WP-A3 renames tab-page.css; WP-C3 must reference page-editor.css.
- WP-D1 → WP-D2 strictly ordered. WP-D4/D5 land solo, last.
