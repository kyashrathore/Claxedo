# Re-evaluate the Cloudflare relay (owner-sanctioned re-run)

- **Status**: PLANNED (2026-07-17). To be executed by a single opus agent, phase-gated.
- **Owner context**: `docs/tech-docs/cloudflare-relay-evaluation.md` (2026-06-27, restored 2026-07-17) decided Fly/Bun for the Daytona path and said "don't re-run." The owner is explicitly sanctioning a re-run **this once** — because (a) the failure mechanism is now identified (Workers' 6-simultaneous-waiting-for-headers admission window × ~750ms cross-provider handshakes × shared egress IPs), which enables *targeted* experiments the June run couldn't design, and (b) platforms drift (CF limits/runtime, Daytona endpoints).
- **Prime directive for the executing agent**: this is measurement, not advocacy. Reproduce first, then test the mechanism hypotheses. If Phase 1 finds missing credentials, STOP and report — never fabricate rows, never substitute local mocks for "real relay deployments and real sandbox targets" (the June standard).

## Hypotheses under test

- **H0 (reproduction)**: CF relay → Daytona still fails the c200/load600 shape the same way (holder setup ~0/N, upstream `429`/`503`, connect p95 in seconds) while direct upgrades return `101`.
- **H1 (mechanism confirmation)**: pacing upstream opens to ≤6 concurrent handshakes (client-side admission ≤ ~8 opens/sec) eliminates the `429`/timeout signature but yields unacceptable connect-time tails at c200 (the queue math: ~25s). Confirms the window is the binding constraint.
- **H2 (sharding workaround)**: fanning upstream opens across a pool of N opener Durable Objects (each invocation owning ≤6 in-flight handshakes) multiplies the admission window to ~N×6 and materially restores holder setup at c200+. If H2 passes cleanly at c200 AND c1000 shapes, CF relay becomes re-viable and the June decision is genuinely reopened; if it fails (e.g., provider-side rate limiting of shared egress IPs dominates — `429`s persist despite sharding), the decision is re-confirmed with stronger evidence.
- **H3 (drift check)**: CF platform or Daytona behavior changed since June (different limits text, new WS endpoint, different admission behavior). Capture `developers.cloudflare.com/workers/platform/limits` "Simultaneous open connections" text verbatim at run time and diff against the quote in the evaluation doc.

## Phase 0 — build a minimal fresh bench kit (no deploys yet; nothing to "recover")

The June cleanup kept every load-bearing piece in `src/` — timing attribution (the trace fields benchmarks read), RAT/target/revocation caches, RHT coalescing, direct-HTTP admission, `/health`, the full DO relay in `cloudflare.ts` (incl. hibernation), `wrangler.toml`, `fly.toml`. What it deleted (throwaway loadgen scripts, generated reports, staging summaries) was deliberately disposable — do NOT mine git history for it. Build three small new things:

1. **Loadgen** — one Bun script (~300 lines), deployable to a Fly machine in `sin` (June's vantage): opens N direct + N relayed HTTP/WS pairs against a target and emits the row format from `docs/tech-docs/cloudflare-relay-evaluation.md` tables: {shape (cN/loadM), HTTP p99 overhead vs direct, WS-message p99 overhead vs direct, relayed WS delivered/attempted, direct WS delivered/attempted, connect p95, upstream-open p95, holder setup success, upstream failure codes}. Keep the June gates: **p99 overhead < 100ms**, **zero relayed-WS message loss**.
2. **Target provisioning glue** — spin one Daytona sandbox and one CF sandbox (`/proxy` WS path) via the provider APIs the product already integrates (see sandbox driver code / `credentials/sync.ts` provider list); record exact endpoints/regions.
3. **H2 experiment variant** — the opener-DO sharded `cloudflare.ts` (new experiment code; June never had it — see Phase 2.2).

Deliverable: `packages/workspace-relay/bench/` (self-contained; reports dir gitignored) + `RUNBOOK.md`. This kit is kept afterward as a permanent bench tool — the reason Phase 0 exists at all is that June's throwaway approach left nothing rerunnable. Gate: the loadgen dry-runs end-to-end against a local relay (`bun src/main.ts`) before any cloud deploy. The `dist-worker*` directories on disk are stale June build artifacts — ignore them; build variants fresh from current `src/`.

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

## Pre-flight review findings (2026-07-17, sonnet workflow, all defects adversarially verified)

**Healthy (verified with evidence):** CF relay source is complete and builds (`wrangler deploy --dry-run` → 168KB bundle, DO binding resolves, hibernation + outbound-WS paths present at cloudflare.ts:685/731/567; 74/74 tests). Fly/Bun relay: all six cleaned-patch items present with file:line; **local boot smoke passed** (`/health` 200; boot-gating env var names recorded in the review output). Package suite 311/311; both build pipelines reproduce from current src; tree clean.

**Confirmed defects → plan amendments (these OVERRIDE the corresponding text above):**

1. **BLOCKER — DO-side WS trace instrumentation does NOT exist in current `cloudflare.ts`** (it was part of June's removed "Cloudflare Worker fast-path experiments"). The WS trace mechanism (`relay.trace` {wsUpstreamOpenMs, queuedFrames, maxQueuedDelayMs}, gated by `x-claxedo-relay-ws-trace`) lives ONLY in `bun.ts:331-345`. Phase 0's "nothing to recover" is wrong for exactly this piece, and Phase 3's "DO trace fields on every row" was unsatisfiable for CF rows as written. **Amendment: Phase 0 gains deliverable 4 — port bun.ts's `relay.trace` WS instrumentation into cloudflare.ts's WS admit paths (experiment-grade, like the H2 variant). Fallback if the port fights the runtime: scope CF rows to loadgen-observed timing (connect p95 / upstream-open wall-clock) and say so in the report.**
2. **BLOCKER — June's Daytona snapshot identifier is unrecoverable.** `CLAXEDO_DAYTONA_SNAPSHOT` value exists nowhere: shell env, `packages/claxedo-server/.env` (which DOES hold `DAYTONA_API_KEY`), git history (`-S` search), Fly apps (`claxedo-relay-bench-0621-kyr` is suspended with ZERO secrets; `claxedo-selfhost-test` has the API key but no snapshot), and the credential-sync schema has no snapshot field. **Amendment: Phase 2.3 builds a FRESH snapshot via `packages/sandbox-manager/src/image.ts` `ensureSnapshot()`/`defaultSnapshotName()` (fallback confirmed real at :19-67). Comparability caveat goes in the report: rows compare against the fresh sandbox class, recalibrated by Row 1's direct baseline — June-row deltas are indicative, not exact.**
3. **DEGRADED — "direct HTTP admission default-on" is false.** `CLAXEDO_RELAY_DIRECT_HTTP_CONCURRENCY` has NO code default (`undefined` → unbounded; proven by main.ts:350-356 + the package's own test `main.test.ts:322`) and the committed `fly.toml` doesn't set it — while June's PASS row explicitly credits `q64`. Also verified: **no existing Fly relay app in this account** (fly.toml app names absent; only the suspended June bench app) — so Phase 2.1's "reuse if healthy" branch is dead and a fresh deploy is certain. **Amendment: Phase 2.1 MUST set `CLAXEDO_RELAY_DIRECT_HTTP_CONCURRENCY=64` (and verify via `flyctl secrets list`) on the control deploy.**
4. **DEGRADED — CF sandbox `/proxy` WS path**: the June fix IS in-tree (`packages/claxedo-server/scripts/sandbox/cloudflare-worker/src/index.ts:212-226`, `containerFetch` proxy) but it's a separately deployed sandbox worker — Phase 2.3's CF-sandbox target requires deploying that worker too, not just calling a driver. Amendment folded into Phase 2.3.
5. **Notes**: `wrangler.toml` has no `account_id` — deploys rely on the verified logged-in context (account `683a…af0e`, workers-write scopes confirmed) or `CLOUDFLARE_ACCOUNT_ID`. June's literal trace names (`relay_upstream_fetch`, `ws_upstream_open`…) don't exist in src — current names are the server-timing spans (`rat-verify`, `target-resolve`, `rht-cache`/`rht-mint`) and `relay.trace` fields; the loadgen must read the CURRENT names and the report must map them to June's table vocabulary.

**Phase 1 pre-verified during review** (agent must still re-confirm at run time): wrangler auth ✓ (account matches), flyctl auth ✓, `DAYTONA_API_KEY` ✓ (claxedo-server/.env + `claxedo-selfhost-test` Fly secrets), Fly relay app ✗ (fresh deploy), Daytona snapshot ✗ (build fresh, amendment 2).

## Phase 1 executed (2026-07-17) — live credential verification results

Every item validated with a real call, not just presence. Secret values never read into logs; the Daytona probe script was deleted after the run.

| Item | Status | Evidence |
|---|---|---|
| Cloudflare / wrangler | ✅ WORKING | `wrangler whoami`: logged in (kanusdlp@gmail.com), account `683a2c01a4d43b2fa998cde8ddedaf0e`, `workers_scripts (write)` scope; `deploy --dry-run` builds the DO worker (pre-flight). DO **paid-plan** only provable at first live deploy — first `wrangler deploy` is the residual check. |
| Fly / flyctl | ✅ WORKING | `auth whoami` OK; `apps list` OK; `sin` region available. NO relay app exists → Phase 2.1 fresh-deploy path confirmed (with `CLAXEDO_RELAY_DIRECT_HTTP_CONCURRENCY=64` per amendment 3). |
| Daytona API key | ✅ WORKING (live call) | Resolved from the local **managed encrypted store** (`sandboxDriverAuthManaged("daytona")` — server reports the driver `configured: true, source: managed, default: true` via `GET /api/workspace/drivers`), then a live SDK `list()` call **authenticated successfully**. Key also present as a Fly secret on `claxedo-selfhost-test`. |
| `CLAXEDO_DAYTONA_SNAPSHOT` | ✗ absent (handled) | Absent everywhere (env, repo, git `-S`, Fly secrets). Non-fatal: local driver falls back to the deterministic `SNAPSHOT_NAME` default and `ensureSnapshot()` builds it — amendment 2 applies. |
| `DAYTONA_API_URL` / `_ORGANIZATION_ID` / `_TARGET` | unset → SDK defaults | The live probe succeeded on defaults; no action. |
| Cloudflare **sandbox driver** | ✗ NOT configured | `GET /api/workspace/drivers`: `cloudflare configured: false`. Local construction requires `api_token` + `worker_url` (`workspace-supervisor-sandbox.ts`) — i.e. the sandbox worker (`scripts/sandbox/cloudflare-worker/`) must be deployed (wrangler OAuth suffices) and its URL+token configured during Phase 2.3. Affects **Row 6 (CF→CF control) only**; all Daytona rows unblocked. |
| Relay boot env (resolver URL, JWKS/PEM) | ✅ generated per-run | Pre-flight boot smoke passed with ephemeral generated keys; bench provisions its own. |

**Gate verdict: OPEN.** No blocking credential gaps for rows 1–5 and 7. Row 6 requires the Phase 2.3 sandbox-worker deploy + driver auth config (no new external credential needed — same CF account). Residual unknowns: CF paid-plan/DO activation (proven at first deploy), and Daytona org quota for sandbox creation (proven at first `ensureSnapshot`).

## Amendment update (2026-07-17, owner): snapshot via the standard release pipeline, not local fallback

Amendment 2's framing ("build a fresh snapshot locally via ensureSnapshot as a
workaround") is superseded. The snapshot is an ordinary build artifact of the
standard pipeline, and the pipeline is present in-tree:

1. Bump + publish the npm packages (`.github/workflows/claxedo-runtime-release.yml`) —
   the sandbox image installs published packages (bundle-first images).
2. Build the sandbox image/snapshot (`.github/workflows/claxedo-sandbox-image.yml`,
   which wraps `packages/claxedo-server/scripts/sandbox/build-sandbox-image.ts` +
   Dockerfile). The resulting snapshot name is the value to configure for the run.
3. For Row 6, the CF sandbox worker likewise deploys via
   `.github/workflows/deploy-cloudflare-sandbox-worker.yml` — Phase 2.3 triggers
   that job rather than hand-deploying.

Local `ensureSnapshot()` remains only an offline fallback if CI can't run.
Comparability framing corrected as well: benchmarking the CURRENT runtime image
is the point of a re-evaluation — June-image fidelity was never a goal, so the
missing June snapshot id is a non-issue, not a caveat to apologize for. The
report should simply record the fresh snapshot/package versions used.

## Pipeline verification executed (2026-07-17)

- **Runtime npm release workflow** (`claxedo-runtime-release`): existed but was BROKEN on first-ever dispatch (run 29597332410) — `workspace-runtime` declaration build failed because `@claxedo/workgraph`'s gitignored dist was never built (new dep from the connection-tools work), with a second latent failure behind it: **`NPM_TOKEN` is not set in Actions secrets**. Fixed on branch `fix/runtime-release-workgraph-dist` (PR #27 → dev): prerequisite workgraph build + `--dry-run` now compiles (skips only publish) + tokenless `dry_run` workflow input. Validated green in CI: run 29598259742 (1m44s, all six packages built+packed at 0.5.2). **Publishing 0.5.2 for real requires the owner to set `NPM_TOKEN`, merge PR #27, then dispatch with `dry_run=false`.**
- **Sandbox image workflow** (`claxedo-sandbox-image`): exists and WORKS — fresh dispatch on dev (run 29598415015, ~9min, success) pushed:
  - image: `ghcr.io/kyashrathore/claxedo-sandbox:workspace-runtime-0-5-1-ae435f536c-v8`
  - snapshot: `claxedo-workspace-runtime-0-5-1-ae435f536c-v8`
  - buildId: `ae435f536c`
  Phase 2.3 can pin this snapshot (or rebuild after 0.5.2 publishes) via `CLAXEDO_SNAPSHOT_NAME`/`CLAXEDO_DAYTONA_SNAPSHOT`.

## Local-first deploy gate (owner directive, 2026-07-17 — binding for every deploy in this plan)

Rule: **never deploy (or dispatch a CI workflow) to discover a failure. First run
the exact same thing locally under simulated production conditions; deploy only
after local passes.** Today's release-workflow failure (run 29597332410) is the
motivating incident: the build break was fully reproducible in a fresh local
worktree with the workflow's own commands — the CI dispatch taught us nothing a
local run wouldn't have, and cost two runs.

Concretely, before each deploy in this plan:

- **CI workflows** (release, sandbox image): reproduce the workflow's steps
  verbatim in a fresh worktree of the target ref — clean `bun install`, then the
  exact `run:` commands from the YAML. The release script's `--dry-run` now
  compiles everything (fixed today precisely so this gate works). For the image:
  `docker build` locally with the same Dockerfile/args before dispatching CI.
- **Cloudflare worker (relay + H2 variant + sandbox worker)**: boot under
  **Miniflare / `wrangler dev`** (workerd — the real runtime, locally): DO
  bindings resolve, hibernation handlers register, the loadgen smoke row runs
  against the local worker end-to-end. Only then `wrangler deploy`.
- **Fly relay**: boot locally in production shape — `NODE_ENV=production` with
  the full boot-gating env set (resolver URL/token, JWKS or PEM, signing key,
  `CLAXEDO_RELAY_DIRECT_HTTP_CONCURRENCY=64`) — and pass the loadgen smoke
  against it before `flyctl deploy`.
- **Loadgen**: dry-runs against a local relay before ever pointing at cloud
  (already a Phase 0 gate).

Honest limit of the gate: local simulation proves **code, config, and boot
correctness** — it cannot reproduce **platform admission behavior** (the 6-in-
flight-handshake window, shared egress IPs, provider rate limits are exactly
what the real deploys exist to measure). So: local-first eliminates avoidable
deploy failures; the benchmark rows remain the only source of platform truth.

## Phase 2 deploy-readiness prep (verified 2026-07-17, while Phase 0 runs)

Confirmed so the deploy phase hits no surprises:
- **Relay Dockerfile EXISTS** at `packages/workspace-relay/Dockerfile` (source-mode, oven/bun:1.3.14; build context = monorepo root). The fly.toml comment calling it "not yet in-tree" is STALE — ignore it. `fly deploy -c packages/workspace-relay/fly.toml` from repo root is viable.
- **Fly app must be created**: `claxedo-workspace-relay` does not exist in the account (only the suspended June bench app + selfhost). For the reeval, deploy a throwaway `claxedo-relay-reeval` app (`fly launch --copy-config --no-deploy` then `fly deploy`), NOT the prod name.
- **Instance-count tension to reconcile**: fly.toml warns SINGLE-INSTANCE-ONLY (prod v1 keeps host-tunnel sockets in process memory; multi-instance needs sticky routing not yet built), but June's PASS row was `m3` (3×2048MB). For the benchmark this is fine: the reeval app is a throwaway measurement, and the loadgen points every client at ONE relay origin, so replicate June's 3×2048MB `sin` shape for capacity headroom while accepting it's not a correctness-critical prod topology. Document the machine count used in each row.
- **Required prod-boot secrets** (relay fail-closes without them, `src/main.ts` validateProductionEnv): `CLAXEDO_RELAY_RESOLVER_URL`, `CLAXEDO_RELAY_RESOLVER_TOKEN`, `CLAXEDO_RELAY_HOST_SIGNING_KEY_PEM` (ephemeral refused in prod), `CLAXEDO_CONTROL_PLANE_JWKS_URL` or `CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM`, `CLAXEDO_RELAY_METRICS_TOKEN`, plus **`CLAXEDO_RELAY_DIRECT_HTTP_CONCURRENCY=64`** (amendment 3). The relay resolves workspace targets via the control-plane resolver — the bench needs a resolver reachable from Fly (either point at staging control-plane, or run the bench relay in a mode that resolves the single benchmark target directly; the loadgen/provision kit must supply the target mapping). **This resolver dependency is the biggest Phase-2 unknown — the Phase-0 provision.ts must expose how a relay reaches the Daytona sandbox target without a full control plane.**
- **CF sandbox worker (Row 6)**: deployable via `deploy-cloudflare-sandbox-worker.yml` (dispatch) — repo secrets `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` both present. GHCR image `ghcr.io/kyashrathore/claxedo-sandbox:workspace-runtime-0-5-1-ae435f536c-v8` exists.
- **Daytona snapshot**: fresh CI snapshot `claxedo-workspace-runtime-0-5-1-ae435f536c-v8` available; provision.ts uses it (or ensureSnapshot).

## Execution authorization (owner, 2026-07-17)

Owner: proceed end to end; **spend is NOT a stop condition** — do not gate on cost estimates. Binding rules for the run:
- Proceed autonomously through Phase 2 deploys once Phase 0's local-first gates are green (loadgen round-trips a relayed WS message locally; both CF workers boot under `wrangler dev`; `bun test src` green).
- STOP + report ONLY when a provider actually refuses: a hard paywall, a plan-required/permission rejection at deploy, or a quota/creation denial. A successful (billable) deploy is not a stop condition.
- Keep every deploy `-reeval`-suffixed and tear it all down after the run regardless.

## Phase 2 execution — BLOCKED on Daytona credential (2026-07-18)

Phase 0 verified independently (318/0 tests; real local relayed WS round-trip with `trace source=relay-trace`). Phase 2 deploys started; findings:

**Cloudflare deploy path PROVEN.** Deployed `claxedo-workspace-relay-reeval` (stock worker) — Durable Object binding accepted and live:
- `https://claxedo-workspace-relay-reeval.kanusdlp.workers.dev/health` -> `200 {"ok":true,"service":"workspace-relay","mode":"cloudflare-durable-object"}`
- Cloudflare paid-plan / DO activation is ACTIVE on account `683a…af0e` — the open unknown is resolved. (Worker kept up as evidence; in teardown checklist.)

**BLOCKER: the Daytona API key is expired/invalid.** The key in the local managed store (`dtn_…`, 68 chars, valid format) is rejected 401 Unauthorized on the real endpoint `https://app.daytona.io/api/sandbox` (raw authenticated probe, not just the SDK). An earlier `list()` probe's "OK" was a false positive — the SDK swallowed the auth error. Provision fails: `DaytonaAuthenticationError: Invalid credentials, statusCode 401`.

Impact: blocks the core cross-provider matrix (Rows 1–5) — every one targets a Daytona sandbox, and H0/H1/H2 are specifically CF-relay-to-Daytona. Cannot self-serve: the key is expired and cannot be minted locally. Per the plan's prime directive (missing credentials -> STOP and report), execution pauses here.

**Exact ask to unblock:** a fresh Daytona API key with sandbox-create permission (+ org id / api url if non-default). Then resume — everything else is staged (bench kit, CF deploy proven, Fly Dockerfile present, stub resolver/RAT working, fresh snapshot `claxedo-workspace-runtime-0-5-1-ae435f536c-v8`). Row 6 (CF->CF control) needs no Daytona but needs the CF sandbox worker deployed (`deploy-cloudflare-sandbox-worker.yml`) — can run independently if desired.
