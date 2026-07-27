# 2026-07-27-001 — Bind the e2e mock's responses to real backend shapes

Status: PLANNED (not started)
Owner: unassigned
Prereq: the route-shadowing guard from `dev` @ `e698c8af5c` follow-up must land first — it covers a class this plan does NOT.

## Why

Three separate bugs this week had the same shape: a signal the e2e suite depended on was
**permanently, silently false**, and the suite stayed green throughout.

1. `requests.unhandled` was declared, asserted on (`core-boot-deep-links-home.spec.ts:470`),
   and written to by nothing. The "did any request escape the mock?" tripwire had never been
   capable of failing. It was hiding unmocked `POST /session/:id/abort`, `/find`, `/find/file`,
   `/file/content`, `/api/wr/diff/vcs/file`, and `/api/control/sessions`.
2. `**/session/status**` never executed in any spec. The later-registered `**/session/*`
   catch-all shadowed it (Playwright matches most-recently-registered-first, and
   `/session/status` is shaped exactly like `/session/:id`). Every `client.session.status()`
   call in the entire suite received a **session row**. It decoded as "everything idle"
   because consumers read `statuses[id] ?? {type:"idle"}` and a session row has no such key.
3. The cloud lane's `${base}/permission**` shadowed `**/permission/modes**`, returning `[]`
   where a `HarnessModeReport` object was contracted — which crashed the composer's render
   and took the whole app into the ErrorBoundary.

Common cause: **the mock is free to answer with a body the real server could never send, and
nothing compares the two.** In (2) the mock's *intended* payload was itself impossible — both
server paths drop idle entries, so an idle session is an absent key, never `{type:"idle"}`.

## The distinction that shapes this plan

Asserting the shape of what each **handler builds** would NOT have caught (2). That handler
was never invoked; the wrong body came from a different, perfectly valid handler.

To catch that class you must assert at the **received** boundary: for the path the app actually
requested, does the body it got satisfy that path's contract?

- Route-shadowing guard (separate, lands first) → catches "the route never ran".
- Response observer (this plan) → catches "the body is not what the server would send".

Neither subsumes the other. Both are needed.

## Approach

A response observer in `installMockRuntime`, keyed by **path pattern → contract**, that
validates every fulfilled response and throws loudly on mismatch. Not per-handler type
annotations — those are wide, mechanical, and miss the shadowing case.

Bind incrementally, by tier, in this order:

**Tier 1 — workspace-runtime routes.** Real types are one import away; already proven by
`e2e/helpers/contracts/session-prompt.ts`, which imports `SessionPromptBody` from
`@claxedo/workspace-runtime/routes` so drift breaks the build. Also `session-status.ts`
(added 2026-07-27), `session-create`, `session-config`, `session-command`,
`session-interactions`, `agent-config-harness`. **Do this tier wholesale.**

**Tier 2 — control-plane / opencode-compat / relay.** Types live in other packages and are
not all exported. Each needs the response type extracted at its source first. Scope per route;
do not block Tier 1 on it.

**Tier 3 — deliberately excluded.** SSE streams and error envelopes are legitimately variable;
a rigid contract there is noise, not safety. Record the exclusion and the reason.

## Definition of done

- [ ] Response observer validates every fulfilled response whose path has a binding, and
      **throws** (not warns) on mismatch. A warning reproduces the original failure mode.
- [ ] Observer proven non-vacuous: a deliberately wrong body for a bound route fails the run;
      scaffolding removed afterwards. **A green suite is not evidence the observer works.**
- [ ] Tier 1 fully bound. Every `packages/workspace-runtime/src/routes/*` route the mock
      serves has a binding importing the REAL type, not a hand-copied literal.
- [ ] Tier 2 routes triaged in a table: route → source of truth → bound / blocked-on-export /
      excluded, with a reason for each.
- [ ] Tier 3 exclusions listed with reasons, in the code, not only here.
- [ ] Every spec the observer breaks is fixed, and each is labelled **mock bug** or
      **product bug** explicitly. Expect fallout: specs may be passing on wrong bodies today,
      exactly as `/session/status` was. That fallout is the point, not a setback.
- [ ] No assertion weakened and no architecture guard, size budget, or debt baseline relaxed
      to go green — split files instead (repo convention, see `442e8d17e4`).
- [ ] Full sharded suite green: `E2E_OUT_DIR=/tmp/e2e-contracts script/cbx-e2e-shard.sh <box>`.
      Baseline to beat: **297 passed / 9 skipped / 0 failed** (`dev` @ `e698c8af5c`).
- [ ] `bun run typecheck` clean in `packages/claxedo-app`; `bun test --conditions=browser
      --preload ./happydom.ts ./src` green.

## Gotchas (measured this week — do not re-derive)

- `CLAXEDO_E2E_PREBUILT=1` is MANDATORY for any e2e run, plus `VITE_CLAXEDO_E2E=1`,
  `VITE_AUTH_ENABLED=true`, `VITE_CLAXEDO_SERVER_URL`. Without prebuilt, the dev server's cold
  transforms produce `toBeVisible` timeouts indistinguishable from real blank-page bugs (the
  workflow records 188 such timeouts / 2.5h). `script/cbx-e2e-shard.sh` bakes all of it in.
- Escaped requests do NOT fail loudly. Same-origin they return the SPA's `index.html` at
  **HTTP 200**; central-origin (`VITE_CLAXEDO_SERVER_URL`, nothing listening) they **reject**.
  Both decode as benign in callers that `.catch(() => [])`.
- Known-flaky, not caused by this work: `core-timeline-rendering-scroll.spec.ts:1000`
  (behaviors 7,9) ~1/16, and `core-harness-rendering-matrix.spec.ts:942` under box contention.
  Re-run either in isolation before reporting it as a failure.
- All three flakes above trace to the prompt dock's turn-end height animation. Fixing that one
  animation would likely clear the class — separate work, worth doing.

## Explicitly out of scope

Retyping all ~90 handlers to construct typed values. That is the wide, mechanical version of
this idea and it still misses the shadowing class. The observer is the cheaper and stronger
mechanism; per-handler typing can follow later if Tier 1 proves it worth the churn.
