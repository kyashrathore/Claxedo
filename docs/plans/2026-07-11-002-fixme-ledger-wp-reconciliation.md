# Fixme Ledger ↔ WP Reconciliation (Wave −1 carry-over)

Date: 2026-07-11
Produced by: leader-dispatched read-only reconciliation agent; leader-reviewed.
Purpose: each `test.fixme` in `packages/claxedo-app/e2e/playwright/*.spec.ts` that pins a
real app bug is a ready-made falsifiable evidence channel — the WP that fixes the bug
flips the fixme to green instead of manufacturing fresh proof. This doc maps every fixme
to its owning WP (LLD `2026-07-10-002`) and audit finding (appendix `2026-07-10-003`).

Headline numbers: 56 `test.fixme(` sites (50 in `core-*`, 6 in `live-*`); ~24 are
confirmed real app bugs/gaps; the rest self-describe as harness/env limitations,
unreachable states, fixture gaps, or deferrals. **Zero** fixme-pinned behavioral bugs are
directly named in the audit appendix — where overlap exists the audit only flagged the
containing file as god-file/untested. Every "related:" row below is a WP whose appendix
section under-states a concrete, already-reproduced defect in its files.

Paths relative to `packages/claxedo-app` unless prefixed `packages/`.

| spec file | test title (trunc) | cited source file:line | bug one-liner | owning WP | audit finding ref |
|---|---|---|---|---|---|
| core-boot-deep-links-home:436 | Home lists recent projects, Open project dialog — b3 | claxedo-ui/layouts/rail-workbench-shell.tsx:96; pages/home.tsx; rail-workbench-canvas.tsx:41-51; rail-empty-draft-controller.ts:40; claxedo-layout-actions/project-actions.tsx:96-150 | Home `/` surface is permanently display:none dead code; real `/` renders draft composer | WP-B2 (+B8 home.tsx) | not-in-audit |
| core-busy-abort-errors:948 | escalation ladder reaches failed stage w/ Cancel+Retry — b8 | session/store/session-status-dispatcher.ts:15,168-182 | not app bug: failed stage needs 5-min wall clock; no test time-scale knob | WP-B9 | not-in-audit |
| core-cloud-offline-roles:797 | live role flip viewer→editor unlocks composer — b9 | utils/api.ts:107-118,211-224,246-254; utils/workspace-runtime-request.ts:220-244; shell …connection.ts:307-337 | harness limitation: loopback host never fires /connection/refresh; needs e2e seam on getClaxedoServerUrl() | WP-A7/WP-D3 (utils), WP-B5 (shell) | not-in-audit |
| core-cloud-provisioning:645 | cloud create failure: one toast, no pipeline/session — b6 | components/prompt-input/submit-directory.ts:125-137 | REAL BUG: .catch() shows toast then returns undefined → falls into !workspaceId branch → duplicate second toast | WP-B4 | related: session §two-independent-resolve-submit-directory-trees |
| core-composer-modes:420 | Escape aborts in-flight turn — b8 | pages/session/composer/session-composer-region.tsx (~301); session-client/composer/composer.tsx:323; prompt-input-props.ts:48-51; pages/session.tsx (~1488) | REAL BUG: SessionComposerRegion never passes status/activeTurn → composer stuck idle, no busy/stop on first send | WP-B8 (cause), WP-B9 (composer) | not-in-audit |
| core-composer-modes:527 | sent optimistic user msg highlights agent mention — b11 | shell/chat/opencode-conversation.ts:217-265,325-369; components/prompt-input/build-request-parts.ts:120-131; pages/session/message-timeline.tsx:428; packages/session-ui …message-part.tsx:1201,1350-1385 | REAL BUG: Part↔UIMessage projection has no `type==="agent"` case either direction; mention parts silently dropped | WP-B5 (cause) | not-in-audit |
| core-composer-modes:679 | comment-linked chips hidden in shell mode — b19 | session-client/composer/composer.tsx:388-392 | not app bug: gating correct; chip creation needs line-comment UI outside spec scope | WP-B9 | not-in-audit |
| core-harness-ownership-cloud:603 | each harness owns label/model/payload over relay — b1 (×6) | context/global-sdk.tsx:363-366; shell/chat/opencode-conversation.ts:134-203; conversation-chat-client.ts:44-46; packages/agent-event-runtime …opencode-compat/projection.ts + ownership.ts:34-40; pages/session.tsx:1377 | REAL GAP: runtime-events compat projection never emits message.updated → cloud assistant reply never renders | ORPHAN (packages/agent-event-runtime); app seams WP-B5/B6/B8 | not-in-audit (out of audit scope) |
| core-harness-ownership-cloud:654 | Pi fixed-model on cloud: zero options requests — b2 | same SPEC-block citations as b1 | same cloud assistant-reply-never-renders gap | ORPHAN (agent-event-runtime) | not-in-audit |
| core-harness-ownership-cloud:745 | non-OpenCode harness resets to OpenCode on cloud nav — b5 | same SPEC-block citations as b1 | nav-reset real, but final send blocked by same cloud reply gap | ORPHAN (agent-event-runtime) | not-in-audit |
| core-harness-ownership-local:468 | unavailable harness shows red dot, blocks submit — b5 | claxedo-ui/context/harness-status-actions.ts:63-76; harness-hydrator.ts:97; session-client/harness/store-state.ts:40-44; store-policy.ts:31-34 | REAL BUG: applyStatus guard treats seeded "opencode" placeholder as user-confirmed → failed harness never applied, silent fallback | WP-B11 (cause; ORG-2 moves paths), WP-B9 | related: ui-state §harness-config-suite-is-grep-the-source |
| core-harness-ownership-local:515 | Connecting pill + composer fade while polling — b6 | session-client/harness/store-state.ts:81; profile.ts:61; claxedo-ui/components/agent-harness-selector.tsx:125; composer.tsx:202-206; selection.ts:11 | REAL BUG: harnessStatusPatch is error/ready binary, no "polling" branch → startup shows red Unavailable; connecting UI unreachable | WP-B9 (cause), WP-B1 (selector) | not-in-audit |
| core-harness-ownership-local:675 | draft harness resets when directory leaves runtime ref — b9 | session-client/harness/store-policy.ts:80-92; shell/workspace/session-workspace-key.ts:20-35 | not app bug: needs cloud runtime ref local mock can't produce; belongs to spec 12 | WP-B9, WP-B5 | not-in-audit |
| core-harness-rendering-matrix:536 | opencode native compaction divider renders — b7 | packages/session-ui/src/components/message-part.tsx ~670-712,1580-1596; session-turn.tsx | compaction part never reaches `[data-component="compaction-part"]`; suspected collision w/ session-turn divider | ORPHAN (packages/session-ui) | not-in-audit |
| core-harness-rendering-matrix:643 | pi — dedicated tool renderer — b3 | NO CITATION (fixture e2e/fixtures/harness-traces/pi.json gap) | fixture trace has no tool envelope; needs regeneration, no app source implicated | — (e2e assets; separate live-e2e session) | not-in-audit |
| core-harness-rendering-matrix:756 | claude-sdk reasoning part renders — b2,17 | packages/session-ui …message-part.tsx ~1705 | reasoning part pair never reaches `[data-component="reasoning-part"]` though sibling text renders | ORPHAN (packages/session-ui) | not-in-audit |
| core-harness-rendering-matrix:807 | assistant file-type parts render — b6 | packages/session-ui …message-part.tsx ~718,~947 (registerPartComponent zero call sites) | no `PART_MAPPING["file"]` registered → assistant file parts silently dropped | ORPHAN (packages/session-ui) | not-in-audit |
| core-model-effort-agent-controls:595 | agent selector disabled-while-harnessPending — b7 | session-client/composer/composer.tsx:91-101; selector-visibility.ts | not app bug: showAgentSelector() and harnessPending() mutually exclusive → state unreachable | WP-B9 | not-in-audit |
| core-panes-split-tabs:580 | mod+w on last pane opens desktop Quit dialog — b6 | src/main.tsx:41-46; claxedo-ui/layouts/rail-keyboard-controller.tsx:27 | unreachable on web: platform:'web' hardcoded, desktop Quit branch dead in this tier | main.tsx → WP-B8 (leader assignment); WP-B2/C2 (keyboard) | not-in-audit |
| core-panes-split-tabs:591 | mod+\ splits focused pane via keyboard — b7 | claxedo-ui/layout/workbench.tsx:162-179; layout/reducers/split.ts:33 | REAL BUG (dead shortcut): workbench passes pane's own contentId to split; self-drop guard always rejects → no-op | WP-B2 (+C2 consolidation) | related: ui-layout §two-divergent-keyboard-systems |
| core-panes-split-tabs:679 | busy background tab shows amber working dot — b11 | claxedo-ui/layouts/rail-header-surfaces.ts:37-45,110-136; session/store/session-status-dispatcher.ts; shared/query/query-client.ts:19 | REAL BUG: switcherItems memo misses 2nd external setQueryData write (solid-query enabled:false reactivity gap) → dot stuck "working" | WP-B2 (cause) | not-in-audit |
| core-panes-split-tabs:716 | background tab shows done dot after settling — b12 | rail-header-surfaces.ts; compact-switcher/surface-status.ts:89-98 | REAL BUG: same root cause; idle event never flips dot to "done" in DOM | WP-B2 / WP-B3 | not-in-audit |
| core-panes-split-tabs:754 | 2-pane split survives reload on non-owning URL — b14 | claxedo-ui/state/provider.tsx (wbOnChange); layouts/rail-empty-draft-controller.ts | unreachable via real UI + ContentMeta doesn't survive rehydration (terminal metadata gap) | WP-B11 / WP-B2 | not-in-audit |
| core-panes-split-tabs:802 | closing sole draft suppresses immediate auto-reopen — b15 | layouts/rail-empty-draft-controller.ts (blockNextAutoOpen); shell/app-shell-layout.tsx → rail-workbench-controller.ts → rail-header-surfaces.ts | REAL BUG: 2s auto-open suppression never engages; new draft reappears in ~80-100ms | WP-B2 (cause), WP-B5 | not-in-audit |
| core-processes:1166 | crash after launch lights toolbar attention dot — b10 | claxedo-ui/state/process-pane.ts:82-86; layouts/workbench-shell-header.tsx:191-194; claxedo-ui/context/process-pane.tsx:183-227,712-714 + 990-994 (unconditional onCleanup setCrashed(false), second bug) | REAL BUG ×2: crash found via GET reconcile never flips `crashed` signal; plus unconditional cleanup resets it | WP-B11 (cause) | related: ui-state §process-pane.tsx-god-file |
| core-processes:1422 | viewer role hides process controls — b18 | shell/workspace/workspace-connection.ts:393-453; workspace-gate.tsx:112-124 | not app bug: needs live viewer-role token; belongs to core-cloud-offline-roles | WP-B5 | not-in-audit |
| core-processes:1433 | project-shared process config across 2 workspaces, no port leaks | NO CITATION | out of scope for mocked layer; covered by live e2e-legacy spec | — | not-in-audit |
| core-session-actions:555 | forking a message creates session + restores draft — b6 | components/dialog-fork.tsx:26,35; src/app.tsx:468,476; shell/chat/conversation-registry.ts:169-170; pages/session/use-session-commands.tsx; claxedo-ui/context/session-params.tsx | REAL BUG: DialogFork reads `useParams().id` (legacy route only) → undefined on canonical route → fork dialog always empty | WP-B4 (cause); app.tsx → WP-B8 (leader assignment) | not-in-audit |
| core-session-actions:921 | child permission bubbles into parent dock — b14 | context/global-sdk.tsx:72-82; context/global-sync/event-ingress.ts:103; e2e/helpers/mock-runtime.ts | shared-mock gap, not app bug: synthetic SSE directory remapped, fails children.has() gate | WP-B6 (files; ORG-4 moves them); mock-runtime → live-e2e session | not-in-audit |
| core-session-actions:1120 | title syncs to second pane's tab label live | components/titlebar.tsx (TabNavItem); shell/app-shell.tsx:115 (tab strip commented out); claxedo-ui/layouts/rail-keyboard-commands.ts | no mounted surface shows a second session's live title; titlebar tab strip disabled | WP-B4 / WP-B5 | related: components §titlebar-two-implementations-plus-dead-stub |
| core-settings-auth:787 | Sandbox tab absent when sandboxEnabled=false | src/index.tsx:93; components/dialog-settings.tsx:151-156 | harness limitation: VITE_SANDBOX_ENABLED baked at Vite start, not per-spec flippable | WP-B4 (dialog); index.tsx → WP-B8 (leader assignment) | not-in-audit |
| core-settings-auth:855 | account section hidden for `local` principal | shell/auth/principal-provider.tsx:27 | harness limitation: VITE_AUTH_ENABLED baked true | WP-B5 | not-in-audit |
| core-settings-auth:860 | Log out signs out and navigates to /login — b5 | utils/auth-client.ts:112-159,164-173,295,307-315 | REAL BUG: test-auth-bypass branch never assigns clerkLoadPromise → signOut() no-ops, auth state never purged; isSignedIn() always true bounces /login | WP-D3 (auth-client) | related: utils-shared §auth-client-cross-account-purge-has-no-test-file |
| core-settings-auth:1613 | double-submit guard re-trigger never re-exchanges | pages/cli-login.tsx:99-100 | not app bug: no black-box re-entrant trigger exists for the guard | WP-B8 | related: pages §cli-login-token-handoff-untested |
| core-settings-auth:1630 | anonymous principal on non-loopback → /login redirect | src/app.tsx:307-316; utils/api.ts:211-223 | harness limitation: server URL hardcoded loopback at build time; unreachable | app.tsx → WP-B8 (leader assignment); WP-A7 (api.ts) | not-in-audit |
| core-settings-auth:1637 | InitError variants render formatted chain + Restart | src/app.tsx (top-level ErrorBoundary); ref src/e2e/dialog-matrix-harness.tsx | unreachable: no crash-injection route to force ErrorBoundary fallback | app.tsx → WP-B8 (leader assignment) | related: pages §error.tsx-formatter-zero-tests |
| core-sidebar-tree:496 | project-header body click selects primary workspace — b2 | claxedo-layout-actions/workspace-actions.ts:48-61 (:50); claxedo-ui/state/orchestration.ts:181-217; state/route-intent.ts:347-350 | REAL BUG: openOrCreateSession treats `"new"` draft sentinel as reusable session → navigates to malformed /s/new | WP-B2 (cause), WP-B11 | not-in-audit |
| core-sidebar-tree:597 | status dot working→done as SSE lands — b4 | e2e/helpers/mock-runtime.ts:547-548,826; providers/claxedo-events.tsx:188-191 | shared-helper gap, not app bug: mock drains /global/event which app no longer fetches | mock-runtime → live-e2e session; WP-B10 (claxedo-events) | not-in-audit |
| core-sidebar-tree:671 | load-more done notice replaces button — b6 | shared/query/session-list.ts:51-66 (:63); layouts/rail-sidebar.tsx:1761-1763,1974-1976,2258-2260 | REAL BUG: mergeSessionListResponses keeps stale first-page nextCursor on append → "Load more" never disappears | shared/query/session-list.ts → WP-A7 (leader assignment); WP-B2 (rail-sidebar) | not-in-audit |
| core-sidebar-tree:892 | sidebar-toggle collapses rail width — b13 | shell/layout/commands.ts:31-43; shell/app-shell-layout.tsx:229,231 | REAL BUG: railToggleCommand dispatches size.value:0 but sidebarWidth() never reflects it; width frozen at 260px | WP-B5 | not-in-audit |
| core-sidebar-tree:913 | hot-zone peek expands unpinned collapsed sidebar — b11 | shell/layout/commands.ts:31-43; app-shell-layout.tsx:229 | blocked by same rail-width dispatch bug (b13) | WP-B5 (+B11 rail hover state) | related: ui-state §riskiest-timing-logic-zero-tests |
| core-sidebar-tree:927 | drag-resizing sidebar handle changes width + persists — b12 | claxedo-ui/layouts/rail-sidebar-shell.tsx:83-96; shell/app-shell-layout.tsx:229 | REAL BUG: drag delta computed against same broken sidebarWidth() accessor; drag never changes width | WP-B2 / WP-B5 | not-in-audit |
| core-sidebar-tree:947 | mobile drawer opens on entry, scrim-closes — b14 | claxedo-ui/layouts/rail-shell-chrome-state.ts:18,61; rail-sidebar.tsx:212; rail-sidebar-shell.tsx:139-142 | REAL BUG (dead code): nothing ever sets mobileSidebarOpen true; onSessionSelect declared but never invoked | WP-B2 (files) / WP-C3 (mobile behavior) | related: responsive §multipane-no-narrow-viewport-collapse |
| core-terminal:932 | externally exited PTY clears tracked agent status — b7 | claxedo-ui/state/agent-status-listener.ts:316-338 (vs correct :418-427); compact-switcher/surface-status.ts:10-18; state/terminal.ts:121-126 | REAL BUG: usePtyExitCleanup sets idle on pty.exited but never clearSeen → sidebar dot flips "done" and never disappears | WP-B11 (cause), WP-B3 | related: ui-state §riskiest-timing-logic-zero-tests |
| core-terminal:1116 | stale process-owned terminal tab pruned on reload — b12 | claxedo-ui/context/process-pane.tsx:384-416 | not app bug: deferred, needs Process-panel mocks; store op unit-tested | WP-B11 | not-in-audit |
| core-turns-reload-recovery:521 | forced dispatch failure restores context-item chip — b8 | components/prompt-input/context-items.tsx; popover-controller.ts:29-45; session-client/composer/composer.tsx:258,507-508; submit.ts; e2e/helpers/mock-runtime.ts | not app bug: missing @-mention route stub in shared mock; rollback proven generically | WP-B4 / WP-B9; mock-runtime → live-e2e session | not-in-audit |
| core-workspace-lifecycle:516 | not-a-git-repository toast unreachable on web tier — b2 | claxedo-layout-actions/project-actions.tsx:113; context/platform.tsx | not app bug: toast gated `platform !== "web"`, unreachable from Playwright web tier | WP-B2, WP-B6 | not-in-audit |
| core-workspace-lifecycle:528 | New workspace Local/Cloud dialog has no UI trigger — b8 | layouts/rail-sidebar.tsx:215; shell/app-shell.tsx:101; app-shell-layout.tsx:300; rail-sidebar-shell.tsx:156 | REAL BUG: onNewWorkspace threaded through tree but never called by any handler; DialogNewProject picker dead from UI | WP-B2 / WP-B5 | related (file-level only): ui-layout §rail-sidebar-2684-line |
| core-workspace-lifecycle:544 | direct local-worktree creation hangs forever — b9 | claxedo-layout-actions/project-actions.tsx:176-193; utils/worktree.ts | REAL BUG: awaits WorktreeState.wait() with no timeout; nothing ever calls .ready()/.failed() → permanent hang | WP-B2 (cause), WP-A7 (worktree.ts) | not-in-audit |
| core-workspace-lifecycle:560 | cloud create dialog states — b8 (unreachable) | NO CITATION (DialogCreateCloudWorkspace / DialogNewProject by name) | unreachable UI: only entry is DialogNewProject's Cloud card, which inherits b8's dead trigger | WP-B4 (dialogs) | related: naming-vocab §two-near-identical-create-cloud-workspace-dialogs |
| live-real-harness-smoke:595 | codex native SDK 3 real turns + reload — b5 | packages/agent-sdk-runtime/src/harnesses/codex/driver.ts:78-92,160-174 | REAL BUG: turn/start gets "thread not found" for uuid thread/start just returned — protocol/version skew | ORPHAN (packages/agent-sdk-runtime) | not-in-audit |
| live-agent-extensions-materialization:726 | marketplace disable/enable package — b6 | src/marketplace/marketplace-panel.tsx (InstallButton; no line) | REAL GAP: no disable/enable control in UI; server capability exists | WP-B10 | related: platform §marketplace-panel-1074-line-god-file-zero-tests |
| live-agent-extensions-materialization:735 | install a Cursor plugin via marketplace UI — b7 | NO CITATION | REAL GAP: no `kind:"plugin"` catalog entry, no install-by-source affordance | WP-B10 (feature area) | not-in-audit |
| live-agent-extensions-materialization:744 | adopt a discovered item via marketplace UI — b8 | NO CITATION (DiscoveredSection, /extensions/adopt route by name) | REAL GAP: DiscoveredSection has only top-level Dismiss; no per-item Adopt/Ignore despite server support | WP-B10 (feature area) | not-in-audit |
| live-claxedo-mcp-tools:547 | process tool add/update/remove 404 wrong path — b5 | packages/claxedo-mcp/src/process-handler.ts:275,299,311 vs server.ts:43; process-handler.test.ts:290-291,367-368,400-401 | REAL BUG: posts to bare `/process` not `/api/wr/process` → 404; unit test asserts the wrong path, masking it | ORPHAN (packages/claxedo-mcp) | not-in-audit |
| live-claxedo-mcp-tools:739 | summarize_logs surfaces LLM error not JSON crash — b10b | packages/claxedo-mcp/src/server.ts:66-67,637-645 | REAL BUG: httpRequest JSON.parses before res.ok check; fallback hits nonexistent route → cryptic SyntaxError | ORPHAN (packages/claxedo-mcp) | not-in-audit |

