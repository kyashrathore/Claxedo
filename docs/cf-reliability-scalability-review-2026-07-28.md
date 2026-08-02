# Cloudflare Hosted Path — Reliability & Scalability Review

**Date:** 2026-07-28 · **Branch reviewed:** `security/pre-launch-remediation-2026-07-28` (~`ae4f2f0dc`, with uncommitted live-sync edits) · **Method:** four parallel code sweeps (control-plane request path, Durable Object topology, relay worker, Convex data layer), cross-checked against `docs/deployment-feasibility-2026-07-22.md` and `docs/plans/2026-07-18-001-cf-deployment-hardening.md`.

**The two questions this answers:**

1. **Is the hosted Cloudflare deployment reliable?** The *design* is reliability-minded (durable truth in Convex, DOs only as accelerators, real idempotency in the right places) — but several of its own safety nets are dead code, live-sync provably drops events, and nothing on the critical path has timeouts. Not operationally reliable yet.
2. **Does it scale to millions of users?** No. The first hard wall is at roughly **167 active tenants** (the background sweep starts crashing), with more walls at ~500 tenants, ~256-seat orgs, and a few thousand workspaces. The sharding shape is right, so most walls are removable incrementally — but today this is a low-hundreds-of-tenants system.

> **Both answers above are the 2026-07-28 verdict and are now partly out of date — see the status table below.** The 167- and 500-tenant walls are gone (A1), live-sync no longer drops events (B3), and the Convex request path now has timeouts (B5, half). The ~256-connections-per-org wall is gone too: **measured 2026-07-30**, one room holds at least 16,000 connections with p99 fan-out under half a second, so the cap was raised to a measured 2,000 and no sharding was needed (A4). That leaves Convex's transaction ceiling at a few thousand orgs/leases (A3) as the nearest remaining hard wall. The reliability verdict still stands in substance: the sandbox GC remains blind (B1) and the relay's failure modes are untouched and unproven (B6, B9).

Line numbers are as of this branch; verify before fixing — this branch was mid-remediation when reviewed.

---

## Status as of 2026-07-30 (re-verified against `dev`)

Every finding below was re-checked against the code on `dev`. **Six are fixed, one is partly fixed, one was overstated.** Findings carry a status line; the analysis is left as originally written so the reasoning stays auditable.

| Finding | Status | Evidence on `dev` |
|---|---|---|
| A1 sweep wall | **Fixed** | `hosted-runtime.ts:213-242` — subrequest budget + index-backed dirty/stale queries that clear themselves, so the work set self-rotates. No cursor needed. |
| A2 identity round-trips | **Fixed** | `workgraph-host/hosted.ts:283-303` — per-isolate `identityCache` keyed by token hash + org, TTL-expired. |
| A5 cursor serialization + snapshot stampede | **Fixed** | `workgraph_change_cursors` no longer exists; the doorbell carries a cursor and clients skip the refetch when current (`sync-lifecycle.ts:134-141`). |
| B2 dead minute-cron | **Fixed** | `wrangler.toml:53,156` register both crons; `worker-cron-drift.test.ts` guards the drift. |
| B3 problem 2 (no resume) | **Fixed** | `live-sync-room.ts` emits `id:` on data frames, keeps a replay buffer, and has a `replayGapEvent` path (`:439, :513`). |
| B4 503→401 mass logout | **Fixed** | `packages/workgraph/src/http/router.ts:98-111` — `isExplicitHttpError` propagates the real status, 503 marked retryable. |
| B5 timeouts | **Partly fixed** | Convex reads/writes now bounded (`adapters/convex/timeout.ts`, 5 s / 10 s). Retries, durable idempotency, and the W4 fenced lease remain open. |
| B1 sandbox reaper | **Overstated — see the correction in B1** | Daytona auto-stops idle sandboxes at 15 min by default, so compute was never unbounded. The real defect is a storage leak plus a blind GC. |
| A6(1) relay prod config | **Fixed 2026-07-30** | Top-level `[vars]` in the relay `wrangler.toml` with an explicit channel cap (256) and location hint; `relay-config-drift.test.ts` fails if either key goes missing from any environment. |

**A4** (the 256-connection room cap) is **resolved by measurement 2026-07-30** — raised to 2,000, sharding not built; see the measured section under A4.

Still open and unchanged: **A3** (Convex full-table scans), **A6(2–7)** (relay data path, regions, hibernation), **A7** (rate limiting), **B6** (relay failure modes), **B7** (Clerk membership drift), **B8** (R2 listing), **B9** (unproven parts — the benches were re-run in cloud 2026-07-30 and still FAIL; the channel-cap hypothesis is falsified and the cliff is now identified as unguarded WebSocket send backpressure in the DO, see A6 — unfixed, and the non-APAC vantage row is still open).

---

## 0. How the system fits together (read this first)

The hosted product is **not one server**. It is five cooperating pieces:

