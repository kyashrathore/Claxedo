# E2E Suite Consolidation: The 25 Specs

**Status:** proposed (v2 — adds per-harness rendering, extensions materialization,
claxedo-mcp, user-hosted; adds the SPEC-comment contract)
**Date:** 2026-07-10
**Scope:** `packages/claxedo-app` Playwright e2e + perf harness (+ live tier touching
claxedo-server / workspace-runtime / agent-extensions / claxedo-mcp)

## Why

The existing suite failed ~20 rounds of the same regression class (assistant reply never
visibly renders; harness/model/effort ownership leaks) because:

1. Every default spec fabricates the agent reply itself via `page.route` (`ack N:` echo),
   with `session.idle` emitted immediately and assistant messages pre-completed — the
   busy→completed transition where the bugs live is unreachable.
2. Assertions target the **user** bubble slot (`session-turn-message-content`); the
   assistant slot (`session-turn-assistant-content`) is asserted **nowhere**, and it is
   hidden via `aria-hidden` only — which Playwright `toBeVisible()`/`getByText()` ignore.
3. The one spec modeling stuck-busy (`reload-message-flow.spec.ts`) is fully `test.skip`.
4. The Playwright suite is not wired into CI at all.
5. No written invariant states what "working" means, so agents optimize for what the
   mocked tests measure.

This plan replaces the suite with **25 spec files** in two tiers:

- **Tier M (mocked/fixture, specs 1–21):** deterministic, run on every PR (core subset)
  and nightly (all). Mocks stream real event shapes (see Oracle + Fixtures).
- **Tier L (live, specs 22–25):** no route mocks; real server/runtime/binaries/fixtures.
  Nightly on a credentialed runner. **Loud-skip:** a missing credential/binary FAILS the
  test with a setup message; silent skips are forbidden.

Each spec file is a user journey containing multiple `test()` scenarios (~180 total).

## The Oracle (non-negotiable, applies to every scenario that sends a prompt)

> Proof of a completed turn is: assistant reply **text** visible inside
> `[data-slot="session-turn-assistant-content"]` whose `aria-hidden` is **not** `"true"`,
> the Thinking row **gone**, and the submit control back to **ready**.
> Payload, store, message-count, and network assertions are supplements — never proof.

Implemented once as `e2e/helpers/turn-oracle.ts` (`expectAssistantReplyVisible`), used by
every send in every spec. A grep ratchet bans asserting assistant text any other way.

The default mock must stream `busy → message parts → completed → idle` as **separate
events**, with variant hooks for: stale-busy (completed message, idle never arrives),
delayed idle, error mid-turn, dispatch failure, and slow/failed config PATCH.

## The SPEC comment (every spec file, non-negotiable)

Every spec file **opens with a `/** SPEC … */` block** that is a complete prose
specification of the feature it owns — written so that an engineer or AI agent who reads
ONLY the spec file can re-implement the feature in another language/framework. Template:

```
/**
 * SPEC: <feature name>
 *
 * PURPOSE — what the user accomplishes with this feature and why it exists.
 * STATE MODEL — the states/transitions (draft→submitting→busy→settled…), where each
 *   piece of state lives (URL, localStorage key, server, in-memory store), and what
 *   survives reload vs navigation vs nothing.
 * ANATOMY — the DOM contract: every data-slot/data-testid/role this feature exposes,
 *   what renders where, and what each visual state looks like (busy, empty, error,
 *   disabled, offline, read-only).
 * BEHAVIORS — numbered list; every user-visible behavior with its trigger and its
 *   observable proof. Each test() below cites the behavior number(s) it pins.
 * INVARIANTS — the never-break rules (e.g. "selected harness owns model/effort/payload
 *   at every stage", "completed assistant content is never hidden by stale busy state").
 * HARNESS NOTES — per-harness differences that reach this feature (event shapes,
 *   capability gating), if any.
 * OUT OF SCOPE — what this spec deliberately does not cover and which spec does.
 */
```

