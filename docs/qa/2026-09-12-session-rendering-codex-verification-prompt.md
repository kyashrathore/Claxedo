# Verify the session-rendering wave live, and back every bug with one e2e test

You are Codex working in the Claxedo monorepo at the repository root, branch `dev`. Read `CLAUDE.md` first and follow it. Then read `packages/claxedo-app/e2e/INVARIANTS.md` in full; its authoring rules are binding for every test you write.

## Ground rules

- Another session may be editing this worktree. Never run `git stash`, `git checkout --`, `git reset`, `git add -A`, or `git commit -a`. Commit only your own files, by explicit path: `git add -- <paths>` then `git commit -F <msg-file> -- <paths>`. End every commit message with `Co-Authored-By: Codex <noreply@openai.com>`.
- Do not fix application code in this pass. Your deliverable is an inventory of what is broken, each item backed by a test that proves it. A fix is a separate slice with its own review.
- Do not raise any architecture ratchet ceiling or size budget. `packages/claxedo-app/src/features/session/ui/message-timeline.tsx` is at its line budget; do not touch it.
- Comments follow `CLAUDE.md`: a comment says what the code cannot; no plan numbers, defect numbers, dates, or history. A skip reason describes what is broken, in the present tense, as a reader of the test would need it.
- Every claim of "verified" must be something you observed on screen or in a test you ran. A green test is a claim, not proof; the oracle rule in INVARIANTS.md applies.

## What you are verifying

`docs/qa/2026-09-12-session-rendering-qa-brief.md` lists 105 states, grouped in twelve parts, across the transcript, composer, rail, folding, grouping, content shift, the four agent surfaces, heavy-session scrolling, and cross-session navigation. That brief was written for a human tester. You run it instead, with computer-use on the real app, and you turn each finding into a test.

Read the brief once, end to end, before starting. Each state names what to do, what should happen, and what "off" looks like. The "known limits" at the end of Part 6 are not findings.

## Phase 1: live verification with computer-use

Run the real app and drive it with computer-use. Use the web app in a real browser for most states, and the desktop app for the states that only exist there (native-rendered long replies, `claxedo://` and `vscode://` links, `file://` opening on the OS). Launch recipes: `.claude/launch.json` at the root names the app and server entries; `packages/claxedo-desktop/package.json` has the desktop dev script. If a launch recipe does not work, fix the recipe or report it as the first finding; do not hand-roll a different way to start the app.

Harnesses: use every harness that is signed in or has a key on this machine. Check `claude --version` and its login, `codex` login, `cursor-agent` and `CURSOR_API_KEY`, and Pi at the version pinned in `packages/agent-sdk-runtime/src/harnesses/pi/executable.ts` (`PI_EXECUTABLE` may point at a pinned install). A harness you cannot run is recorded as "blocked: <reason>" for every state that needs it; it is never recorded as pass.

For each of the 105 states, in order:

1. Perform it exactly as written, on every available harness the state names.
2. Capture evidence: a screenshot for static outcomes; a short screen recording for anything about movement, flicker, duplication, or timing (Parts 1, 2, 9, 11, 12 are mostly this kind).
3. Record a verdict: `pass`, `fail`, or `blocked`, with one sentence of what you saw.

Write the results as you go to `docs/verification/session-rendering/2026-09-12/index.md`: one table row per state and harness (state number, harness, surface, verdict, evidence path, note). Put the evidence files beside it. Finish this table before Phase 2 so a reviewer can see the whole picture even if Phase 2 is cut short.

Assume the wave is broken in places. When a state passes too easily, try the adjacent variation the brief implies (faster, on the other harness, while streaming, after a reload).

## Phase 2: one test per finding, in a few core specs

Every `fail` in the table gets exactly one Playwright test. Every test lands in one of these four spec files under `packages/claxedo-app/e2e/playwright/`. Create the file if it does not exist; do not create a fifth.

| Spec file | Tier | Covers |
|---|---|---|
| `core-session-rendering-turns.spec.ts` | M | folding rules and their consistency, tool grouping and name normalisation, the running row, exit code, "Show all", the error card, question card, to-do surface, subagent chips |
| `core-session-rendering-composer.spec.ts` | M | send while busy (steer label, "Queued"), queued order, Stop scoped to the turn, "Thinking…" without a flap, attachment and draft scoping per session |
| `core-session-rendering-navigation.spec.ts` | M | rail order on click, send, idle and wake; first-frame fold and title latch on switch; no state leaking across rapid switches; Browser and subagent tabs surviving a switch; heavy-session scroll with no blank rows at reading speed; deep links |
| `real-session-rendering-harnesses.spec.ts` | R | the same rendering rules driven through real Claude, Codex and Pi binaries against the scripted model server: tool-name normalisation, grouping parity, exit code on a real failing command, the question card, steer mid-turn |

