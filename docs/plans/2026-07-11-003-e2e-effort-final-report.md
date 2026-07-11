# E2E Effort — Final Report (2026-07-09 → 2026-07-11)

Plan: `2026-07-10-001-refactor-e2e-20-spec-consolidation-plan.md`. Committed: `6d4a661e8e` (suite + fixes) + `1b2d2bf2c3` (broadcast-bus mock, ownership-cloud flips, live user-hosted spec).

## Final scoreboard

**Tier M (mocked): 21/21 spec files green**, each verified individually with vision-checked
evidence, on the post-Wave-1 tree. ~250 active scenarios passing; ~45 `test.fixme`s, every
one a source-cited known bug or documented unreachable-path, zero silent skips.

**Tier L (live, no mocks):**
- `live-user-hosted-relay` — 3 passed / 3 documented skips (real relay fixtures, real JWT
  mint/refresh, real WS tunnel; 17s).
- `live-claxedo-mcp-tools` — 10/13 passed LIVE against two real scratch backends
  (isolated data dirs); 3 documented gaps.
- `live-real-harness-smoke` — 1/5 live (opencode); loud-skip contract verified (unset
  flag → 5 visible reasoned skips). Claude/Codex legs remain cred/entitlement-gated.
- `live-agent-extensions-materialization` — written + local half exercised; Docker half
  blocked on sandbox-image build time in-session; loud-skip verified.

**Perf harness:** all 4 metrics kept (p95FrameMs, worstFrameMs, framesOver1667,
completionMs) + validation gates; `launch-empty-home` and `three-pane-resize` flows deleted.

**CI:** `.github/workflows/test.yml` now actually runs `bun run test:e2e:core` (it
previously set up browsers and ran nothing).

**Docs:** `e2e/INVARIANTS.md` (oracle + doctrine + authoring rules); every spec opens with
a SPEC block (PURPOSE/STATE MODEL/ANATOMY/numbered BEHAVIORS/INVARIANTS/HARNESS
NOTES/OUT OF SCOPE); tests cite behavior numbers.

## Why the old suite failed (the original question, answered)

The old suite couldn't catch the #1 flow because: every default spec fabricated the
assistant reply itself over `page.route` with instant-idle pre-completed messages (the
failing state machine was unreachable); assertions targeted the USER bubble slot — the
assistant slot was asserted nowhere, and it hides via `aria-hidden`, which Playwright's
visibility checks ignore; the one spec modeling stuck-busy was `test.skip`; and none of it
ran in CI. Green meant "the UI agrees with the mock author's imagination."

The replacement's core mechanisms: a three-layer oracle (DOM + geometric hit-test +
captured screenshot), a mandatory vision review of evidence before any "done" claim,
streaming mocks that can lie like production (stale-busy, delayed idle, error shapes),
SPEC-comment contracts, and a small no-mock live tier with loud-skip gating.

## App bugs FIXED in source during the effort (all with pinned regression tests)

1. Main composer never received status/activeTurn — stop icon + escalation banner never
   rendered (the original bug class, in production).
2. Notification permission prompted every turn; settings toggle was orphaned.
3. Process crash overwritten by stale `start()` snapshot (SSE/HTTP race) — green dot after exit.
4. Harness sessions invisible to the sidebar — `streamGlobalEvents` never subscribed to
   `claxedoBus` (server).
5. "Untitled session" forever — inventory writer dropped title updates with unresolvable
   projectID.
6. Config PATCH treated HTTP 500 as success + its toast title i18n key didn't exist.
7. remeda `groupBy` silently dropped undefined-family models.
8. `mod+\` dead split shortcut removed entirely (user decision).
9. Linux Claude credential-sync fallback (attributed via Wave −1 inventory).
10. (2026-07-11, post-report) Server projection store now persists SSE-only auto-titles —
    embedded runtimes' /global/event tapped via the existing SSE client into the existing
    `projectLocalSessionMetaFromEvent` write path; titles survive restart (SQLite-backed
    restart test). claxedo-server only.
11. (2026-07-11, post-report) Fresh-draft harness hydrate guard — fix staged by the wave
    thread via fixme-ledger reconciliation; e2e behavior-5 fixme flipped and verified
    (red-dot Unavailable state visually confirmed on a Claude draft).

## Pinned, still-open bugs (fixme ledger — each has a ready regression test)

- Duplicate `Session()` page mount after first send (blocks escalation banner rendering).
- Switcher tab status dot cache→DOM reactivity gap (query cache correct, DOM stale).
- Dead `mergeBusySessionStatus` guard (activeEvidence ignores status).
- Retry-storm architecture: `syncSessionSelection` swallows failures with permanent dirty
  flag (bounded-PATCH guard now asserts ≤2).
- Sidebar: drag-resize, hot-zone peek, archive-hover, sidebar-toggle width breakages.
- Terminal metadata doesn't survive rehydration on a non-owning URL; auto-open
  suppression window never engages.
- Codex plan stream has no plan UI (renders as plain text — pinned as intentional until
  decided otherwise).
- OPEN PRODUCT QUESTION: viewer role is not enforced at relay/runtime transport level —
  UI-gating only. Decide: server-side enforcement (fix) or documented contract.

## Operational lessons (codified in the plan docs)

- Tier M requires `bun run dev`, never `vite preview` (DEV seams get dead-code-eliminated
  — cost hours of false "regressions").
- ≤3 concurrent Playwright suites machine-wide; recycle long-lived dev servers.
- SSE mocks need per-connection broadcast semantics — drain-once queues make delivery a
  lottery between the app's multiple stream consumers (now fixed in `mock-runtime.ts`).
- Playwright routes are LIFO; `Win32` is `navigator.platform` in its Chromium everywhere.
- Agent reports are claims: the two worst false trails (prod-build seams, "helper
  regression" that was a stale server) were both broken by supervisor-run counter-probes.
- One git index, multiple writers: `git commit` sweeps others' staged work — commit by
  pathspec or not at all.

## Remaining (non-blocking, inherited by wave leader / nightly)

- Live smoke's Claude/Codex legs when creds/entitlements allow; extensions Docker half.
- Tier M-real workstream (plan §"Follow-up workstream") after waves settle.
- Fixme ledger ↔ audit-findings reconciliation is tracked in
  `2026-07-11-002-fixme-ledger-wp-reconciliation.md` (other thread owns).