Behavior numbers make drift visible: a test with no behavior citation, or a behavior with
no test, fails review. `e2e/INVARIANTS.md` holds the cross-cutting rules and links to
each spec's block.

## Tier M — mocked/fixture specs

### A. The core loop (7)

**1. `core-first-prompt-local`** — Draft composer → first send → full session UI; oracle;
exactly one user + one assistant row; optimistic user row before reconcile;
attach-workspace-before-prompt guard toast (no session created).

**2. `core-turns-reload-recovery`** — 2nd send; reload (same session, zero duplicate rows,
bounded request count); 3rd send post-reload; prompt history ArrowUp/Down (separate
normal/shell stacks, persists across reload); edit-sent-message reloads text+chips into
composer; forced dispatch failure → optimistic row removed, exact composer state restored
(text, attachments, chips), error toast, retry affordance resubmits; scroll-to-top
load-older prepends without dups and preserves scroll.

**3. `core-harness-ownership-local`** — Matrix: Claude/Codex × ACP/SDK, plus Pi
(fixed-model: no model popover, instantly ready, no auth gating) and Cursor. For each:
harness label, model options, effort options, submit payload owned by the selected
harness through draft→send→reload→send; harness locked after creation; **exactly one**
model control in the DOM during opencode↔harness switches; "Connecting" pill + composer
fade + attach disabled while readiness is polling; unavailable/auth-error → red dot,
submit disabled, editor locked, zero OpenCode fallback, zero requests (deterministic
waits — no `waitForTimeout` sleeps); abort-capability-false → stop control disabled;
draft harness resets to OpenCode when directory changes away from a workspace-runtime
ref; stale model-options refresh does not drop the selected model.

**4. `core-model-effort-agent-controls`** — Model change before first send + mid-session,
persists across reload; **positive** effort/variant payload assertion; variant selector
only when >1 variants; zero-paid-provider path opens `DialogSelectModelUnpaid`;
multi-agent selector renders, selection hits the payload, disabled while harnessPending;
failed config PATCH → "could not save session config" toast while the send still
proceeds; missing model/agent blocks submit with toast, text preserved; Settings→Models
visibility toggle propagates to the composer picker.

**5. `core-busy-abort-errors`** — Thinking renders while busy; **stale-busy** (message
completed, idle never arrives) → reply still visible and status reconciles without user
action; Stop aborts; Enter-on-blank-composer aborts (distinct code path); "Interrupted"
divider at the abort part index; retry/ACP-recovery banner on `status: retry`; error card
with unwrapped message (JSON-envelope case); escalation ladder: "Still working…" →
"taking a while" + Cancel → "unresponsive" + Cancel/Retry.

**6. `core-composer-modes`** — Slash: builtin fires immediately and clears vs custom
inserts `/trigger ` for editing; shell mode entry/exit, dispatch success AND forced
failure (`shellSendFailed` toast + exact input restore), context chips hidden in shell
mode; Escape cascade advances one step (popover → shell → abort → blur); Shift+Enter =
newline; @-mention popover full keyboard nav, inserted pill; sent message renders
`data-highlight` agent/file spans; attachments: button, clipboard paste, drag-drop
overlay, unsupported-type warning toast, chip remove, image-only submit allowed, rendered
attachment thumbnail + ImagePreview on click; draft text+chips survive reload AND
navigate-away-and-return.

**7. `core-docks`** — Permission dock blocks composer; Deny / Allow once / Allow always
each work (mapping to ACP `allow_once|allow_always|reject_*` and native
`PermissionResult`); turn completes visibly after allow; auto-responded permissions never
surface; question wizard: single, multi, custom answer, back/next, dismiss, keyboard nav,
draft answers persist across navigate-away; todo dock: opens while live+incomplete,
collapsed preview shows active todo, auto-collapses after completion.

### B. Timeline & session actions (3)

