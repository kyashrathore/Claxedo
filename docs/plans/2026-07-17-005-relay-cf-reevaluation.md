# Re-evaluate the Cloudflare relay (owner-sanctioned re-run)

- **Status**: PLANNED (2026-07-17). To be executed by a single opus agent, phase-gated.
- **Owner context**: `docs/tech-docs/cloudflare-relay-evaluation.md` (2026-06-27, restored 2026-07-17) decided Fly/Bun for the Daytona path and said "don't re-run." The owner is explicitly sanctioning a re-run **this once** — because (a) the failure mechanism is now identified (Workers' 6-simultaneous-waiting-for-headers admission window × ~750ms cross-provider handshakes × shared egress IPs), which enables *targeted* experiments the June run couldn't design, and (b) platforms drift (CF limits/runtime, Daytona endpoints).
- **Prime directive for the executing agent**: this is measurement, not advocacy. Reproduce first, then test the mechanism hypotheses. If Phase 1 finds missing credentials, STOP and report — never fabricate rows, never substitute local mocks for "real relay deployments and real sandbox targets" (the June standard).

## Hypotheses under test

- **H0 (reproduction)**: CF relay → Daytona still fails the c200/load600 shape the same way (holder setup ~0/N, upstream `429`/`503`, connect p95 in seconds) while direct upgrades return `101`.
- **H1 (mechanism confirmation)**: pacing upstream opens to ≤6 concurrent handshakes (client-side admission ≤ ~8 opens/sec) eliminates the `429`/timeout signature but yields unacceptable connect-time tails at c200 (the queue math: ~25s). Confirms the window is the binding constraint.
- **H2 (sharding workaround)**: fanning upstream opens across a pool of N opener Durable Objects (each invocation owning ≤6 in-flight handshakes) multiplies the admission window to ~N×6 and materially restores holder setup at c200+. If H2 passes cleanly at c200 AND c1000 shapes, CF relay becomes re-viable and the June decision is genuinely reopened; if it fails (e.g., provider-side rate limiting of shared egress IPs dominates — `429`s persist despite sharding), the decision is re-confirmed with stronger evidence.
- **H3 (drift check)**: CF platform or Daytona behavior changed since June (different limits text, new WS endpoint, different admission behavior). Capture `developers.cloudflare.com/workers/platform/limits` "Simultaneous open connections" text verbatim at run time and diff against the quote in the evaluation doc.

## Phase 0 — recover the harness (no deploys yet)

The June harness was removed from the committed patch. Reconstruct from:
1. Mine these commits for remnants and context: `804b7b23c0` / `483f222f7c` (instrument cloudflare relay benchmark path), `5eeb705531` (split cloudflare gateway timings), `7c8ab06553` (cache cloudflare resolver lookups), `5122db56ff` (decision capture; added the evaluation + runbook docs). `git show <sha> --stat` then extract anything benchmark-shaped (loadgen scripts, row schemas, report generators).
2. Inventory what survives on disk: `packages/workspace-relay/` — `wrangler.toml`, `fly.toml`, `src/cloudflare.ts` (DO relay incl. hibernation path), `src/bun.ts`/`src/server.ts` (timing attribution kept per the runbook: RAT cache, target/revocation caches, RHT coalescing, direct HTTP admission, `/health`), and the `dist-worker*` variant directories (June's build artifacts: `enam`, `fast-http`, `ws-open-limiter`, `overlap` — read their diffs to understand which knobs each variant encoded).
3. If no loadgen survives: write a minimal one (Bun script, deployable to a Fly machine in `sin` to match June's vantage) that produces the SAME row format as the evaluation doc tables: per-row {shape (cN/loadM), HTTP p99 overhead vs direct, WS-message p99 overhead vs direct, relayed WS delivered/attempted, direct WS delivered/attempted, connect p95, upstream-open p95, holder setup success, upstream failure codes}. The June gate was **p99 overhead < 100ms** and **zero relayed-WS message loss**; keep those gates.
4. Deliverable: `packages/workspace-relay/bench/` (new, self-contained, gitignored artifacts dir) + a `RUNBOOK.md` inside it. Gate: harness dry-runs against a local relay (`bun src/main.ts`) end-to-end before any cloud deploy.

## Phase 1 — environment & credential inventory (HARD GATE)

Verify each item and produce a table (present / missing / where found). Do not proceed with missing items — report to owner.

| Need | Verify with |
|---|---|
| Cloudflare account + API token (deploy Workers/DO) | `wrangler whoami` (run in `packages/workspace-relay`); `account_id` in `wrangler.toml` valid |
| DO/Workers paid features (DOs require paid plan) | `wrangler deploy --dry-run` on the relay worker |
| Daytona API key + org | env/credential store: `DAYTONA_API_KEY` (check `~/.claxedo` credential store via server credential sync list, shell env, `.env*` files in repo, Fly secrets on existing apps: `flyctl secrets list -a <relay-app>`) |
| Daytona snapshot/image used in June | search repo + history for the snapshot name (`CLAXEDO_DAYTONA_SNAPSHOT`-style vars; see `credentials/sync.ts` provider list) |
| Fly account + org | `flyctl auth whoami`; `fly.toml` app name; existing relay app reachable (`curl https://<relay-app>.fly.dev/health`) |
| CF sandbox driver creds (for the CF→CF control row) | `CLAXEDO_SANDBOX_DRIVER=cloudflare` requirements per `public-docs/hosted-control-plane-worker.md` |
| Staging central (only if re-running the `central-fly-temp-*` rows; OPTIONAL — core matrix doesn't need it) | staging URL + auth from repo config |
| Loadgen vantage | ability to create one Fly machine in `sin` (June's region) |

Also verify local build prereqs: `bun install` clean in `packages/workspace-relay`, `wrangler` + `flyctl` CLIs installed and on PATH.

## Phase 2 — deploy

1. **Fly/Bun relay (control)**: reuse the existing Fly relay app if healthy, else deploy from `fly.toml` with 3×2048MB in the June-passing config (RAT cache, target cache, RHT coalescing, direct HTTP admission all default-on in current src). Gate: `/health` green.
2. **CF relay (subject)**: `wrangler deploy` the current `src/cloudflare.ts` worker (name it distinctly, e.g. `-reeval` suffix; do NOT touch any production DNS/routes). Deploy a second variant for H2 with the opener-DO sharding (implementation: an `OpenerDO` class; upstream WS opens are dispatched round-robin to `OPENER_COUNT` DO instances via stub fetch, each returning the established socket handle back through the bridge — if socket handoff between DOs proves impossible in the runtime, document that as an H2 result in itself: sharding is architecturally unavailable, which is decision-grade evidence).
3. **Targets**: one Daytona sandbox (June's class) exposing the same WS endpoint; one CF sandbox with the `/proxy` WS path (control pair). Record exact endpoints/regions.
4. **Teardown discipline**: every deploy tagged `-reeval`; a teardown checklist in the RUNBOOK; nothing persists after the run except reports. Budget guard: stop and report if projected provider spend exceeds ~$50 or sandboxes can't be created.

## Phase 3 — benchmark matrix (in order; stop early only on infra failure, not on bad numbers)

| # | Row | Purpose |
|---|---|---|
| 1 | Direct → Daytona (raw WS + HTTP), smoke + c200 | Baseline; must show `101` + clean messages, else the target is unfit and everything halts |
| 2 | Fly relay → Daytona: smoke, c200/load600, c140/load1000 | Control reproduction of the June PASS (~47ms/11.9ms p99 overheads, 800/800) |
| 3 | CF relay → Daytona: smoke, then c200/load600 | **H0** reproduction |
| 4 | CF relay → Daytona, paced opens (≤6 concurrent handshakes) at c200 | **H1** mechanism confirmation (expect: no 429s, terrible connect tails) |
| 5 | CF relay (sharded openers, N=8 then N=32) → Daytona at c200/load600; if it passes, c140/load1000 | **H2** the only row that can change the decision |
| 6 | CF relay → CF sandbox c200 | Control pair (June: passed) — distinguishes platform drift from cross-provider effects |
| 7 | Platform-limits text capture + `429` attribution (response headers/body from Daytona vs CF-injected) | **H3** |

Every row records the full metric set from Phase 0.3 plus the DO trace fields June used (upstream-open, queued frames, queue delay, established RTT). Direct-vs-relayed always measured in the same run window.

## Phase 4 — analysis & report (DoD)

Done means ALL of:
- The env table (Phase 1) delivered, complete.
- Rows 1–3 and 6–7 executed with real deployments; rows 4–5 executed unless H0 unexpectedly PASSES (if CF→Daytona now passes stock, H1/H2 are moot — say so).
- A dated section appended to `docs/tech-docs/cloudflare-relay-evaluation.md`: "Re-evaluation <date>" with the same table format, explicit verdict per hypothesis, and a one-paragraph recommendation (re-confirm Fly, or reopen CF with the sharded design + its measured numbers).
- Memory + `docs/plans/2026-07-17-004-*.md` §10 updated only if the verdict CHANGES the recorded direction.
- All `-reeval` infrastructure torn down; teardown checklist checked off in the report.
- Raw row artifacts saved under `packages/workspace-relay/bench/reports/` (gitignored) with the report linking filenames.

## Execution notes for the opus agent

- Branch: work on the current branch; do NOT commit; never touch production relay apps/routes — `-reeval` suffixed resources only.
- The repo's verification convention applies: numbers in the report must come from executed runs with artifacts, never estimated. If a row can't run, the report says "did not run" + why.
- Time-box: if Phase 0+1 exceed a day of effort or Phase 1 has ≥1 missing credential, stop and report — the owner would rather decide than have you improvise access.