| Piece | What it is | What it holds |
|---|---|---|
| **Control-plane Worker** (`packages/claxedo-server`, `src/worker.ts` → `src/hosted-app.ts`) | A Cloudflare Worker: serverless code that runs in many short-lived **isolates** all over the world. There is no long-lived process and no shared memory between isolates. | Nothing durable. Every request re-derives what it needs. |
| **Convex** (repo-root `convex/`) | The database — a managed, transactional document store. **Queries** read; **mutations** are write transactions. Conflicting writes are resolved by optimistic concurrency (**OCC**): if two transactions touch the same document, one retries. Each transaction may only read a bounded number of documents. | All truth: orgs, memberships, workspaces, sessions, WorkGraph state, leases, billing mirror, wakes. |
| **Durable Objects (DOs)** | Cloudflare's "single-instance mini-server addressed by a name." Calling `idFromName("x")` from anywhere in the world always reaches the *same one instance*, which processes requests one at a time. DOs can hold WebSockets and can **hibernate** (sleep cheaply while keeping sockets open). | Coordination only: `LiveSyncRoom` (per-org fan-out of "something changed" pings), `WorkGraphSettler` / `ClaxedoWakeLane` (per-tenant timers that drive settlement), `WorkspaceRelayRoom` (per-workspace tunnel). |
| **Relay Worker** (`packages/workspace-relay`) | A second Worker whose DO tunnels every byte between the app in your browser and the sandbox where the agent runs. | The live tunnels. |
| **Sandboxes (Daytona / Cloudflare Sandboxes) + R2** | Where agents actually execute (the Worker can't run PTYs), and object storage for documents. | Running workspaces; document bodies/history. |

Two platform limits come up repeatedly below, so learn them now:

- **The subrequest cap.** One Worker invocation (one request, or one cron tick) may make on the order of **1,000 outbound calls** (`fetch`es, DO calls, etc.). Exceed it and the invocation dies mid-flight.
- **DO single-threading.** A DO processes one request at a time. That makes it a perfect lock — and a perfect bottleneck if you funnel too much through one name.

And one design idea to keep in mind: this codebase deliberately treats **Convex rows as the truth and DOs as accelerators**. A wake/settlement is written to Convex *first*, then a DO is pinged to act on it *soon*; if the ping is lost, a background sweep is supposed to find the row later. That design is sound — several findings below are cases where the *sweep half* of that promise is broken.

---

## Part A — Scalability ceilings, in the order they bite

### A1. ~~The 15-minute sweep dies at ~167 tenants — and ignores everyone past 500~~ — FIXED

> **Fixed (verified 2026-07-30).** Solved by a different shape than the one proposed below, and a better one. `listWorkerTenants` is gone; the sweep now pulls from `listDirtyTenants` + `listStaleTenants` (`hosted-runtime.ts:221-234`), both index-backed (`convex/workgraphRuntime.ts:316-318`, `by_dirty` with a bounded `.take()`). It applies a real `createSweepSubrequestBudget()` and slices the tenant set to `budget.remaining / SWEEP_MIN_SUBREQUESTS_PER_TENANT`, warning on the remainder rather than dying (`:237-242`).
>
> No persisted cursor is needed: because a swept tenant's dirty marker is cleared, the work set drains and self-rotates across ticks instead of re-presenting the same first-500 slice. That removes both walls — the ~167 subrequest crash and the never-swept tail past 500.

**Background.** Every 15 minutes a cron tick (`wrangler.toml:53`) runs `workGraphReconcile` — the "truth keeper" that finds tenants whose agent work stalled (a lost nudge, a crashed DO) and pushes it forward. It is the recovery net under the entire fast path.

**The problem, part 1 — no cursor.** The sweep asks Convex for its work set via `listWorkerTenants` (`src/workgraph-host/hosted-runtime.ts:206-211`), which is implemented as: *take the first 500 rows of the `org_memberships` table, in table order* (`convex/workgraphRuntime.ts:32-38`). No cursor, no rotation, no "continue where we left off." Tenant #501 is **never swept, ever**. Their only safety net is the fast-path nudge working perfectly every time — which is exactly the assumption the sweep exists to not make.

**The problem, part 2 — the subrequest wall.** For every tenant in that list, the sweep makes **6 Convex calls** (claim launches, claim control effects, drain session intake, claim source plans, list running source plans, list running attempts — `hosted-runtime.ts:238-243, 1008-1012, 1130-1134, 1168-1173, 1298-1302, 491-495`), fired concurrently across tenants (`hosted-runtime.ts:1434-1449`). That's `6N + 1` outbound calls before doing any actual work. The invocation's ~1,000-subrequest budget is exhausted at **N ≈ 167** (6×167+1 = 1,003). Each *claimed* launch then costs another ~8–12 calls (sandbox ensure, token mint, relay session create, prompt, …).

**What happens.** At ~167 active tenant memberships, the cron tick starts throwing every time. Because the work set is always the same first-500 slice, it never makes progress past the crash — the recovery net is gone **for everyone at once**, not just the tail. There is no subrequest counter, no deadline check, and no persisted cursor between runs.

**The fix.**
1. Give `listWorkerTenants` a real cursor (Convex pagination), persist the cursor between cron ticks (a tiny Convex doc), and rotate through the table across ticks.
2. Budget the tick: process at most K tenants per tick where `6K + overhead` stays comfortably under the cap (K ≈ 100), and stop early on a time/subrequest budget instead of dying.
3. Longer term, shrink the sweep's job: wakes-v2 (already staged behind `CLAXEDO_WAKES_SETTLEMENT=1`, staging-only today) writes the durable wake row *before* nudging the DO, so per-tenant recovery is wake-driven and the cron only needs to catch genuinely lost rows — a far smaller set than "all tenants."

**Done when:** a positive-control test with 1,000 fake memberships shows every tenant is visited within a bounded number of ticks, and a single tick provably stays under a configured subrequest budget.

---

### A2. ~~Every WorkGraph API call pays 3+ Convex round-trips — two of them writes~~ — FIXED

> **Fixed (verified 2026-07-30).** `ownerContext` now resolves through a per-isolate `identityCache` keyed by a hash of the token plus the org id, with TTL expiry and in-flight de-duplication so concurrent requests share one resolution rather than racing (`workgraph-host/hosted.ts:283-303`). Steady-state cost is the real query; the two identity mutations run on cache miss only.

**Background.** Everything the app does (load streams, send a command, read attention) goes through `/api/workgraph/*`. Before any of that runs, the Worker must answer "which org and which user is this?"

**The problem.** The answer is recomputed from scratch on **every request**: `ownerContext` (`src/workgraph-host/hosted.ts:255-258`) calls `orgs.resolveForMe` and `users.me` — and both are Convex **mutations** (write transactions), not queries, because they lazily create org/user rows on first sight. There is no cache keyed by the token. On top of that, each authority call constructs a brand-new `ConvexHttpClient` (`convex-authority-executor.ts:58-65`) with no timeout. So the floor for one API call is: JWT verify (cheap, local) + 2 Convex mutations + 1 Convex query for the actual work.

**What happens at scale.** Latency: every call pays two extra round-trips to Convex before doing anything. Cost: at millions of requests/day, you're buying 3× the Convex function calls you need, and 2/3 of them are write-priced. Throughput: mutations contend under OCC, so identity resolution — the one thing every request does — competes for write throughput with real work.

**The fix.** Resolution is deterministic per token: cache `(token hash) → {organizationId, ownerUserId}` with a short TTL (30–60 s) per isolate, and restructure the Convex side as *query first, mutate only on miss* (the row-creation path only matters the first time a user/org is ever seen). Reuse one `ConvexHttpClient` per isolate and give every Convex call an `AbortSignal.timeout`.

**Done when:** a repeated authenticated call shows exactly 1 Convex round-trip in steady state (the real query), verified by counting executor invocations in a test; first-ever-seen users still get their rows created.

---

### A3. Convex full-table scans on hot paths — slow today, throwing tomorrow

**Background.** In Convex, `.collect()` reads *every* matching document into the function. Without an index predicate, that's the whole table. Convex also caps how many documents one transaction may read (on the order of 16k) — so an unbounded scan doesn't degrade gracefully at scale, it starts **throwing**.

**The problem.** Full scans exist on genuinely hot paths:

| Where | What it scans | When it runs |
|---|---|---|
| `convex/sandboxLeases.ts:490` (`countActiveForOrg`) | **all** `runtime_leases` | **every hosted workspace create** (`hosted-workspace.ts:143`) |
| `convex/sandboxLeases.ts:543` / `:421` | all `runtime_leases` | Convex cron /10 min; Worker cron /15 min |
| `convex/billing.ts:379, 394, 418` | **all `orgs`** — three separate scans | /6 h and twice per 15-min sweep |
| `convex/orgs.ts:106` (`setActive`), `workspaceShares.ts:24` | all `orgs`, then a JS `.find()` | **every org switch** — despite the `by_clerk_org_id` index already existing (`schema.ts:59`) |
| `convex/orgs.ts:87-91` etc. | **every member of an org** to find one membership row | the common authz path — despite the compound `by_org_user` index existing (`schema.ts:166`) |
| `convex/orgs.ts:914` | all `orgs`, sorted, **to pick one** | hourly purge cron |
| `convex/usageMetering.ts:191, 258-267` | whole facts tables (the `limit` bounds *writes*, not the read) | hourly / daily crons |

The pattern is inconsistent, not uniformly wrong: `workgraphCommands.ts:80-81` and friends do the same lookups correctly with `.withIndex(...).unique()`, and `workgraphChanges.ts:542-547` even names a "no-unbounded-read" invariant. The discipline exists; it just wasn't applied everywhere.

**What happens.** At a few thousand workspaces/orgs, workspace creation and org switching get slower and OCC-conflict more (the create's read-set is the whole lease table, so *any* lease heartbeat conflicts with *any* create). Somewhere past that, the reads hit Convex's transaction ceiling and these paths hard-fail — including the billing sweep.

**The fix.** A mechanical index pass: `countActiveForOrg` gets an `by_org` index (its own comment says so — "if this table ever grows past the point where a scan is cheap, that index is the fix"); `setActive`/`grantedOrg` use the existing `by_clerk_org_id`; membership lookups use `by_org_user` + `.unique()` like the workgraph files already do; billing/purge/metering sweeps get status indexes + pagination. Then make the standard a lint/test: no `.collect()` without an index predicate, allowlisted exceptions only.

**Done when:** a grep-based guard test (or Convex lint) fails on new unbounded `.collect()`s, and the listed sites are converted with per-site tests that the results are unchanged.

---

### A4. One live-sync room per org, hard-capped at 256 connections

**Background.** Live updates ("your agent finished") are delivered by `LiveSyncRoom` — a DO per owner. Every browser tab opens one SSE stream that terminates in that DO; when something changes, the Worker "rings the doorbell" and the room fans a tiny ping to every held connection. The room is keyed **org-first**: any token with a Clerk org claim lands in `org:<clerkOrgId>` (`src/live-sync-room.ts:130-135`) — so *all members of an org share one DO instance*.

**The problem.** `MAX_CONNECTIONS = 256` (`live-sync-room.ts:34`); connection #257 is rejected with a hard 503 (`:250-252`). No test covers the cap. And since a DO is single-threaded, all of an org's fan-out — every nudge × every connection, each with an attachment read + visibility filter (`:308-322`) — serializes through one object.

**What happens.** An org with more than ~256 open tabs (a 150-person team with two tabs each is enough) starts getting 503s on the events stream, which the app experiences as "live updates never connect." Large orgs also concentrate all their doorbell traffic on one single-threaded object.

**The fix.** Shard the room by org when needed: key `org:<id>:<shard>` where shard = hash(subject) % N, and have the publisher ring all N shards (N can be 1 until an org grows; a tiny Convex-stored shard count per org makes it dynamic). Raise `MAX_CONNECTIONS` only after measuring — sharding is the real fix, the cap is just the symptom. Add a test that exercises the cap and the multi-shard ring.

**Done when:** a simulated 1,000-connection org connects fully across shards, every connection receives a published nudge, and the 503 path is only reachable per-shard.

#### Measured 2026-07-30 — the cap was the whole problem; sharding is NOT needed

> **The 256 was a guess, and it was wrong by nearly two orders of magnitude.** "Sharding is the real fix, the cap is just the symptom" (above) was asserted without measurement. Measured, it is backwards: one room holds far more than the 1,000-connection acceptance target, so sharding would add cursor-migration and shard-count-change hazards while removing no ceiling. **Resolution: the cap is now `DEFAULT_MAX_CONNECTIONS = 2_000`, one shared constant, and sharding is not built.**

**How it was measured.** `packages/claxedo-server/scripts/bench/live-sync-capacity.ts` drives concurrent connections into ONE `LiveSyncRoom` under workerd (miniflare), through the real `connectLiveSyncRoom` bridge and the real `state.acceptWebSocket` hibernation path — not doubles. The nudge is `document.changed`, which is **org-scoped** and therefore visible to every connection in the room: deliberately the widest fan-out the room supports. Connections accumulate across steps, so each row is fan-out to the full population. Run it with `node --import tsx scripts/bench/live-sync-capacity.ts 256 1000 4000`.

| connections | connect success | room-reported held | delivered | fan-out total | p50 | p99 |
| --- | --- | --- | --- | --- | --- | --- |
| 256 | 100% | 256 | 256 | 11 ms | 6 ms | 9 ms |
| 1,000 | 100% | 1,000 | 1,000 | 24 ms | 18 ms | 23 ms |
| 2,000 | 100% | 2,000 | 2,000 | 49 ms | 35 ms | 44 ms |
| 4,000 | 100% | 4,000 | 4,000 | 96 ms | 72 ms | 90 ms |
| 8,000 | 100% | 8,000 | 8,000 | 248 ms | 198 ms | 238 ms |
| 12,000 | 100% | 12,000 | 12,000 | 330 ms | 263 ms | 322 ms |
| 16,000 | 100% | 16,000 | 16,000 | 422 ms | 334 ms | 417 ms |
| 20,000 | 81.7% (harness limit) | — | — | — | — | — |

**Criterion and verdict.** The bar set before measuring was **nudge delivery p99 under ~1 s at 1,000 connections**. Actual p99 at 1,000 was **23 ms — roughly 40x inside the bar** — and the bar still held at 16,000 (417 ms). Fan-out is linear in held connections at ~26 µs each, which matches the work involved (one attachment read plus one `eventVisibleTo` per connection).

**The 16,000 figure is a floor, not a ceiling.** The failures above ~16,300 were the **harness's** in-process transport, not the room: the room refused nothing (`capRefused = 0`, a column the harness reports precisely so a policy rejection can never be misread as a measured ceiling). Cloudflare documents ~32k hibernatable sockets per DO, and nothing here contradicts that. **Do not cite 16,000 as the room's limit** — cite it as "at least 16,000, measurement bounded by the harness."

**Reproducing the ≥8,000 rows.** The room clamps its `LIVE_SYNC_MAX_CONNECTIONS` override to `MAX_CONNECTIONS_CEILING` (16,000), so those rows required temporarily raising that ceiling in `live-sync-room.ts` for the run. The clamp is back in place. The first attempt at 24,000 *did* stop at exactly 16,000 — which looked like a runtime ceiling and was really the clamp; that near-miss is why the harness grew the `capRefused` column before any number here was trusted.

**Why 2,000 and not higher.** An 8x margin under the lowest figure measured, chosen so org-wide fan-out p99 stays near 50 ms rather than 400 ms. A cap still earns its place because the fan-out loop is synchronous: it bounds how long one room monopolises its own single-threaded turn. `LIVE_SYNC_MAX_CONNECTIONS` allows a per-deployment override, clamped to 16,000 so a typo cannot push a room into territory nobody has measured.

**Two independent 256s, not one cap (found while writing the test).** The WS path counted `state.getWebSockets().length` and the SSE path counted `this.connections.size` — separate budgets, so a room at its WS limit still admitted a **full second population** of SSE connections, twice the intended load. Both now resolve through `this.size` against one constant, and a test pins it.

**Coverage.** The cap had zero tests. Now: both 503 paths and the shared budget in `live-sync-room.test.ts`, plus the 503 on real workerd in `live-sync-room.workerd.test.ts`. Each was positive-controlled — breaking the comparison, breaking enforcement outright, and reverting to the two-independent-counters shape each produced the expected failure before being restored.

**Still true from the original finding:** a room is single-threaded and an org's whole fan-out serializes through it. Measurement says that is affordable at the scales this product targets, not that it is free. If a single org ever needs >16,000 concurrent connections, sharding returns to the table — and the four hazards documented in `docs/plans/2026-07-30-001-fix-cf-reliability-remaining-plan.md` W2 (subscriber-side shard selection, silent blackout on shard-count decrease, cursors not surviving a shard move, and the name regex going dead under a `:<shard>` suffix) must all be addressed.

---

### A5. ~~Per-owner write serialization, and the snapshot stampede behind every doorbell~~ — FIXED

> **Fixed (verified 2026-07-30), both halves.** Write half: the `workgraph_change_cursors` table is gone from the schema and from `workgraphCommands.ts` entirely — there is no longer a per-`(org, owner)` row for every command to contend on. Read half: the doorbell now carries a cursor, and `sync-lifecycle.ts:134-141` compares it against the local watermark (with an explicit skew tolerance) and returns without scheduling a reload when the client is already current. A ding that changes nothing for a given tab now costs that tab nothing.

**Background.** Two halves of the same coin. Write half: every WorkGraph command bumps a per-`(org, owner)` cursor row — `workgraph_change_cursors` is patched on **every command** (`convex/workgraphCommands.ts:160-180`, invoked at `:192, :2712, :2756`). Under OCC, two transactions patching the same row can't commit concurrently — one retries. Read half: live-sync is deliberately "doorbell, not data" — the ping carries no payload, and each client re-fetches state over HTTP (`sync-lifecycle.ts:124`, debounced 100 ms).

**The problem.** The cursor row makes **all concurrent agents under one owner serialize** on one Convex document — that's the per-tenant write ceiling. And the read side amplifies: doorbells carry no cursor, so every ding makes every connected client re-fetch snapshot state whether or not it changed for them. (Correction 2026-07-28, deeper grounding: the eight unbounded `streamRows()` `.collect()`s at `workgraphCommands.ts:1784-1797` belong to **stream deletion**, not the snapshot read — the snapshot/changes path largely follows the bounded-read invariant already. The deletion path still needs paging, but the hot-path cost is the cursor-less doorbell, not unbounded snapshot reads.)

**What happens.** A single owner running 10 parallel agents sees commands queue on cursor OCC retries. An org with 50 open tabs and one chatty agent generates 50 full-snapshot reads per doorbell tick. Both costs grow multiplicatively with exactly the usage you want (more agents, more viewers).

**The fix.** Write half: allocate cursors per-stream instead of per-owner where ordering allows (the schema already has per-stream sequence rows), or batch cursor bumps within a command. Read half: bound `streamRows` (page or `take()` with explicit limits — the codebase's own "live-sync boundedness invariant" in `workgraphChanges.ts:542-547` is the template), and let the doorbell carry the cursor value so clients that are already current skip the re-fetch entirely.

**Done when:** two concurrent commands under one owner commit without cursor retries (or with bounded retries) in a positive-control test, and a doorbell with an unchanged cursor triggers zero snapshot fetches in the app.

---

### A6. The relay: every byte through one DO — expensive frames, APAC pinning, and a 16-channel prod cap

**Background.** The relay's DO-per-workspace (`workspace:<workspaceId>`, `packages/workspace-relay/src/cloudflare.ts:456-458`) is the *right* sharding: one workspace's traffic serializes through one object, different workspaces scale horizontally. But everything for that workspace — keystrokes, terminal output, agent event streams, file transfers — transits that single-threaded object with no bypass path.

**Four compounding problems:**

1. **The user-hosted frame path is very expensive.** Per frame: two `await`ed authorization checks (token revocation + target resolution, `cloudflare.ts:1113-1138`, cached 10 s/5 s per isolate), then a **character-by-character** base64 encode (`:372-376` — `for (const byte of bytes) binary += String.fromCharCode(byte)`), wrapped in a JSON envelope, and the reverse (`JSON.parse` + `atob`) on the other side. ~4 full traversals of every payload plus ~1.33× wire inflation. No batching or coalescing anywhere.
2. **Every room in the world is created in APAC.** `DEFAULT_RELAY_LOCATION_HINT = "apac"` (`cloudflare.ts:49-52`) and `CLAXEDO_RELAY_LOCATION_HINT` is set in **no** wrangler config. A DO's location is fixed at first creation — so a US user with a US sandbox crosses the Pacific twice on every frame, forever. The in-repo bench connect p95 of 807–1,371 ms is consistent with this.

   *Correction, 2026-07-30:* the APAC value is **deliberate, not an oversight** — the code comment states it is the closest Cloudflare hint for the India/South-Asia user base. The review implicitly assumed a US-centric user base. The defect is that it was **implicit**: production inherited it from a code default with nothing in any deploy config recording the choice. It is now declared explicitly in the relay `wrangler.toml` with the rationale and the revisit condition. The underlying limitation stands — one deployment-wide hint cannot serve a geographically split user base, and the real fix remains a per-workspace hint derived from the user's region at create time.
3. **~6 concurrent upstream connections per isolate.** Workers cap simultaneous outbound connections awaiting response headers at ~6, and a cross-provider WebSocket handshake counts (`src/worker-h2.ts:5-11`, which documents a measured ~25 s connect tail at 200 concurrent clients). The `worker-h2` sharding experiment addresses this but is explicitly not production.
4. **Production config is wrong.** ~~`wrangler.toml` has **no top-level `[vars]`**~~ — **fixed 2026-07-30.** `CLAXEDO_RELAY_TUNNEL_CHANNEL_CAP` existed only under `[env.staging.vars]` (32,768), so production ran the **default 16** WebSocket channels per host tunnel (`cloudflare.ts:160`, rejected with 503 at `:1470-1472`) — too low for one real workspace (terminal + event streams + docs), while staging's 32,768 equals Cloudflare's own per-DO socket ceiling, i.e. no cap at all. Production now declares 256 in a top-level `[vars]` block, staging keeps 32,768 for load benching, and `relay-config-drift.test.ts` fails if either key goes missing from either environment. The trap worth recording: **wrangler does not inherit `[vars]` into named environments** — every environment must restate every key, and an omitted key falls back to the code default rather than the top-level value. That non-inheritance is precisely how this defect arose.

   Still open in this bullet: the per-room `clients` set is unbounded (`:677-678`), and cloud-mode client sockets are accepted *without* the hibernation API (`:1391`), so cloud rooms can never hibernate (cost + eviction sensitivity).

**What happens.** Interactive latency is poor for everyone outside APAC by construction; per-workspace throughput is capped by frame-path CPU on one object; concurrency spikes hit the 6-connection wall; and prod silently rejects the 17th channel. The bench reports (`bench/reports/`, 2026-07-17) all FAIL their own gates — one 100k-message run delivered **22 of 100,000 frames**.

**Cause of that 22/100,000 identified 2026-07-30 (W7.1 cloud re-run) — it is NOT the
channel cap.** The cloud bench was re-run against current code with the production
256 cap (`claxedo-workspace-relay-reeval-0730`, Daytona target, dial-in topology).
The cliff **reproduced**: `c50x2000` delivered 0–26,000 of 100,000 (`1006`,
"Connection ended"). Two rows falsify the cap hypothesis outright: `c50x200`
delivered a clean **10,000/10,000** through the same relay, and `c10x2000` — only
**10** connections, far below any cap — still failed at 9,057/20,000. Message
volume per connection, not connection count, is the variable.

**Mechanism IDENTIFIED in a second cloud run, 2026-07-30: unguarded WebSocket send
backpressure in the Cloudflare Durable Object.** `sendSocket`
(`src/cloudflare.ts:1049-1056`) calls `socket.send()` in a `try/catch` and never
reads `bufferedAmount`, and both user-hosted directions use it fire-and-forget —
client→host at `:1676-1682` (every client frame `JSON.stringify`d onto the ONE
tunnel socket) and host→client at `:1793-1795`. When a producer outruns the socket's
drain rate the DO's outbound buffer grows until the runtime destroys the socket,
surfacing as `1006` "Connection ended" or — when the tunnel socket is the one that
dies (`:1908-1909`) — `1011` "User-hosted tunnel disconnected", taking every channel
with it.

The **Bun** relay guards exactly this, in exactly these two places
(`src/bun.ts:1412` and `:1435`, against `WS_BUFFERED_AMOUNT_MAX_BYTES_DEFAULT` =
8 MiB at `bun.ts:196`), closing with a named "backpressure limit exceeded" reason.
`grep bufferedAmount src/*.ts` returns **zero** hits in `cloudflare.ts`. That
asymmetry is the finding: same logic, one guard, opposite outcomes. The real DO is
clean on local workerd (2000/2000 in 98 ms), so only real network drain rates expose
it — which is why no local harness had caught it.

Four measurements pin it, each killing a rival explanation: at 20,000 total frames
`c50x400` PASSES while `c10x2000` FAILS (not total volume); `c1x2000` is clean at any
depth (not a per-connection ceiling); halving frame size to 32 bytes does **not**
rescue `c10x2000` (not bytes — queue entries); and the identical `c10x1600` shape run
three times gives FAIL 9725 → PASS 16000 → FAIL 14400, so it is a **race**, not a
fixed limit. Relay-side `wrangler tail` over 2,810 events recorded
`responseStreamDisconnected` ×39 with **`maxCpuTime` of 13 ms**, which also kills the
"DO is CPU-bound on the frame path" theory — the isolate is idle, waiting on I/O,
while its buffer overflows. The 6 `exception` outcomes carry an empty `exceptions`
array: the socket dies beneath the isolate rather than throwing into it, which is why
nothing was ever logged.

*Not fixed — fixing goes through a scoped task.* The shape is the Bun guard ported
across, but `WorkspaceRelayDurableObjectSocket` (`:277`) does not expose
`bufferedAmount` yet, so that must be surfaced first. A real interactive session is
nothing like 1,600 unacknowledged frames on ten channels, so this is a load-shape
hazard rather than a live-user outage — but it is why the zero-loss gate cannot pass.

*A separate, genuinely reproducible defect was found while investigating, but it is
NOT the cloud cause — recorded here so the two are not conflated.*
`bun bench/local-dialin.ts --messages N` on a SINGLE connection against a local Bun
relay: `N=64` delivers 64/64, `N=65` delivers **0/65**. That boundary is exactly
`DEFAULT_WS_PRE_OPEN_QUEUE_LIMIT = 64`
(`packages/workspace-runtime/src/workspace-relay-host-tunnel.ts:76`), enforced at
`:447-449`, where frames arriving past the limit while the host's upstream socket is
still `CONNECTING` close the channel with 1013 "Host upstream WebSocket queue
overflow". Confirmed both directions: `wsPreOpenQueueLimit: 100000` turns 0/2000
into 2000/2000, and `wsPreOpenQueueLimit: 1` makes even `--messages 4` fail. The
knob is set **only in tests** — every production call site
(`claxedo-server/src/user-hosted-tunnel.ts:137,198`,
`workspace-runtime/src/server.ts:656`) takes the hardcoded 64.

**Why this cannot be the cloud cliff:** the cloud `c50x200` row pipelines **200**
frames per connection — well past 64 — and delivered a clean 10,000/10,000. If the
pre-open queue were the cloud mechanism, that row would have failed. It is a local
race the loadgen wins or loses depending on whether the upstream socket opens before
the burst lands (localhost opens fast enough to expose it; the cloud path apparently
does not). Treat it as a real bug worth fixing on its own merits, with an unknown
blast radius in production, and keep hunting the cloud cause separately.

Two further defects found in the same run, both in shipping code:
- **The host tunnel's main socket has no `error` handler.** Per-channel upstream
  sockets get one (`workspace-relay-host-tunnel.ts:423`) but the tunnel socket
  itself only sets `onopen`/`onmessage`/`onclose` (`:512-623`). Under Node's `ws`,
  an `error` with no listener is an unhandled `'error'` event, so a transient
  relay 500 on reconnect **crashes the host process** rather than backing off —
  observed live: `Error: Unexpected server response: 500` → process exit, taking
  every channel with it. The reconnect/backoff logic below it is unreachable in
  exactly the case it exists for.
- **A relay 500 on host-tunnel re-registration** is what the client hit while the
  previous tunnel for the same `hostId` was still held. Worth a separate repro.

Also corrected: `wrangler.toml`'s Daytona snapshot pin in `bench/provision.ts`
(`claxedo-workspace-runtime-0-5-1-ae435f536c-v8`) **no longer exists** on the
account; the re-run used `claxedo-workspace-runtime-0-5-0-v7`.

**The fix.** In order of value: (1) set a real prod channel cap and an explicit per-deployment location hint (config-only — chip filed); (2) derive the hint per workspace from the sandbox/user region at first creation; (3) replace base64-in-JSON with binary WebSocket frames + a small binary header on the user-hosted path (the cloud path already does cheap pass-through — `:1434-1455` is the template); (4) hoist the per-frame auth checks to per-connection with revocation push instead of per-frame pull; (5) productionize upstream-open sharding from `worker-h2` if cloud fan-out concurrency matters; (6) hibernate cloud client sockets; (7) re-run the benches until the RUNBOOK gates pass and wire them into CI.

**Done when:** benches pass their existing gates (p99 overhead <100 ms, zero WS loss) from a non-APAC client region, and prod config review shows explicit cap + hint values. *Still open after the 2026-07-30 re-run: the run was executed from Jaipur, India (AS55836), i.e. APAC — the non-APAC-vantage requirement is NOT yet satisfied. The loss gate also still fails at 2,000 msgs/connection for a reason not yet identified.*

---

### A7. Rate limiting that doesn't actually limit

**Background.** Workers run in many isolates; anything stored in a JS `Map` exists per-isolate. The limiter here (`src/control-plane/rate-limit.ts:31-36`) is exactly that — an in-memory fixed window.

**The problem.** Real limit = configured limit × number of live isolates, and Cloudflare spins up isolates with load — so the limiter loosens precisely when it's needed. Worse, most of the surface has **no limiter at all**: the entire `/api/workgraph/*` surface (24 routes), all 28 document routes, checkpoint/lifecycle routes (which provision real infrastructure), bootstrap/events/session routes. Body-size caps exist in exactly one module (documents, 2 MiB — `documents.ts:29`); the Polar webhook reads its entire body uncapped before verifying (`billing-routes.ts:202-219`).

**What happens.** One misbehaving client (or one bug in the app's retry loop) can hammer Convex through unmetered routes; a large POST to any non-document route buffers unbounded in the isolate. Abuse economics get worse with scale, not better.

**The fix.** Move limits to something shared: Cloudflare's native rate-limiting binding (cheap, approximate — fine for abuse) or a small counter DO per principal (exact, costs a DO call). Apply a default limiter + body cap at the app level (one Hono middleware) with per-route overrides, rather than opt-in per route. Keep the in-memory limiter only as a first-layer local fuse.

**Done when:** a load test from two simulated isolates shows the global limit enforced, and every mounted route inherits a body cap unless explicitly exempted.

---

## Part B — Reliability defects (broken at any scale)

### B1. The sandbox leak reaper never runs — storage leak + blind GC ⚠️

> **Correction, 2026-07-30.** This finding was originally titled "unbounded money bleed" and claimed orphaned sandboxes "run and bill forever." **That is wrong on compute.** Daytona's auto-stop interval [defaults to 15 minutes](https://www.daytona.io/docs/en/sandboxes/) when unset — an orphan goes idle and stops on its own, so hourly compute was always bounded by the provider. Auto-archive then defaults to ~7 days.
>
> What is real, and what the layer-by-layer analysis below still establishes correctly:
> - **Auto-delete is disabled by default.** A stopped sandbox archives and keeps its filesystem in object storage indefinitely. Since snapshot disk size is the standing cost floor, that is a slow storage leak that nothing in the system would ever notice.
> - **The GC is blind, not merely idle.** The Daytona driver implements no `list()`, so `garbageCollect()` cannot enumerate provider state and returns success having done nothing. You have no way to ask "what is running that shouldn't be?" — which also means no way to *detect* the leak, only to pay for it.
>
> **Partly addressed 2026-07-30:** `hosted-services.ts` now passes explicit `autoStopMinutes`/`autoDeleteMinutes` to the Daytona driver (30 min / 24 h, from `CLAXEDO_SANDBOX_AUTO_STOP_MS` / `_AUTO_DELETE_MS`), converted to whole minutes with a one-minute floor — Daytona reads `0` for either interval as "immediately," and an auto-delete of `0` marks the sandbox *ephemeral*, destroying its filesystem on first stop. So stopped sandboxes now expire instead of archiving forever. **The `list()` gap and the silent-success GC report remain open** — provider-side expiry is a backstop, not a reaper.

**Background.** Hosted agents run in Daytona sandboxes that bill by the hour on **operator** keys. The safety design is three layers: (1) provider auto-stop, (2) an idle policy, (3) a 15-minute GC sweep that lists what the provider is actually running and destroys anything without a valid lease. The design comment at `worker.ts:323-331` says the quiet part: "a silently-dead reaper is the failure mode this design exists to avoid."

**The problem — all three layers were off:**
- GC returns empty unless the driver implements `list()` (`packages/sandbox-manager/src/index.ts:990-998`) — and the **Daytona driver has no `list`** (`drivers/daytona.ts:299-357`; only `exe` and `fetch-bridge` implement it). The sweep destroys nothing, ever, and the route still returns 200, so the cron looks green. **Still true on `dev`.**
- ~~Daytona `autoStop`/`autoDelete` are **never configured** on the hosted path~~ — **fixed 2026-07-30**, see the correction above. The driver always accepted `autoStopMinutes`/`autoDeleteMinutes` (`daytona.ts:99-100, 288-289`); the hosted branch simply never passed them, while the `fetch` bridge did. Note the original claim that the cron comment ("Daytona autoStop has long since bounded the money") was "currently false" is itself wrong — provider-default auto-stop *was* bounding compute all along.
- The idle policy `decideSandboxIdle` (`lease-policy.ts:95`) has **zero production callers**, and the lease→driver reconciliation query (`sandboxLeases.ts:592`) has zero callers. **Still true on `dev`.**

The only thing that runs is the Convex-side lease sweep, which *relabels table rows* — by design it holds no provider credentials and cannot destroy anything.

**What happens.** A sandbox orphaned by a crash mid-provision, a lost lease write, or a driver error idles out and stops on Daytona's own 15-minute timer, so it stops *costing compute* — but until the auto-delete fix it then archived and kept its filesystem indefinitely, and nothing in the system could see it either way. With auto-delete now passed, orphans expire after 24 h of being stopped. The remaining hole is visibility: with no `list()`, an orphan that provider expiry somehow misses is invisible, and the GC reports success regardless.

**The fix (chip filed; partly landed).** ~~pass auto-stop/auto-delete defaults in `hosted-services.ts`~~ (done 2026-07-30). Remaining: implement `list()` on the Daytona (and Cloudflare) driver; make GC's report distinguish "driver cannot list" from "nothing to collect" and alarm on the former; wire or delete the idle policy. Positive-control test: create a driver sandbox with no lease, run GC, assert it is destroyed — and assert current code FAILS that test first.

**Done when:** that positive-control test passes, and the GC route's response makes a listing-incapable driver loudly visible.

---

### B2. ~~The dead minute-cron backstop~~ — FIXED

> **Fixed (verified 2026-07-30).** `packages/claxedo-server/wrangler.toml` registers `["* * * * *", "*/15 * * * *"]` in both the production and staging blocks (`:53, :156`), so the stale-tenant lane runs. The drift guard the fix asked for exists: `worker-cron-drift.test.ts` parses the config and asserts every registered cron matches a live branch in `WORKER_SCHEDULED_DISPATCH` and vice versa, in both environments.

**Background.** Beyond the global 15-minute sweep, there's a finer recovery lane: every minute, find tenants whose settlement went stale and ping just their settler DOs (`worker.ts:337-351`).

**The problem.** The code gates that lane on `controller?.cron === "* * * * *"` — but `wrangler.toml` registers only `*/15 * * * *` (lines ~53 and ~156; cron triggers are not inherited by environments, so both were checked). The branch is **dead code in every environment**. Nobody noticed because nothing fails — recovery just silently degrades to the 15-minute sweep… which is the thing with the A1 walls.

**The fix (chip filed).** Decide the intent: register the `* * * * *` trigger, or fold the stale-tenant fan-out into the 15-minute tick with a subrequest budget. Then add a drift guard: a test that parses `wrangler.toml` and asserts every registered cron string matches a live branch in `scheduled()` and vice versa.

**Done when:** the stale-tenant lane demonstrably runs on schedule (staging observability), and the drift-guard test exists.

---

### B3. ~~Live-sync drops events: wrong-namespace publishers, and no way to catch up~~ — FIXED (both problems)

**Background.** Two identity namespaces exist: **Clerk claims** (what tokens carry: Clerk org id, Clerk subject) and **authority-internal ids** (Convex `orgs._id`). Passing the wrong one names a room no subscriber ever joins.

**Problem 1 — two of three publishers rang the wrong room — FIXED on this branch later on 2026-07-28.** At review time, document events passed the authority-internal org id (a self-declared `KNOWN GAP`) and agent attempt-operations were keyed `owner:<subject>`, so org-token subscribers received neither. A same-day parallel session **unified the namespace on authority-internal org ids**: the events route resolves `authority.resolveOrgId` at connect, and both publishers now derive names via `liveSyncRoomNameForPrincipal` (`hosted-app.ts:311-318`, `:516-522`), with e2e coverage. Clerk claims are now auth-only. Residual rule: never hand-compose an `org:` room name — always derive it (`live-sync-room.ts:501-502`).

**Problem 2 — no resume. — FIXED (verified 2026-07-30).** The room now emits `id:` on data frames (and deliberately not on periodic keepalives), keeps a bounded in-memory replay buffer, and synthesises an explicit gap event when a reconnecting client's cursor has fallen off the back of it (`live-sync-room.ts:104-109, 439, 513`). `Last-Event-ID` therefore advances and a nudge dropped while connected is recovered on reconnect rather than waiting for the user to poke the UI. *Original finding, for the record:* the SSE stream never emitted `id:` lines (`:329, 436`), so the client's `Last-Event-ID` machinery (`claxedo-events.tsx:461, 508-509`) never advanced, and recovery was edge-triggered only (`sync-lifecycle.ts:130-139`) with no periodic poll.

**What happened (before both fixes).** Teams (org tokens) saw stale documents and stale agent state until they poked the UI. Combined with problem 1, this was not a rare race — it was the steady state for two event classes.

**The fix.** Both halves landed: problem 1's namespace unification on 2026-07-28, problem 2's `id:`-line catch-up floor since. Nothing remains open in this finding.

**Done when:** a deliberately-dropped nudge is recovered within one poll/gap-detect interval without user interaction. ✅ **PROVEN 2026-07-30 against two real browsers.** The vision-verified two-browser drill (W5.4/W7.3) now exists and passes 8/8 with video: `packages/claxedo-server/scripts/drill/live-sync-two-browser.ts` drives two real Chromium browsers over real HTTP against workerd/miniflare serving the real `LiveSyncRoom` **and** the real `HostedShellRoutes` `/api/wr/events` — so the connect-time `resolveOrgId` namespace resolution (problem 1) is in the loop, not just the DO. A nudge published while browser B is disconnected is replayed from `Last-Event-ID` on reconnect with no interaction and nothing redundant, an evicted cursor yields the explicit `stream.replay-gap`, and reverting the fix at `live-sync-room.ts:773` takes the drill 8/8 → 4/8. Details, both positive controls, and the level-1.5 scoping are in the plan's `W7.3` entry.

⚠️ *One adjacent inaccuracy found by the drill, not a defect in this finding:* `live-sync-room.ts:432-433` says the in-memory ring's sequence reset "is not silent: `cursorAhead` turns a cursor from a lost sequence into the gap notice." `cursorAhead` is only reached on **connect**, so a connection HELD across a DO hibernation sees its cursor silently regress (measured: `id: 3` → `id: 1`). It still fails safe on the next reconnect either way — both paths measured in `scripts/drill/live-sync-post-reset-resume-probe.ts` — so this is a comment that overstates its scope, not data loss.

---

### B4. ~~A Convex blip logs everyone out (503 becomes 401)~~ — FIXED

> **Fixed (verified 2026-07-30).** The router's context middleware now recognises errors carrying an explicit status via `isExplicitHttpError` and responds with that status, code, and message — marking 503 retryable — instead of collapsing everything to 401 (`packages/workgraph/src/http/router.ts:98-111`). A bare 401 is now reachable only when the resolved context fails schema validation, i.e. genuinely missing or invalid auth.

**Background.** HTTP status semantics matter to clients: 401 means "your credentials are bad, re-authenticate"; 503 means "backend hiccup, retry."

**The problem.** When Convex is unreachable, context resolution correctly throws a 503-shaped `workspace_authority_unavailable` error (`hosted.ts:439-443, 456-460`). But the WorkGraph router swallows it — `.catch(() => undefined)` → blanket **401 "unauthorized"** (`packages/workgraph/src/http/router.ts:96-99`) — for the entire 24-route surface.

**What happens.** A 30-second Convex incident looks to every client like an invalid session. Apps respond to 401 by discarding tokens and bouncing users to login — turning a transient backend blip into a mass logout.

**The fix (chip filed).** Let errors carrying an explicit status propagate through the router's error response; reserve 401 for genuinely missing/invalid auth. Audit the other hosted routers for the same collapse.

**Done when:** a test asserts authority-down → 503 + `workspace_authority_unavailable` on a workgraph route, while a missing bearer still gets 401.

---

### B5. No timeouts, no retries, no durable idempotency on control routes — TIMEOUTS FIXED, rest open

> **Partly fixed (verified 2026-07-30).** The timeout half landed: every Convex query and mutation now runs through `withTimeout` with configurable bounds (5 s reads, 10 s writes, via `CLAXEDO_CONVEX_READ_TIMEOUT_MS` / `_MUTATION_TIMEOUT_MS`), rejecting with a 503-shaped `ControlPlaneRequestTimeoutError` (`control-plane/adapters/convex/timeout.ts`, applied at `convex-authority-executor.ts:65-70`). Note the helper's own caveat: it bounds *caller wait*, it does not cancel the underlying fetch — so a timed-out mutation may still land, which is why the idempotency item below still matters.
>
> **Still open:** no retries on any Convex/Polar/Daytona call; control-route idempotency remains two per-isolate `Map`s (`http-idempotency.ts:1-6`), so two isolates still both execute an "idempotent" operation; the Polar webhook still ignores `webhook-id` for dedup; and W4's fenced cron lease is still a per-isolate boolean (`workgraph-host/reconcile-serialize.ts`), whose own comment records that overlapping reconciles once hung the Workers runtime.

**Background.** On a distributed system, every network call needs three answers: how long will I wait (timeout), what do I do on failure (retry policy), and what happens if it ran twice (idempotency).

**The problem.**
- ~~**Timeouts:** essentially none.~~ **Fixed** — see the status note above. *Original finding:* `AbortSignal` appeared on exactly three ancillary paths (PostHog 5 s, catalog read, document relay), and every `ConvexHttpClient` call, the Polar SDK, and the Daytona driver calls had no timeout. The Convex path is now bounded; the Polar SDK and Daytona driver calls still are not.
- **Retries:** none on any Convex/Polar/Daytona call (durable retry exists only via DO alarms and the 15-minute sweep — appropriate for background work, absent for request-path blips).
- **Idempotency:** the register/checkpoint/repair control routes use an **in-memory, per-isolate** replay cache (`control-plane/http-idempotency.ts`) — two isolates will both execute the "idempotent" operation. The Polar webhook verifies signatures but never uses the webhook id for dedup. (Counterpoint: WorkGraph commands have real durable idempotency via `operationId` in Convex, and documents use ETag CAS — those are the templates.)
- Related: the W4 "fenced cron lease" from the hardening plan is still unbuilt — the overlapping-reconcile guard is a per-isolate boolean (`reconcile-serialize.ts:16`), and its own comment records that overlapping reconciles once "hung the Workers runtime."

**The fix.** Wrap the Convex executor and external SDK calls with `AbortSignal.timeout` (2–5 s reads, 10 s writes) + one retry with jitter on timeouts/5xx for idempotent operations. Move control-route idempotency keys into Convex (like `operationId`). Land W4: a fenced Convex lease around the cron lanes so two isolates can't run the sweep concurrently.

**Done when:** a fault-injection test (Convex stub that hangs) shows requests failing fast with 503 instead of hanging; a duplicate register/checkpoint across two simulated isolates executes once; two concurrent `scheduled()` invocations run the reconcile body once.

---

### B6. Relay failure modes: outages and expiries kill live sessions; losses are silent

**Background.** The relay authorizes connections against the control plane (the "resolver") and enforces token lifetimes. The question is what happens to *established* tunnels when those checks blip.

**The problems (all verified in `packages/workspace-relay/src/cloudflare.ts`):**
- **Resolver outage kills every live cloud tunnel within ~30 s.** A 30-second watcher re-checks each cloud connection; any resolver error → close 1008 (`:807-836`, fail-closed with only a 10 s cache as grace). New connections also fail closed (correct) — but there's no "keep established streams flowing" mode.
- **Cloud clients are hard-closed at token expiry** (`:815`) — with the default access-token TTL (~30 min per the relay docs), a long PTY session dies mid-flight, and **no browser-side auto-reconnect loop exists in-tree** (only the host side reconnects, `workspace-relay-host-tunnel.ts:182-188`). Meanwhile user-hosted channels under hibernation have both watchers disabled (`:1489-1494`) — expiry there is only caught on the next frame. Two access modes, two contradictory policies.
- **Silent frame loss to stalled clients:** the host→client send discards the failure result (`:1243`) — terminal output vanishes with no close and no log.
- **DO restart loses all in-flight HTTP:** the hibernation rebuild resets `pending: new Map()` (`:756`) — the browser's request just hangs (its timeout died with the old isolate).
- **Unguarded per-frame await:** the user-hosted message handler (`:1113-1138`) has no try/catch; a resolver 5xx mid-frame propagates out of the hibernation handler with undefended platform behavior.
- **The Blob hazard is still code-live:** `socketFrame`/`socketPayload` (`:382-410`) silently return `undefined` for `Blob`; the only mitigation is the pinned `compatibility_date = 2025-05-01`. At ≥ 2026-03-17 every binary frame would drop silently — teach both functions `await blob.arrayBuffer()` and add a real-workerd round-trip test *before* any date bump.

**The fix.** Grace established tunnels through short resolver outages (serve from cache, close only after sustained failure); define one expiry policy — ideally token *refresh* over the live connection instead of kill; check the host→client send result and close 1013 like the live-sync room does; error out rebuilt-pending requests explicitly (or persist pending ids in the DO attachment); wrap the frame handlers in try/catch; implement a client reconnect protocol in the app.

**Done when:** a fault-injection suite covers resolver-down, token-expiry, stalled-client, and DO-restart, each with an explicit asserted client experience (reconnect, clean close code, or error) — no silent hangs or silent drops.

---

### B7. Clerk membership drift — stale org admins forever

**Background.** Who's in which org comes from Clerk **webhooks only**: Svix-verified events mirror into Convex `org_memberships` (`convex/http.ts:50-54` → `orgs.applyClerkWebhook`, now correctly an internal mutation — the pre-launch security hole here was fixed in commit `58991b20d`). Webhooks are at-least-once *usually* — but endpoints get disabled after repeated failures, and deliveries can be lost.

**The problem.** Billing has a staleness truth-keeper for exactly this reason (`flagStaleBillingSync`, justified in `crons.ts` by "Polar disables a webhook endpoint after 10 consecutive failed deliveries"). **Clerk has no equivalent** — no reconciliation sweep exists for memberships.

**What happens.** A missed `organizationMembership.deleted` means a removed employee keeps org-admin access to every workspace in the org, indefinitely, with nothing that will ever notice.

**The fix.** A low-frequency reconciliation sweep (daily) comparing Convex memberships against the Clerk Backend API for orgs seen active recently, plus a webhook-liveness flag like billing's. Keep it read-mostly and rate-limit-aware (Clerk's API limits are tight — which is also why the runtime path correctly never calls it).

**Done when:** a seeded divergence (membership in Convex, absent in a mocked Clerk) is detected and corrected by the sweep within one cycle, with an audit event.

---

### B8. R2 document listing: N+1 reads on the hot path, and a hard stop at 10k

**Background.** Documents live in R2 (object storage). Object stores make GET cheap and LIST comparatively slow; the standard rule is "never LIST on a hot path, never N+1."

**The problem.** Listing a project's documents does **1 LIST + 2 GETs per document** (index entry + locator, `hosted-index.ts:32`, concurrency 8); `findRepository` (`:79`) runs a *full project listing to locate one document*; every document **write** re-LISTs that document's history prefix (`hosted-managed.ts:167` → `collect()` at `:351`). And the pagination helper **throws** outright past 10,000 objects per prefix (`hosted-managed.ts:504-521`, `DEFAULT_MAX_LIST_OBJECTS`) — a busy project's document list would one day fail entirely rather than degrade.

**The fix.** Maintain a single per-project index object (or move doc metadata into Convex, keeping R2 for bodies) so listing is one GET; look up `findRepository` by key instead of scan; cap history by count with lazy pruning instead of list-on-every-write; convert the 10k throw into truncated-with-warning plus pagination in the API.

**Done when:** listing a 1,000-doc project costs O(1) R2 operations in a counting test, and a >10k-object project degrades (paginates) instead of erroring.

---

### B9. The unproven parts — treat these as "not done" rather than "probably fine"

Three things the hardening plan itself requires are still open, and they gate any reliability claim:
- ~~**W5.4:** the vision-verified two-browser live-sync drill on the CF composition was never run (and B3 says it would currently fail for two event classes).~~ **DONE 2026-07-30** — built and passing 8/8 with video, including a reverted-fix positive control that takes it to 4/8. See B3 above and the plan's `W7.3`.
- **W4:** the fenced cron lease (see B5).
- **Benches:** every relay bench report FAILS its gates (see A6). Re-run in cloud against current code 2026-07-30 (W7.1): the delivery cliff **reproduces** with the production 256 channel cap, falsifying the channel-cap hypothesis. A second run that same day **identified the mechanism**: unguarded WebSocket send backpressure in the Cloudflare DO (`cloudflare.ts:1049-1056` never reads `bufferedAmount`, where the Bun relay does at `bun.ts:1412,1435`). It is a race, not a ceiling — the same shape passes and fails across repeats — and relay-side `wrangler tail` shows 13 ms max CPU, so it is I/O backpressure rather than CPU. Unfixed; needs `bufferedAmount` surfaced on the DO socket type first. A separate 64-frame pre-open-queue bug was found and has since been fixed, but it was never the cloud cause. Vantage was APAC (Jaipur), so the non-APAC row remains open.

Per the repo's own rules (`feedback_no_false_positive_verification`): green unit tests are claims; these are the proofs.

---

## Part C — What's already good (don't churn these)

- **No global-singleton DOs.** Every key is per-org, per-`(org, owner)`, per-stream, or per-workspace. (One latent exception: the wakes `" null-lane"` sentinel is a global singleton, but the hosted composition never emits a null serialKey — leave a guard, not a rewrite.)
- **Durable truth + accelerator DOs**, with real tests: the settler/wake-lane recovery semantics (nudge coalescing, earliest-alarm-wins, capped backoff, DO-restart recovery, 10-minute handoff to the sweep) are pinned by tests, including a real workerd hibernation test. wakes-v2's "write the wake row first, nudge second" ordering is the right direction — finish its rollout.
- **Auth is local:** JWKS-cached JWT verification, no Clerk API on any request path; org sync is webhook-driven.
- **Idempotency where it matters most:** WorkGraph `operationId` (durable, in Convex), billing `source_ts` monotonic guard, documents ETag CAS.
- **The app holds zero Convex subscriptions** — Convex is a server-only dependency; the client's only live socket is the LiveSyncRoom SSE. (`VITE_CONVEX_URL` in app config is dead — safe to delete.)
- **Bounded-read discipline exists** (`workgraphChanges.ts` names the invariant; `workgraphActivity.ts` follows it) — A3/A5 are about *spreading* it, not inventing it.
- **The pre-launch security fix landed:** the unauthenticated Clerk-webhook applier is now an internal mutation; `publicMutation`/`publicQuery` have zero call sites repo-wide.

---

## Part D — Suggested order of attack

**Done (2026-07-28 → 2026-07-30):** A1 sweep budget · A2 identity cache · A4 measured cap (sharding dropped) · A5 cursor + doorbell · B2 minute-cron + drift guard · B3 namespace + resume · B4 503-not-401 · B5 timeouts (half) · A6(1) relay prod config · B1 auto-delete plumbing (half).

**Remaining, in order:**

| # | Item | Type | Effort | Why this order |
|---|---|---|---|---|
| 1 | B1 remainder: Daytona `list()` + GC visibility | blind safety net | S–M | Provider expiry now bounds the cost, but you still cannot *see* an orphan; a GC that reports success having enumerated nothing is the failure mode the design exists to avoid |
| 2 | A3 Convex index pass | scale wall | M | Mechanical, templates exist in-repo, and `orgs.setActive` scans every org on the common org-switch path |
| 3 | B5 remainder: retries, durable idempotency, W4 fenced lease | failure semantics | M | Timeouts made failures *fast*; these make them *safe*. The timeout helper does not cancel the underlying write, so duplicate-execution risk is now more exposed, not less |
| 4 | A7 real rate limiting + body caps | abuse | M | Per-isolate limiter loosens under load; the entire workgraph and documents surface is unmetered |
| ~~5~~ | ~~A4 room sharding~~ — **dropped 2026-07-30, measurement says it removes no ceiling** | — | — | One room measured at ≥16,000 connections (p99 fan-out 417 ms); the cap was the entire problem and is now a measured 2,000. Revisit only if one org needs >16,000 concurrent connections |
| 6 | A6(2–7) relay data path, regions, hibernation; B6 relay failure modes | scale + reliability | L | The relay rework wave; gate on benches passing. Per-workspace location hints supersede the deployment-wide default now recorded in config |
| 7 | B7 Clerk sweep, B8 R2 index | hygiene | S–M | Real but slower-burning; B7 is a security-shaped hygiene item (removed members keep access) |
| 8 | B9 the proofs: re-run relay benches, run the W5.4 two-browser drill | verification | M | Several items above are now asserted by unit tests only. Per the repo's own rule, green tests are claims |

**Honest scale framing (unchanged).** With the remaining items 1–5 done, "tens of thousands of active tenants" is a defensible target on this architecture. "Millions" additionally requires rethinking the per-command Convex write pattern, the relay's per-frame encoding, and multi-region placement — don't spend on those until the fundamentals hold and the benches pass. Note the 2026-07-28 walls at ~167 tenants and ~500 tenants are gone, and so is A4's 256-connection wall (measured 2026-07-30: one room holds ≥16,000, cap raised to 2,000). The nearest remaining hard wall is A3's transaction ceiling at a few thousand orgs/leases.
