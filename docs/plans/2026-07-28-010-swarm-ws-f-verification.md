# WS-F — Verification: the headless whole-system e2e + the stress suite

**Parent:** `2026-07-28-004`. Runs CONTINUOUSLY alongside WS-B..E (its harness lands first, its scenarios grow per workstream). This WS is the answer to two owner directives: "one (or more) headless great e2e test that proves the entire system works, especially the fragile parts" and "stress tests — the system is scalable and reliable, survives under significant load."

## F0. Verdict on the current e2e (the requested review)

**What exists is good but browser-bound and gap-shaped.** `core-workgraph.spec.ts` (18 tests, `@workgraph-real`, own CI job) covers intake→confirm→launch→complete against the real harness — but proves durability by `page.reload()`, never live push. The **fragile parts have zero e2e coverage** (from the landscape sweep): doorbell delivery publisher→room→client (no `sync-lifecycle` test at all), missed-nudge recovery, fencing rejection (unit/conformance only), sweep recovery via real timers (tests call `runReconcile()` manually), landing-gate rejection (domain-only), the reject direction of approval. Convex NEVER runs the shared conformance suite (SQLite + in-memory only; Convex is tested via `ConvexHarness`, a fake db with **no index enforcement**). `convex-test` is installed and unused. The harness gold: `real-workgraph-harness.ts` — real SQLite router, real reconcile loop, scripted connectors, and `realSessions: true` spawning a REAL OpenCode subprocess against a **fake OpenAI-compatible provider** (`:941-1259`, prompt-pattern → scripted tool calls). `real-workgraph-harness.test.ts` proves the harness runs pure-node (no browser). CI slots: extend `test:e2e:bun` (pure node vitest — cheapest), or a claxedo-server vitest for the hosted composition.

**Verdict: build TWO new headless suites** (no browser; Playwright suites stay for UI):

## F1. `journey-local.e2e.test.ts` — the whole system, local composition (pure node)

Location: `packages/claxedo-app/e2e/` beside `real-workgraph-harness.test.ts`, in the `test:e2e:bun` lane (new script `test:e2e:journey`, own CI job, 30-min budget). Built on `createRealWorkGraphHarness({ realSessions: true, realMasters: true })` + scripted connectors + fake provider. **One serial journey plus fragile-part scenarios**, each a named `test()`:

1. **The loop:** webhook → candidate → stage (revision frozen) → proposal (fake-provider-scripted plan) → confirm → born-approved human task + born-Staged agent task → approve → drain launches (real OpenCode subprocess) → checkpoints → evidence → complete (contract satisfied) → master turn (receipts) → stream PR state. Assert every hop by API, not UI.
2. **Autonomy variant (after WS-C):** same fixture, autonomous charter → agent-discovered work launches with zero approvals; untrusted-source fixture stays Staged; budget exhaustion halts the drain with the attention row.
3. **Resume (after WS-C):** kill the fake provider mid-turn (connection drop) → run parks (lease KEPT) → resume reattaches the SAME session id → transcript grows past the break. Then the **zombie**: `restart_run`, replay the old generation's completion → fenced rejection.
4. **Doorbell truth (after WS-B):** subscribe to the harness event stream; a command yields exactly one doorbell carrying a cursor ≥ the command's; a doorbell replay with a stale cursor triggers no fetch (spy on the client fn — use the extracted `sync-lifecycle` logic in node, not a browser).
5. **Sweep recovery (after WS-B):** suppress the settle nudge (harness hook), advance real timers → the dirty-set drain recovers the tenant within one tick; assert O(dirty) work via call counting.
6. **Landing gate:** fake provider scripts a diff adding `@ts-ignore` → land rejected, honest fix passes (positive control pair). **Reject direction:** reject-with-reason → agent-visible reason on the run.
7. **Swarm shape (after WS-D):** 4-wide worktree charter, 6 runnable tasks → ≤4 live leases, all landed serially through the gate, zero orphan worktrees after close; subtask fan-out with `forbidden_for_subtask` probe; child-stream promotion → carve + parent-close blocked.

