# e2e Invariants

This file is the constitution for `packages/claxedo-app/e2e/**`. It exists because the
prior suite failed ~20 rounds of the same regression class (assistant replies that never
visibly render) while staying green — every default spec fabricated the agent reply
itself instead of streaming a real busy→completed transition, and assertions targeted
only the user bubble slot while the assistant slot was hidden via `aria-hidden` in a way
Playwright's visibility checks don't catch. Every spec file links back here; this
document is authoritative on *why* the suite is shaped the way it is. Do not weaken any
rule below without updating this file first.

## The #1 rule: an assertion is a claim, not proof

Nothing is "done" because tests pass. Done = tests pass **AND** the visual evidence has
actually been looked at (by a vision-capable reviewer — AI or human) and confirms what the
assertions claim. An agent executing a spec in this suite must never report it complete on
green output alone.

1. **Nothing is "done" because tests pass.**
2. **Every oracle assertion produces evidence** — a screenshot captured at the moment of
   each claimed reply, into a per-run evidence directory
   (`test-results/evidence/<spec>/<scenario>.png`); core-suite runs additionally record
   video (`PLAYWRIGHT_VIDEO=1`).
3. **Evidence gets reviewed, not just archived.** After a spec goes green, its author (or a
   dedicated verifier) opens the oracle screenshots/video frames and confirms with their
   own eyes that the reply text is legibly rendered — not hidden, not covered, not
   off-screen, not a Thinking placeholder. The review verdict (`visual_verified:
   true/false`) is reported separately from the test verdict, and a spec is not accepted
   without it.
4. **If the evidence contradicts the assertion, the assertion is the bug.** Fix the
   oracle, never the evidence.

## The Oracle (verbatim from the plan)

Proof of a completed turn is ALL of:

- **DOM truth** — assistant reply **text** present inside
  `[data-slot="session-turn-assistant-content"]` whose `aria-hidden` is not `"true"`, the
  Thinking row gone, the submit control back to ready.
- **Geometric truth** — the reply element has a non-zero bounding box inside the
  viewport (after scroll), and a hit-test (`document.elementFromPoint` at its center)
  resolves inside the assistant content — this catches overlays, zero-height collapse, and
  off-screen rendering that CSS-visibility checks miss.
- **Visual evidence** — a screenshot captured at assertion time into
  `test-results/evidence/<spec>/<scenario>.png` (plus suite video), reviewed per the
  doctrine above.

Payload, store, message-count, and network assertions are supplements — never proof.

Implemented once as `e2e/helpers/turn-oracle.ts` (`expectAssistantReplyVisible`), used by
every send in every spec. A grep ratchet bans asserting assistant text any other way — see
"Authoring rules" below.

The default mock (`e2e/helpers/mock-runtime.ts`) streams `busy → message parts →
completed → idle` as **separate** events over real time, never pre-completed, never
instant idle. It ships variant hooks for stale-busy (completed message, idle never
arrives), delayed idle, error mid-turn, dispatch failure, and slow/failed config PATCH.

## Cross-cutting invariants

These hold across every spec in this suite. A spec that needs to violate one must say so
explicitly in its own SPEC block's INVARIANTS section, with a reason.

1. **Harness ownership.** The selected harness (opencode / claude-acp / codex-app-server /
   cursor-acp / pi / …) owns model, effort/variant, and submit payload shape at every
   stage of a session's life — draft, first send, mid-session change, reload, follow-up
   send. Exactly one model control exists in the DOM at a time, even mid-switch. A harness
   is locked once the session is created; nothing silently falls back to plain OpenCode.
2. **Workspace draft defaults are paired, session config is durable.** A new draft reads
   one server/workspace-scoped `{ harness, model }` pair. An explicit harness or model
   action atomically replaces that pair for future drafts; it never live-patches another
   already-open draft. Restoration validates the exact provider/model identity against
   that harness's live catalog or config options. A removed or disconnected saved model
   stays visibly unavailable and submit-blocked instead of silently substituting another
   model. After first-send promotion, server session config is the only authority and late
   draft/catalog responses are ignored.
3. **Completed assistant content is never hidden by stale busy state.** Once an assistant
   message's `time.completed` is set (or it carries an `error`), the turn is "settled" and
   its content slot must render regardless of what `session.status` is doing separately.
   (See `assistantMessageSettled` / `workingTurn` in
   `src/pages/session/message-timeline.tsx` — `workingTurn` requires `!turnSettled`, so a
   settled turn is never hidden by a late/never-arriving idle event.) Corollary: the
   **stale-busy** scenario — message completed, `session.idle` never sent — is a permanent
   non-skipped test (spec 5), not a `test.skip`.
4. **No silent fallback to OpenCode.** An unavailable/auth-error harness shows a red dot,
   disables submit, locks the editor, and sends **zero** requests. It never silently routes
   the turn through the default OpenCode runtime instead.
5. **Submit gating.** The submit control is the single source of truth for "can I send
   right now": `[data-action="prompt-submit"]`'s `data-icon` is `"stop"` while busy and
   something else (`"send"` / `"arrow-undo-down"`) when ready; it is `disabled` when
   gating (missing model/agent, readonly role, readiness polling, etc.) applies. Never
   assert readiness via a fixed `waitForTimeout` sleep — poll the control's actual state.

## The SPEC comment (every spec file, non-negotiable)

Every spec file opens with a `/** SPEC … */` block — a complete prose specification of the
feature it owns, written so that an engineer or AI agent who reads ONLY the spec file can
re-implement the feature in another language/framework:

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
no test, fails review.