## Bugs discovered during execution (discovered-bug rule ledger)

| Found | Bug | Disposition | Evidence |
|---|---|---|---|
| Wave 1 (WP-A6 review) | zh-TW/zh-HK/zh-MO resolved to Simplified `zh` — matcher keyed on `hant` script token only | FIXED 2026-07-11 (leader, in-tree): `isTraditionalChinese()` in `src/i18n/locales.ts` treats TW/HK/MO region subtags as Traditional | `locale-parity.test.ts` rows flipped from pinned-wrong to correct; i18n suite 103P |
| Wave 1 (I4 gate) | A1 deleted ServerConnection.Sidecar + context barrel while claxedo-desktop consumed both | FIXED in `0364e0bd01` (restore + declared `./context` export) | desktop tsgo + boot screenshot |
| Wave 1 (WP-A7) | `mergeSessionListResponses` stale first-page nextCursor → "Load more" never disappears | FIXED in `8917ee5505`; e2e fixme core-sidebar-tree:671 ready to flip (e2e session owns the flip) | unit test written first |
| Wave 1 (WP-A4 review) | Solid ref-callback returned-closure cleanup silently ignored → titlebar slots never cleared | FIXED in `f101eb8ee6` (onCleanup pattern + factory test pinning the discard semantics) | portal-slot.test.ts 7P |
| Wave 1 (I5 gate) | perf-harness launch-project flow functionally broken (0/20 seeded sessions visible) — pre-existing | CHIP task_7f4fd469 (perf-harness owner) | identical failure at pre-wave commit |