## F2. `journey-hosted.e2e.test.ts` — the hosted composition, headless

Location: `packages/claxedo-server/src/workgraph-host/` beside `hosted.test.ts`. Drives `createHostedApp` fully in-process (`app.fetch(new Request(...))` — the pattern from `hosted-app.test.ts:177-193`) with the recording LiveSyncRoom stub (`hosted.test.ts:20-34`) and **convex-test as the store** (replacing `ConvexHarness` for THIS suite so indexes/transactions are real — the fake db enforces neither). Scenarios: the command→settle→doorbell path, fencing via HTTP run-operation calls, born-state policy over the wire, budget gate at claim, cursor-feed exactly-once under concurrent commands (B1's positive control at the HTTP layer). **Also: adapt the shared conformance suite to run against the convex-test-backed store** — closing the "Convex never runs conformance" hole is part of this WS's DoD.

## F3. Stress suite — `packages/claxedo-server/scripts/stress-workgraph.ts` + gates

**Grounding.** Templates: `stress-relay-runtime-apis.ts` (fully local, in-process boot — the shape to copy); percentile/gate lib to reuse: `workspace-relay/bench/lib/stats.ts` (`percentile`, `evaluateGates:87`, markdown writer `:120-139`) — import it, don't reimplement (the staging scripts each hand-roll one; leave-it-better: don't add a fourth). Largest existing fixture: 501 outbox rows (`hosted-runtime.test.ts:264`) — nothing at real volume exists.

**Three lanes, all headless, each with explicit gates written into the script (relay-bench style, FAIL = nonzero exit):**
1. **SQLite lane (local ceiling):** direct `createSqliteWorkGraphService` (`store.ts:696`, `:memory:` and file) — T tenants × S streams × N tasks; measure command p50/p95/p99, drain throughput (launches/s with a no-op execution port), snapshot read time at 10k-change history, feed replay exactly-once at volume. Gates (initial, tune after first run): command p99 < 50ms in-memory / < 150ms file; zero lost/dup changes at 10k.
2. **Hosted-logic lane (contention truth):** the F2 composition (convex-test) — K=16 concurrent commands × M streams under ONE owner: assert no cross-stream conflict retries after B1 (the A5 fix's load proof), doorbell fan-out 1→256 recorded nudges, dirty-drain at 1,000 tenants/3 dirty = O(3) calls, budget fold idempotent at 5k usage rows.
3. **Real-Convex lane (optional, env-gated like the staging scripts):** same driver pointed at a dev deployment via `CLAXEDO_WORKSPACE_AUTHORITY_URL` from `.env.local` (never CI-default); documents the honest caveat that convex-test ≠ Convex platform limits. Manual, pre-launch.

Reports → `packages/claxedo-server/bench-reports/` (gitignored), markdown row per run, run recorded in this doc's log section by the executing agent.

## F4. CI wiring

- `journey-local` = new job cloning `e2e-workgraph`'s isolation (no shard, 30 min, `CLAXEDO_E2E_PREBUILT` not needed — pure node).
- `journey-hosted` runs inside the existing claxedo-server test job (respect the 210–280s suite reality; keep the new file's runtime < 120s by scenario batching or split job).
- Stress lanes 1–2: a nightly/manual workflow (not per-PR), gates enforced; lane 3 manual only.

## DoD
- All F1/F2 scenarios exist as named tests and are green; each fragile part from F0's gap table has at least one covering scenario (map them 1:1 in the PR description).
- Conformance runs against three backends (in-memory, SQLite, convex-test) — version bump recorded.
- Stress script committed with gates; first report checked into the PR description (not the repo); regressions fail the nightly.
- The F0 gap table re-audited at the end: every row flipped to covered-by:<test> or explicitly deferred with a chip.
