# E2E Suite Consolidation: The 20 Specs

**Status:** proposed
**Date:** 2026-07-10
**Scope:** `packages/claxedo-app` Playwright e2e + perf harness

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

This plan replaces the suite with exactly **20 spec files** (each a user journey containing
multiple `test()` scenarios — ~150 scenarios total), derived from a 21-agent survey of the
entire UI surface (10 domains, ~140 verified coverage gaps).

## The Oracle (non-negotiable, applies to every scenario that sends a prompt)

> Proof of a completed turn is: assistant reply **text** visible inside
> `[data-slot="session-turn-assistant-content"]` whose `aria-hidden` is **not** `"true"`,
> the Thinking row **gone**, and the submit control back to **ready**.
> Payload, store, message-count, and network assertions are supplements — never proof.

Implemented once as a shared helper (`e2e/helpers/turn-oracle.ts`,
`expectAssistantReplyVisible(page, text)`), used by every send in every spec. A grep
ratchet bans asserting assistant text any other way.

The default mock must stream `busy → message parts → completed → idle` as **separate
events**, with variant hooks for: stale-busy (completed message, idle never arrives),
delayed idle, error mid-turn, dispatch failure, and slow/failed config PATCH.

## The 20 Specs

### A. Core loop (7)

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
(fixed-model: no model popover, instantly ready) and Cursor. For each: harness label,
model options, effort options, submit payload owned by the selected harness through
draft→send→reload→send; harness locked after creation; **exactly one** model control in
the DOM during opencode↔harness switches; "Connecting" pill + composer fade + attach
disabled while readiness is polling; unavailable/auth-error → red dot, submit disabled,
editor locked, zero OpenCode fallback, zero requests (deterministic waits — no
`waitForTimeout` sleeps); abort-capability-false → stop control disabled/no-op; draft
harness resets to OpenCode when directory changes away from a workspace-runtime ref;
stale model-options refresh does not drop the selected model.

**4. `core-model-effort-agent-controls`** — Model change before first send + mid-session,
persists across reload; **positive** effort/variant payload assertion (not just
`variant === undefined`); variant selector only when >1 variants; zero-paid-provider path
opens `DialogSelectModelUnpaid`; multi-agent selector renders, selection hits the payload,
disabled while harnessPending; failed config PATCH → "could not save session config"
toast while the send still proceeds; missing model/agent blocks submit with toast, text
preserved; Settings→Models visibility toggle propagates to the composer picker.

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
newline, no submit; @-mention popover full keyboard nav, inserted pill; sent message
renders `data-highlight` agent/file spans; attachments: button, clipboard paste,
drag-drop overlay, unsupported-type warning toast, chip remove, image-only submit
allowed, rendered attachment thumbnail + ImagePreview on click; draft text+chips survive
reload AND navigate-away-and-return.

**7. `core-docks`** — Permission dock blocks composer; Deny / Allow once / Allow always
each work; turn completes visibly after allow; auto-responded permissions never surface;
question wizard: single, multi, custom answer, back/next, dismiss, keyboard nav, draft
answers persist across navigate-away; todo dock: opens while live+incomplete, collapsed
preview shows active todo, auto-collapses after completion.

### B. Timeline & session actions (2)

**8. `core-timeline-rendering-scroll`** — Tool-part expand defaults per settings
(bash/edit flags), other tools collapsed, answered question open; consecutive
read/glob/grep collapse into "Gathered context" group with counts, expandable; per-turn
diff summary accordion (absent while busy, appears on settle, deduped per file, >10
"N more"/"show less", lazy diff view on expand); jump-to-bottom button after scrolling up
mid-stream; pinned-to-bottom while streaming; prepend preserves anchor position; hash
deep-link scrolls to the target message (incl. comment-strip offset case).

**9. `core-session-actions`** — Rename via double-click and ⋯ menu (Enter commits, Escape
cancels, failed save keeps editor + toast); title syncs to a second pane's tab label
without reload; fork → new session + draft restoration; revert → composer prefilled,
revert dock ("N rolled back", expand, per-row Restore), unrevert; archive/delete with
confirm + archived filter behavior; subagent flows: directly-opened child session shows
disabled composer + "Back to parent"; child permission/question bubbles to the
**parent's** dock; parent breadcrumb navigates.

### C. Cloud (3)

**10. `core-cloud-provisioning`** — Cloud VM create at submit: 4-step pipeline
(acquiring → cloning → starting → health) with per-step states, composer unlocks on
ready, send through relay, oracle; user-hosted 3-step variant (distinct labels/heading);
**reload mid-provisioning resumes at the current step**, not step 0; create failure
(thrown AND 200-with-missing-fields) → toast, no overlay, no session, composer text
preserved.