**8. `core-timeline-rendering-scroll`** — Tool-part expand defaults per settings
(bash/edit flags), other tools collapsed, answered question open; consecutive
read/glob/grep/list collapse into "Gathered context" group with counts, expandable;
per-turn diff summary accordion (absent while busy, appears on settle, deduped per file,
>10 "N more"/"show less", lazy diff view); jump-to-bottom after scrolling up mid-stream;
pinned-to-bottom while streaming; prepend preserves anchor; hash deep-link scrolls to the
target message (incl. comment-strip offset case).

**9. `core-session-actions`** — Rename via double-click and ⋯ menu (Enter commits, Escape
cancels, failed save keeps editor + toast); title syncs to a second pane's tab label
without reload; fork → new session + draft restoration; revert → composer prefilled,
revert dock ("N rolled back", expand, per-row Restore), unrevert; archive/delete with
confirm + archived filter; subagent flows: directly-opened child session shows disabled
composer + "Back to parent"; child permission/question bubbles to the **parent's** dock;
parent breadcrumb navigates.

**10. `core-harness-rendering-matrix`** *(new)* — For each harness family — opencode
native, `claude-acp`, `codex-acp`, `cursor-acp`, Claude native SDK, Codex native SDK,
Cursor native SDK, Pi — replay that harness's **real translated event traces** through
the mocked SSE stream (fixtures derived from the golden-compat and adapter test traces in
`packages/agent-event-runtime`, NOT hand-invented shapes) and assert the timeline renders
every part type with its dedicated component:
text (paced markdown + meta line), reasoning (gated by showReasoningSummaries), each
registered tool renderer (`read`, `list`, `glob`, `grep`, `webfetch`, `websearch`,
`task`, `bash`, `edit`, `write`, `apply_patch`, `skill`) + GenericTool fallback with MCP
icon for unknown names; tool lifecycle pending→running→completed→error states; `file`
parts (image/audio data-URL, resource links); `compaction` divider; `session.diff`.
Harness-specific pins: `todowrite` NEVER renders a tool row (dock only); `question`
hidden while pending, visible once answered; Codex plan stream renders as ordinary text
parts (**no plan part/dock exists — pinned as intentional**); Codex ACP "Permission" fake
tool → permission dock, not a tool row; Cursor ACP full-text snapshot chunks render
without duplicated text (delta-dedup) and the `WritableIterable is closed` sentinel is
swallowed; Claude `Task`/Cursor subagent tool links to the child session; per-client tool
NAME normalization (e.g. Cursor "Terminal"→bash, Claude `TodoWrite`, Codex
`apply_patch`) lands on the right renderer; diagnostics (`runtime.diagnostic`) never
render as message rows.

### C. Cloud & remote (4)

**11. `core-cloud-provisioning`** — Cloud VM create at submit: 4-step pipeline with
per-step states, composer unlocks on ready, send through relay, oracle; reload
mid-provisioning resumes at the current step (not step 0); create failure (thrown AND
200-with-missing-fields) → toast, no overlay, no session, composer text preserved.

**12. `core-harness-ownership-cloud`** — Spec 3's matrix over the relay:
create → reload → follow-up; payloads through relay; harness-config-options scoped per
harness; no local/OpenCode state leaks into cloud sessions; switching local↔cloud
workspaces leaks nothing.

**13. `core-cloud-offline-roles`** — Relay offline → offline copy (not a spinner); 403 →
access-denied terminal view; reconnect resumes silently (queries refetch, **zero** error
toasts during the outage, pickers show fallback not error); panel-local pending overlay
distinct from the main-pane gate; arm-once behavior (overlay does not reappear after a
post-connect drop; re-gates on directory switch); viewer role: "Read-only workspace"
placeholder, submit + Enter blocked, mutation controls hidden; role live-flip down/up
updates in place without remount.