Before adding a test, check whether the behaviour already has a home in `core-timeline-rendering-scroll`, `core-harness-rendering-matrix`, `core-busy-abort-errors`, `core-sidebar-tree`, `core-docks`, `core-turns-reload-recovery` or `core-panes-split-tabs`. If it does, extend that existing test or add the case beside it there, and say so in the verification table. Do not duplicate a scenario across two files, and do not move existing tests.

How to write each test:

- Tier M drives the app through `installMockRuntime` (`e2e/helpers/mock-runtime.ts`): script the message and part events in the already-normalised shape the client stores, subagents through `MockRuntimeSubagentRow`, questions and permissions through their events, session status through `SessionStatusEvent`. Assert replies only through `expectAssistantReplyVisible`; use `expectNoDuplicateRows`, `expectTurnCounts`, and `SELECTORS` from `e2e/helpers/turn-oracle.ts`; use `e2e/helpers/geometry-oracle.ts` and `e2e/helpers/rail-oracle.ts` for position, blanking and order claims. Extend a shared helper rather than hand-rolling a locator in the spec.
- Tier R drives real binaries against `e2e/helpers/scripted-model-server.ts`, following `real-harness-local.spec.ts` for setup and its loud `GATING:` skip for a missing binary. Zero `page.route()` calls.
- Content-shift and blanking tests assert geometry, not feelings: capture the bounding rect of a named row before and after the event and assert it did not move, or sample rendered rows during a programmatic scroll and assert none is blank at the given speed. `core-timeline-rendering-scroll.spec.ts` has the scroll-anchor pattern to copy.
- Write the test red first: run it against the app and confirm it fails for the reason you observed live, not for a selector or setup error. Paste the failing assertion output into the verification table row.
- Then skip it: `test.fixme(true, "<what is broken>")` where the reason states the observed behaviour in the present tense and names the harness or surface if it is specific, for example `"a queued prompt sent third runs before the one sent second on Codex"`. No defect numbers, no dates, no "see plan".
- Add a register entry for every fixme in `packages/claxedo-app/e2e/e2e-decisions.md`, section 2, in the existing entry format (status, tests, expected, why, options A/B/C, decision left blank).
- A state that passed live still needs coverage if none exists and it is one of the rules in Parts 7, 8, 10, 11 or 12 of the brief. Add those as ordinary green tests in the same four files; keep them few and make each one prove a rule, not a screenshot.

Each spec file opens with the header comment INVARIANTS.md describes: what the file covers, where the state lives, the traps. Not a list of the tests.

## Gates you must run and report verbatim

From `packages/claxedo-app`:

```bash
CLAXEDO_E2E_SERVE_MODE=build-preview bun run build:e2e
CLAXEDO_E2E_SERVE_MODE=build-preview CLAXEDO_E2E_SUITE=core npx playwright test --config playwright.config.ts e2e/playwright/core-session-rendering-turns.spec.ts e2e/playwright/core-session-rendering-composer.spec.ts e2e/playwright/core-session-rendering-navigation.spec.ts
bun run test:e2e:real
bun run typecheck:e2e
bun run test:architecture
```

Use `build-preview` serve mode; dev mode reloads under concurrent edits and its failures mean nothing. Then from the root:

```bash
bun run lint
bun run test:architecture-ratchets
```

Lint must be zero. Ratchets must pass without a ceiling change.

Run each un-skipped new test three times; a test that passes twice and fails once is a flake you must diagnose and fix in the test before committing, never retry into green.

## Report

Deliver, in this order:

1. `docs/verification/session-rendering/2026-09-12/index.md`: the full 105-state table with verdicts and evidence, a summary count (pass / fail / blocked per harness), and the list of blocked harnesses with the exact reason.
2. The four spec files and any extended existing specs, committed by explicit path, with the register entries.
3. A closing message: how many findings, how many tests written red and skipped, how many green rule tests added, the exact gate commands and their tails, and anything you could not do with the reason.

Do not push.