**11. `core-harness-ownership-cloud`** — Spec 3's matrix over the relay:
create → reload → follow-up; payloads through relay; harness-config-options scoped per
harness; no local/OpenCode state leaks into cloud sessions; switching local↔cloud
workspaces leaks nothing.

**12. `core-cloud-offline-roles`** — Relay offline → offline copy (not a spinner); 403 →
access-denied terminal view; reconnect resumes silently (queries refetch, **zero** error
toasts during the outage, pickers show fallback not error); panel-local pending overlay
(`workspace-review-pending`) distinct from the main-pane gate; arm-once behavior: overlay
does not reappear after a post-connect drop, does re-gate on directory switch; viewer
role: "Read-only workspace" placeholder, submit + Enter blocked, mutation controls
hidden; role live-flip down/up updates in place without remount.

### D. Shell & navigation (4)

**13. `core-boot-deep-links-home`** — Cold boot, zero console errors; zero-project empty
state (sidebar hidden, New Project CTA); Home recents click-through + Open-Project
platform branches; `/s/:sessionId` and `/w/...` materialize the correct pane (assert pane
content — the router is URL-sync only); deep-link reload **discards** previously open
tabs; corrupted persisted layout (seeded bad `claxedo.state.v5`) self-heals without
crash; persisted boot restores focused session; missing-session 404 → "Session
unavailable" + pruned from sidebar; startup gate: session routes reveal shell immediately
with background health, non-session routes splash until health/timeout; unreachable
server screen with retry.

**14. `core-panes-split-tabs`** — Split via keyboard, drag-tab-to-edge, divider drag
resize (retained); click-to-focus dims the other pane; `mod+alt+arrows` directional
focus; `mod+w`/`mod+tab`/`mod+1..9`; tab strip order stable across MRU cycling;
background tab status dots (amber/red/muted, clear on focus, auto-responded permission
excluded); split snapshot restores on tab switch (no reload) AND across reload; empty
workbench auto-opens a draft with post-close suppression window; desktop "Quit Claxedo?"
dialog on closing the last empty pane; header New Session/Terminal/Page buttons (terminal
disabled when workspace tools blocked); command palette opens and dispatches; `mod+b`
sidebar toggle; two panes on one workspace share a ref-counted connection — closing one
leaves the other connected.

**15. `core-sidebar-tree`** — Project disclosure vs body click; workspace header body
click (opens review panel + expands) vs icon click (expand only); hover-reveal new
session/terminal actions; session status dot transitions idle→working→permission→done
(+unseen badge); session click fast-path + rapid-switch race (B's content, never stale
A); load-more paging (loading, exhausted label, stale-response discard); view options:
group-by, status/environment filters, archived radio, persistence across reload +
malformed-JSON fallback; distinct loading/error/empty testids; archive hover button
(incl. the silent-no-op resolution case); pin/peek hot-zone, auto-collapse deferred while
a menu is open, drag-resize persists; mobile drawer scrim-close + close-on-select.

**16. `core-workspace-lifecycle`** — +New project → directory dialog → "Invalid project
path"/"Not a git repository" toasts; New workspace Local/Cloud choice; local worktree
create (+ WorktreeNotGitError); cloud create dialog: provider select,
no-configured-providers disabled state, in-dialog pipeline, stalled-step timeout
fallback, mid-provision error/retry banner; kebab actions driven to completion: Edit
project rename, Delete workspace (dirty check, cancel, disabled-while-deleting), Destroy
Sandbox (cloud), Remove project **including a forced server-failure** (no silent
success), Recover missing local workspace.

### E. Panels (2)

**17. `core-review-workspace-panel`** — Panel open via header toggle (aria-pressed),
drag-resize clamped + terminal-fit on release, maximize/restore, close-while-maximized;
review source mode popover (uncommitted/unstaged/staged/to-from with Apply gated on both
refs, persisted per directory+session); loading / empty-CTA / stale-refresh-keeps-diffs
states; progressive lazy-scroll expansion; large-diff "Render anyway" per-file gate;
line comments: add, **edit**, **delete** — gutter marker and composer chip stay in sync,
chip click navigates, chip remove unlinks; file tab: line comment (`origin: file`) +
markdown preview/source toggle; panel tab strip: add File/Context/Browser via "+",
Context/Browser singletons retarget instead of duplicating, closing active tab lands
correctly, >5 file tabs evict + reload on reactivation, L2 header swaps per tab kind;
browser tab element-picker comment → composer chip + screenshot attachment, "saved
locally" toast when no session focused.