**14. `core-user-hosted-workspace`** *(new — mocked-relay tier; deep half lives in spec
25's fixture run)* — User-hosted 3-step connect pipeline (Connecting to workspace →
Establishing relay tunnel → Checking runtime health) with distinct heading/copy; offline
→ exact "run `claxedo up`" copy; health probe retry policy tolerates transient 409/503
without flashing offline; sessions/terminals/files panels route through the relay lane
for a user-hosted workspace; pause → offline state; share/register entry point from the
app (`share-workspace` path) reaches registered state.

### D. Shell & navigation (4)

**15. `core-boot-deep-links-home`** — Cold boot, zero console errors; zero-project empty
state; Home recents + Open-Project platform branches; `/s/:sessionId` and `/w/...`
materialize the correct pane; deep-link reload discards previously open tabs; corrupted
persisted layout self-heals; persisted boot restores focused session; missing-session
404 state + sidebar prune; startup gate (session routes reveal shell immediately,
non-session routes splash until health/timeout); unreachable-server screen with retry.

**16. `core-panes-split-tabs`** — Split via keyboard, drag-tab-to-edge, divider drag
resize; click-to-focus dims the other pane; `mod+alt+arrows` directional focus;
`mod+w`/`mod+tab`/`mod+1..9`; tab strip order stable; background tab status dots
(amber/red/muted, clear on focus, auto-responded excluded); split snapshot restores on
tab switch AND across reload; empty workbench auto-draft + post-close suppression;
desktop "Quit Claxedo?" dialog; header New Session/Terminal/Page buttons (terminal
disabled when tools blocked); command palette opens and dispatches; `mod+b`; two panes on
one workspace share a ref-counted connection.

**17. `core-sidebar-tree`** — Project disclosure vs body click; workspace header body vs
icon click; hover-reveal actions; status dot transitions idle→working→permission→done
(+unseen badge); session click fast-path + rapid-switch race; load-more paging; view
options (group-by, filters, archived radio, persistence + malformed-JSON fallback);
loading/error/empty testids; archive hover button (incl. silent-no-op case); pin/peek
hot-zone, auto-collapse deferral, drag-resize persists; mobile drawer scrim-close +
close-on-select.

**18. `core-workspace-lifecycle`** — +New project → directory dialog → invalid-path /
not-git toasts; New workspace Local/Cloud choice; local worktree create (+
WorktreeNotGitError); cloud create dialog (provider select, no-configured-providers
state, in-dialog pipeline, stalled-step timeout fallback, mid-provision error/retry
banner); kebab actions to completion: Edit project rename, Delete workspace (dirty
check/cancel/disabled-while-deleting), Destroy Sandbox, Remove project incl. forced
server failure, Recover missing local workspace.

### E. Panels (3)

**19. `core-terminal`** — Create plain + Claude/Codex presets + custom command
(configured in Settings→Terminals tab, asserted here); type and see output; pane
split/resize refits the terminal (no clipping); external `exit` removes row + reassigns
active; agent status dot transitions + clear-on-focus; lifecycle auto-rename never
clobbers a user-set title; reattach after reload; stale process-owned tab cleanup.

**20. `core-processes`** *(full feature, split back out)* — Add process (dialog
validation, env var add/remove); start → running status, port + URL shown; stop; restart
(running and stopped paths); start-all sequential / stop-all concurrent + button
relabels; crash: guaranteed non-zero exit → overlay with exit code, auto-open panel,
toolbar attention dot; port conflict AND route conflict overlays + "Kill & reclaim"
resolves; edit config → "Process updated"; delete with inline confirm; empty state +
permission-gated Add; process-owned PTY does not duplicate as a terminal tab; project-
shared process config visible across workspaces, no port leaks after stop; diagnostics
dialog (health bar, active/stale/external groups, stop/kill actions + toast +
reconciliation); read-only role hides all mutation controls; `.claxedo/processes.jsonc`
persistence across reload.

### F. Settings, auth & system (1)