| Wave 1.5 gate | Second pane on same relay-backed workspace never increments shared connection refs (seam workspace-connection.ts:112 stuck at 1) | PINNED: `test.fixme` core-panes-split-tabs behavior 19 (leader-flipped; A/B-proven pre-existing at e76ec13f0c AND 4390e5614d — not a Wave 1/1.5 regression; e2e session's earlier "13P" panes figure not reproducible in leader env) | owning WP-B5; suspects: workspace-gate.tsx acquire path for terminal/second surfaces |

| WP-03b (mobile bring-up) | `route-intent.ts` workspaceBrowse auto-opens the workspace review panel on every `/:dir/session` boot; at mobile width it covers the ENTIRE screen incl. composer | PINNED in mobile-smoke.spec.ts helper comments + here; owning WP-B11 (route-intent) / WP-C3 (mobile behavior decision) | discovered building the mobile smoke suite |
| WP-03b (suite audit) | `CLAXEDO_E2E_SUITE=happy` (the DEFAULT suite) matches ZERO specs — every core spec is @core-only; default `test:e2e` runs nothing | reported; owning: e2e session / leader (suite-tagging decision needed) | pre-existing gap |

### Wave 2 fixme flips (2026-07-11, fixme-flip worker — FLIPPED, awaiting leader gate run)

Each row below was flipped from `test.fixme` to a live `test` only after the cited
fix was verified **present in the live source** (citations updated to post-refactor
paths). Bodies marked *(authored)* had comment-only stubs and were given a real,
fix-specific test body mirroring a proven sibling test in the same file; bodies marked
*(pre-written)* already had a full drivable body under the fixme.

| Candidate | Spec (title) | Fix verified in source | Disposition |
|---|---|---|---|
| #1 | core-sidebar-tree "load-more done notice replaces button — behavior 6" | `mergeSessionListResponses` append advances to page's own `nextCursor` (`src/shared/query/session-list.ts:71-73`) | FLIPPED *(authored)* — awaiting gate |
| #2 | core-sidebar-tree "project-header body click selects primary workspace — behavior 2" | `openOrCreateSession` excludes `"new"` sentinel (`src/claxedo-ui/layout-actions/workspace-actions.ts:53`) | FLIPPED *(authored)* — awaiting gate |
| #3 | core-panes-split-tabs "mod+\\ splits focused pane — behavior 7" | keyboard split reveals `mruHiddenContent()` (`src/claxedo-ui/workbench/workbench.tsx:162-175`) | FLIPPED *(authored)* — awaiting gate |
| #6 | core-session-actions "forking a message creates session + restores draft — behavior 6" | `resolveForkSessionId` returns `params.sessionId ?? params.id` (`src/components/dialogs/fork-messages.ts:42-47`) | FLIPPED *(pre-written body)* — awaiting gate |
| #7 | core-cloud-provisioning "cloud create failure: one toast — behavior 6" | `creationRejected` flag + early `return` after `.catch()` toast (`src/components/prompt-input/submit-directory.ts:130-139`) | FLIPPED *(pre-written body)* — awaiting gate |
| #8 | core-harness-ownership-local "Connecting pill while polling — behavior 6" | `harnessStatusPatch` maps `applying`→`polling` via `settled` flag (`src/session-client/harness/store-state.ts:86-90`) | FLIPPED *(authored)* — awaiting gate |
| #13 | core-terminal "externally exited PTY clears tracked agent status — behaviors 7" | `reconcilePtyExit` batches `setAgentStatus(idle)` + `clearSeen` (`src/claxedo-ui/state/agent-status-listener.ts:328-340`) | FLIPPED *(pre-written body)* — awaiting gate |

**Skipped (verified but NOT flipped, with reason):**

| Candidate | Spec | Reason not flipped |
|---|---|---|
| #4 | core-panes-split-tabs "closing sole draft suppresses auto-reopen — behavior 15" | Fix present (reactive `blockedUntil` signal, `rail-empty-draft-controller.ts:50-55`) but the only faithful proof needs a 10ms-granularity in-browser timing sampler — inherently flake-prone; left for the e2e owner to author + run. |
| #5 | core-workspace-lifecycle "direct local-worktree creation hangs — behavior 9" | Hang fix present (`WorktreeState.ready(created)` before the `.wait()`, `project-actions.tsx:238`) but the UI trigger (behavior 8 `handleNewWorkspace`) is still dead — not drivable from the web tier. |
| #9 | core-harness-ownership-local "unavailable harness red dot — behavior 5" | Already a live `test()` (flipped earlier, carries a "FIXED:" note) — no action needed. |
| #10 | core-settings-auth "InitError variants render formatted chain — behavior" | The `/__e2e/error-page?variant=` crash-injection route DOES exist (`src/app.tsx:438` → `error-page-harness.tsx`), but a faithful body must assert `formatError`/i18n output — best authored by the e2e owner who can run it. |
| #11 | core-panes-split-tabs "ref-counted connection — behavior 19" | NOT fixed in the named files: `workspace-gate.tsx` and `workspace-connection.ts` are byte-identical to HEAD (only their test files changed). Real locus `session-pane-scope.tsx` is also unmodified. Fix has not landed. |
| #12 | core-processes "crash after launch lights attention dot — behavior 10" | Fixes appear present (stale-snapshot guard + removal of unconditional `onCleanup setCrashed(false)`) but a faithful crash-after-launch → reconcile drive is complex; left for the e2e owner to author + run. |

## Wave 2 gate dispositions (leader, appended post-flip)

| Item | Finding | Disposition |
|---|---|---|
| fork flip failure | LONGSTANDING production bug (since hard-fork reset): `context/prompt.tsx` `pick(scope)` keyed the prompt cache with raw `load(dir,id)` while `session()` used `sessionViewKey` — scoped draft writes (incl. fork restore) went to an orphan key the composer never reads | FIXED at gate (prompt.tsx pick → sessionViewKey; fork.tsx passes raw directory); fork e2e 3/3. Found because a flipped fixme failed honest. |
| behavior 8 flake | Pre-existing timing-racy magic-number guard (`configPatchCount <= 2`; failed 4/5 at baseline). Also documents real behavior: session-selection re-PATCHes on hydration toggles when a config PATCH permanently fails — bounded, converges at 5 | Guard reconciled to a convergence assertion (4/4). Bounded-retry behavior noted for WP-B6/B9 review. |
| user-hosted behaviors 2,3 | Mock harness lacks the contract-v3 `/api/wr/runtime-events` channel — assistant replies emitted onto a bus the app never drains; NOT an app bug (A/B: red at baseline, identical error) | PINNED `test.fixme` (leader); harness capability owned by the e2e session. |
| C2 pre-scope discoveries | macOS Electron menu dispatches Cmd+W/Cmd+B/Cmd+\\/Option-arrows/Cmd+O to command ids that do not exist in the renderer registry (silent no-ops on real desktop); `terminal.toggle` referenced by 3 call sites but never registered | Recorded for WP-C2 (inventory doc `2026-07-11-006` §5 has the resolution sequence). |

## Orphans and leader dispositions (2026-07-11)

**In-scope, previously unowned — leader assignments (reflected in LLD dependency notes):**
- `src/app.tsx`, `src/main.tsx`, `src/index.tsx` → **WP-B8** (root entry composition sits with pages/).
- `src/shared/query/session-list.ts` (confirmed REAL BUG: `mergeSessionListResponses`
  stale `nextCursor`) → **WP-A7**, with a named test gap; pinned by core-sidebar-tree:671.

**Out of goal scope (engine/vendored/sibling packages) — fixmes stay pinned; spun off as
separate-session task chips:**
- `packages/agent-event-runtime` opencode-compat projection never emits `message.updated`
  → blocks the ENTIRE cloud harness-ownership suite (3 fixmes). Highest-severity orphan.
- `packages/claxedo-mcp` wrong process route + JSON-parse-before-ok (2 fixmes).
- `packages/session-ui` part-renderer gaps (compaction, reasoning, file parts — 3-4 fixmes).
- `packages/agent-sdk-runtime` codex driver thread-not-found protocol skew (1 fixme).

**e2e-owned (mock/fixture gaps, not app bugs):** mock-runtime.ts gaps (3 fixmes) and the
pi fixture tool-envelope gap belong to the live-e2e session that owns `e2e/**`.