**18. `core-terminals-processes`** — Terminals: create plain + Claude/Codex presets +
custom command (configured in Settings→Terminals); type and see output; pane split/resize
refits the terminal (no clipping); external `exit` removes the row and reassigns active;
agent status dot transitions + clear-on-focus; lifecycle auto-rename never clobbers a
user-set title; reattach after reload; stale process-owned tab cleanup on reload.
Processes: add (validation), edit ("Process updated"), delete (inline confirm),
start/stop (port + URL shown), restart (running and stopped paths), start-all sequential
/ stop-all concurrent + button relabel; crash overlay with exit code + auto-open panel +
toolbar attention dot; port/route conflict overlays + "Kill & reclaim"; empty state;
process-owned PTY does not duplicate as a terminal tab; diagnostics dialog (groups,
stop/kill, toast); read-only role hides all mutation controls.

### F. Settings, auth & system (1)

**19. `core-settings-auth`** — Settings dialog tab switching (Sandbox tab gated by
`sandboxEnabled`), mobile nav; General: account section gated by principal capability,
sign-out → `/login`; theme hover-preview/commit and notification toggles (spot-checks);
manual "Check Now" update → persistent toast whose action buttons fire then dismiss;
Shortcuts: search, rebind capture mode + conflict detection, reset overrides; Providers:
connect popular (API key + OAuth device/manual), custom provider dialog validation,
disconnect, env-sourced rows locked; Connections: status states, connect-integration
OAuth polling, already-exists conflict, secret hygiene on close, inline disconnect
confirm; Sandbox: default provider save, signed-hosted read-only lock, credential CRUD,
network-policy role gating; `/login` redirect-if-signed + Continue → signIn; `/cli-login`
param validation, not-signed redirect, token exchange + auto-submit + double-submit
guard, failure states; signed gate: loopback bypasses, anonymous non-loopback forced to
`/login` with loading placeholder (no protected-content flash); error page renders
InitError variants copyable + Restart/Check-updates actions.

### G. Truth layer (1)

**20. `live-real-harness-smoke`** — The **only no-mock spec**. Real claxedo-server + real
engine + real harness binaries (opencode, claude, codex — ACP and SDK where available).
Per available harness: 3 turns + reload, full oracle each turn. **Loud skip**: if an
expected credential/binary is missing, the test FAILS with a setup message — it never
silently skips. Env preflight harvested from `real-clerk-convex-auth.spec.ts` and
`restoration-e2e-1`.

## Perf harness — kept

Metrics (unchanged thresholds): `p95FrameMs` (fail > 16.67ms), `worstFrameMs`
(regression vs stored budget), `framesOver1667` (fail > 2), `completionMs`. Validation
gates kept: page errors, console errors, ≥400 responses, blank page, error boundary,
transcript-not-visible.

Flows kept (5): `launch-project`, `session-switch` (10k-message stress),
`live-terminal-switch`, `large-diff-toggle`, `workspace-switch`.
Flows deleted (2): `launch-empty-home`, `three-pane-resize`.

## Deleted with no e2e replacement (conscious cuts)

- **Pages/Arena surface** — wired but superseded by Docs v2 direction; revisit when Docs
  v2 lands.
- **Marketplace** — peripheral to the core loop; catalog churn too high.
- `signed-cloud-relay-live`, `signed-user-hosted-relay-live`, `hosted-better-auth-live`,
  `deployment-portability-staging`, `remote-access-live`, `live-happyflows`,
  `real-cloud-workspace-relay`, `restoration-e2e-2/3` — self-host/control-plane concerns;
  belong as integration tests in `claxedo-server` if kept at all.
- Legacy terminal persist-scope migration → unit test, not e2e.
- WS-1008 PTY recovery and SSE agent-dot reconciliation → accepted gaps unless a test
  hook can force them deterministically.
- `e2e/bun/workspace-relay-connection.test.ts` → move to `src/` as a unit test.

All other existing spec files are deleted; their salvageable scenarios are enumerated
above under their new owning spec.

## Definition of Done

1. `e2e/INVARIANTS.md` exists stating the oracle and ownership rules; every spec file's
   header comment links to it.
2. `expectAssistantReplyVisible` helper exists; grep ratchet fails the build on any
   assistant-text assertion outside it.
3. Default mock streams status as separate events with the failure-shape variants listed
   above; the stale-busy scenario is a permanent, non-skipped test.
4. Exactly 20 spec files exist under `e2e/playwright/`; `test:e2e:all` is green.
5. CI runs `test:e2e:core` (specs 1–7) on every PR and the full 19 mocked specs nightly;
   spec 20 runs nightly on a credentialed runner with loud-skip semantics.
6. Zero `waitForTimeout` sleeps as the sole guard of a negative assertion.