**21. `core-settings-auth`** — Settings tab switching (Sandbox gated by
`sandboxEnabled`), mobile nav; General: account section gated by principal, sign-out →
`/login`, theme hover-preview/commit, notification toggles, manual update check →
persistent toast action contract; Shortcuts: search, rebind capture + conflict, reset;
Providers: connect popular (API key + OAuth device/manual), custom provider validation,
disconnect, env-locked rows; Connections: status states, OAuth polling,
already-exists conflict, secret hygiene on close, inline disconnect confirm; Sandbox:
default provider save, signed-hosted read-only lock, credential CRUD, network-policy role
gating; `/login` redirect-if-signed + Continue; `/cli-login` param validation,
not-signed redirect, exchange + auto-submit + double-submit guard, failure states; signed
gate: loopback bypasses, anonymous non-loopback forced to `/login` with loading
placeholder (no protected-content flash); error page InitError variants + Restart/Check-
updates.

## Tier L — live specs (no route mocks anywhere)

**22. `live-real-harness-smoke`** — Real claxedo-server + real engine + real harness
binaries (opencode, claude, codex; ACP and SDK where available). Per available harness:
3 turns + reload, full oracle each turn. Loud-skip on missing credential/binary.

**23. `live-agent-extensions-materialization`** — Through the **marketplace panel UI**
(the only real install surface — the old Settings→Extensions tab is gone; the stale
`remote-access-live` test targeting it is deleted): install one of each resource type —
a **skill** (e.g. `anthropic-skill-pdf`), an **MCP server** (`claxedo-mcp`), a **cursor
plugin** — then assert, per harness target:
skill materializes at `.claude/skills/<n>`, `.agents/skills/<n>`, `.opencode/skills/<n>`,
`.cursor/skills/<n>` (symlink-or-copy into `.agent-extensions/cache/<sha>/…`); MCP entry
merged (not overwritten) into `.cursor/mcp.json` / `.mcp.json` / `.codex/config.toml`
(TOML section) / `.opencode/opencode.jsonc` (comments preserved); `installed.json`,
`lock.json` (pinned SHA + digests), `materialized.json` (`status: "applied"` per
component) all written; UI shows Installed pill + toast. Then: disable → artifacts
removed but state retained; enable → restored; uninstall → clean; same-name conflict
with an unowned entry → legible `agent_extension_mcp_server_conflict` error, never a
silent overwrite. **Cloud half:** create a Docker sandbox workspace, install at
workspace scope, poll `.workspace-runtime/runtime-config/accepted-snapshot.json` for the
install id and `apply-status.json` for `state: "applied"`, then assert the files inside
the sandbox filesystem (`docker exec`) — proving the push-on-provision +
`applyRuntimeAgentExtensions` replay path end to end, including the digest-verified git
fetch-to-cache. Also: "Detect existing" scan/adopt flow.