## Authoring rules

1. **Shared helpers only.** Route mocking goes through `e2e/helpers/mock-runtime.ts`
   (`installMockRuntime`). Reply verification goes through `e2e/helpers/turn-oracle.ts`
   (`expectAssistantReplyVisible`, `expectTurnCounts`, `expectNoDuplicateRows`). Do not
   hand-roll a parallel mock or a parallel assistant-text assertion in a spec file — extend
   the shared helper instead, so every spec benefits from the fix.
2. **No bare `getByText` (or any other locator) for assistant text.** Assistant reply text
   is asserted **only** through `expectAssistantReplyVisible`. A spec that does
   `page.getByText(replyText)` or `page.locator('[data-slot="session-turn-assistant-
   content"]').getByText(...)` directly, instead of calling the oracle, is a regression —
   that is exactly the pattern that let the old suite pass while replies never rendered.
3. **No `waitForTimeout` as the sole guard of a negative.** "X did not happen" must be
   proven by a request-count/log assertion (`installMockRuntime`'s `requests` handle) or a
   deterministic wait (`expect.poll`, `page.waitForResponse`, a DOM state change) — never
   by sleeping N ms and hoping nothing showed up. `waitForTimeout` is fine as an
   *additional* settle buffer alongside a real assertion, never as the only proof.
4. **Behavior-number citations.** Every `test()` title or leading comment cites the
   BEHAVIORS number(s) from its file's SPEC block it is pinning, e.g. `test("core local
   session survives multiple turns and reload resume — behaviors 2,4 @core", ...)`.
5. **Evidence path convention.** Screenshots land at
   `test-results/evidence/<spec-file-basename-without-.spec.ts>/<test-title-slug>.png`.
   `expectAssistantReplyVisible` derives this automatically from Playwright's `testInfo`
   when no explicit `{spec, scenario}` is passed — prefer the automatic form.
6. **Three tiers: M, R, L.** A spec belongs to exactly one, and its filename prefix says
   which.
   - **Tier M** (`e2e/playwright/core-*.spec.ts`) mocks every route via
     `installMockRuntime`; it must never make a real network call.
   - **Tier R** (`e2e/playwright/real-*.spec.ts`, tagged `@core @tier-real`) is the
     close-to-real tier: real app, real `claxedo-server`, real embedded engine, real
     harness binaries (claude / codex CLIs), real workspace-runtime, and — in the cloud
     lane — a real relay and tunnel. It makes **zero** `page.route()` calls. The ONLY
     faked thing is the model HTTP endpoint: a deterministic scripted server, plus the
     provider-config/env injection that points the engine and harnesses at it
     (`OPENCODE_CONFIG_CONTENT`, `ANTHROPIC_BASE_URL`, `CODEX_CONFIG`). Faking anything
     else — a route, a runtime event, a session payload — moves the spec to Tier M. It
     runs hermetically with no credentials, so it belongs in every-PR CI; a missing
     binary or credential **fails** with a clear `GATING:` message, same loud-skip
     doctrine as Tier L. The oracle is mandatory. `core-workgraph.spec.ts`
     (`@workgraph-real`) is the pre-existing member of this tier family and is carved
     out of the sharded core lane the same way `@tier-real` is — via
     `test:e2e:core:base`'s `--grep-invert`, run by its own CI job.
   - **Tier L** (`e2e/playwright/live-*.spec.ts`) makes zero `page.route()` calls and
     fakes nothing at all — real models, real credentials. A missing credential/binary
     **fails** the test with a clear setup message (loud-skip) — silent `test.skip()` is
     forbidden in Tier L.
7. **Legacy suite.** `packages/claxedo-app/e2e-legacy/**` is retained for reference during
   the migration (salvageable scenarios, known-good route shapes) but is not part of the
   Playwright `testDir` (`./e2e`) and must never be re-wired into `playwright.config.ts`.
   Once every spec in the plan's spec list is ported, delete it.

## Spec index

The original consolidation was 25 spec files across two tiers (Tier M specs 1–21
mocked/fixture, Tier L specs 22–25 live); Tier R was added later per rule 6 and is
indexed alongside them. This file will grow a one-line link per spec, naming what each
one owns, as specs land:

- **1. `core-first-prompt-local`** — draft composer → first send → full session UI;
  oracle; exactly one user + one assistant row; optimistic user row before reconcile;
  attach-workspace-before-prompt guard.

## Testing gotchas

Operational lessons paid for in hours of chasing false signals. Do not relearn these.

1. **Tier M must run against `bun run dev`, never `vite preview`.** DEV-only seams get
   dead-code-eliminated in a preview build, producing false "regressions" that look like
   real breakage but are only a build-mode artifact.
2. **Cap roughly 3 concurrent Playwright suites machine-wide.** Recycle long-lived dev
   servers rather than spinning up more in parallel.
3. **SSE mocks need per-connection broadcast semantics, not drain-once queues.** A
   drain-once queue turns delivery into a lottery between the app's multiple stream
   consumers (fixed in `mock-runtime.ts`; keep new mock variants consistent with this).
4. **Playwright `page.route` matching is LIFO** — the last-registered handler wins.
   Order route registrations accordingly when a spec stacks more than one.
5. **A shared git index across parallel agent sessions means a bare `git commit` sweeps
   other agents' staged files.** Always commit by pathspec (`git commit --only <paths>`),
   never a bare `git commit` when other sessions may have work staged.