**24. `live-claxedo-mcp-tools`** — Two halves.
*Wiring:* after installing `claxedo-mcp` (via spec 23's path or CLI), assert the
first-party env rewrite in every harness config file: `CLAXEDO_SERVER_URL` injected from
the materializing host, `OPENCODE_API_DIR` set for project scope, ALL `CLAXEDO_*_TOKEN`
credentials stripped; a lookalike (non-canonical source) package is materialized verbatim
with no rewrite. Assert presence in all four harness targets, local AND inside a cloud
sandbox.
*Tools do their job:* drive a real harness session (or direct MCP client where the UI
adds nothing) and verify each tool's observable effect: `process` add/start/stop →
process appears/starts/stops in the app's Process panel and `.claxedo/processes.jsonc`;
`get_logs` returns the real PTY tail; `session_messages` returns the actual transcript
for both a session id and a terminal-agent binding; `spawn_session` → new session
appears in the sidebar at `/s/:id` and runs its prompt (oracle); `summarize_logs` returns
`{title, summary}` and leaves no scratch session behind; read-only mode
(`CLAXEDO_MCP_READ_ONLY=1`) hides `process`/`spawn_session`/`summarize_logs`/
`browser_evaluate_js`/`browser_navigate`. Browser tools: desktop-gated — in this suite
assert the legible "desktop unavailable" message (full browser-tool coverage belongs to
the desktop repo's tests); in a cloud sandbox, assert the same graceful denial.

**25. `live-user-hosted-relay`** — Built on the real in-repo fixtures
(`user-hosted-relay-fixture.ts` + `signed-browser-relay-fixture.mjs` — genuine
`@claxedo/workspace-relay`, real JWT mint/verify, real WS multiplexing; replaces the old
`signed-user-hosted-relay-live` / `signed-cloud-relay-live` specs rather than deleting
that coverage): register (challenge → signed proof → tunnel up) → workspace appears;
health + file read + PTY create/delete **through the relay**; session send through the
relay (oracle); connection token refresh (JTI rotation) keeps the session alive; pause →
offline copy in the UI; restart tunnel → reconnect without reload; forbidden legacy
engine endpoint receives zero requests (routing correctness); viewer vs editor role
behavior at the UI layer.

> **Product finding to resolve during implementation:** the investigation found **no
> role enforcement at the relay/runtime transport layer** — a viewer's PTY/file writes
> are only blocked by UI gating once a connection exists. Spec 25 should pin whatever
> the intended contract is; if server-side enforcement is the intent, that's a product
> fix to make first, not a test to write around.

## Perf harness — kept

Metrics (unchanged thresholds): `p95FrameMs` (fail > 16.67ms), `worstFrameMs`
(regression vs stored budget), `framesOver1667` (fail > 2), `completionMs`. Validation
gates kept: page errors, console errors, ≥400 responses, blank page, error boundary,
transcript-not-visible.

Flows kept (5): `launch-project`, `session-switch` (10k-message stress),
`live-terminal-switch`, `large-diff-toggle`, `workspace-switch`.
Flows deleted (2): `launch-empty-home`, `three-pane-resize`.

## Deleted with no replacement (conscious cuts)

- **Pages/Arena surface** — superseded by Docs v2 direction; revisit when it lands.
- **Marketplace browsing UX** (categories/search/badges) — peripheral; the install path
  itself IS covered by spec 23.
- `remote-access-live` — its extension test targets a Settings→Extensions UI that no
  longer exists; its Local-Personal-Mode coverage is superseded by specs 23–25.
- `hosted-better-auth-live`, `deployment-portability-staging`, `live-happyflows`,
  `real-cloud-workspace-relay`, `real-clerk-convex-auth` (real-Claude helper harvested
  into spec 22), `restoration-e2e-1/2/3` (folded into specs 22/23), `compat-disabled-
  local-workflow`, `session-capabilities-ui`, `login-roundtrip` and all other current
  spec files — salvageable scenarios are enumerated under their new owning spec.
- Legacy terminal persist-scope migration → unit test.
- WS-1008 PTY recovery, SSE agent-dot reconciliation → accepted gaps unless a test hook
  can force them deterministically.
- `e2e/bun/workspace-relay-connection.test.ts` → move to `src/` as a unit test.

## Definition of Done

1. `e2e/INVARIANTS.md` exists stating the oracle + cross-cutting invariants; every spec
   file opens with the SPEC comment block per the template above; every `test()` cites
   behavior numbers; a review rule rejects tests without citations and behaviors without
   tests.
2. `expectAssistantReplyVisible` helper exists; grep ratchet fails on any assistant-text
   assertion outside it; zero `waitForTimeout` as the sole guard of a negative.
3. Default mock streams status as separate events with all failure-shape variants;
   stale-busy is a permanent non-skipped test; spec 10's fixtures are generated from the
   agent-event-runtime golden/adapter traces (a script regenerates them; hand-edited
   fixtures are rejected).
4. Exactly 25 spec files; `test:e2e:all` (Tier M) green locally and in CI.
5. CI: specs 1–7 + 10 on every PR; all Tier M nightly; Tier L nightly on a credentialed
   runner with loud-skip semantics.
6. The role-enforcement finding (spec 25 note) is resolved as either a server-side fix or
   a documented, deliberately-pinned UI-only contract.
