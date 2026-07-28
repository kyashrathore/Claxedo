# Cloudflare Hosted Path — Reliability & Scalability Review

**Date:** 2026-07-28 · **Branch reviewed:** `security/pre-launch-remediation-2026-07-28` (~`ae4f2f0dc`, with uncommitted live-sync edits) · **Method:** four parallel code sweeps (control-plane request path, Durable Object topology, relay worker, Convex data layer), cross-checked against `docs/deployment-feasibility-2026-07-22.md` and `docs/plans/2026-07-18-001-cf-deployment-hardening.md`.

**The two questions this answers:**

1. **Is the hosted Cloudflare deployment reliable?** The *design* is reliability-minded (durable truth in Convex, DOs only as accelerators, real idempotency in the right places) — but several of its own safety nets are dead code, live-sync provably drops events, and nothing on the critical path has timeouts. Not operationally reliable yet.
2. **Does it scale to millions of users?** No. The first hard wall is at roughly **167 active tenants** (the background sweep starts crashing), with more walls at ~500 tenants, ~256-seat orgs, and a few thousand workspaces. The sharding shape is right, so most walls are removable incrementally — but today this is a low-hundreds-of-tenants system.

Line numbers are as of this branch; verify before fixing — this branch was mid-remediation when reviewed.

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

### A1. The 15-minute sweep dies at ~167 tenants — and ignores everyone past 500

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

### A2. Every WorkGraph API call pays 3+ Convex round-trips — two of them writes

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

---

### A5. Per-owner write serialization, and the snapshot stampede behind every doorbell

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
3. **~6 concurrent upstream connections per isolate.** Workers cap simultaneous outbound connections awaiting response headers at ~6, and a cross-provider WebSocket handshake counts (`src/worker-h2.ts:5-11`, which documents a measured ~25 s connect tail at 200 concurrent clients). The `worker-h2` sharding experiment addresses this but is explicitly not production.
4. **Production config is wrong.** `wrangler.toml` has **no top-level `[vars]`** — `CLAXEDO_RELAY_TUNNEL_CHANNEL_CAP` exists only under `[env.staging.vars]` (32,768). Production therefore runs the **default 16** WebSocket channels per host tunnel (`cloudflare.ts:160`, rejected with 503 at `:1470-1472`) — likely too low for one real workspace (terminal + event streams + docs), while staging's 32,768 equals Cloudflare's own per-DO socket ceiling, i.e. no cap at all. Also: the per-room `clients` set is unbounded (`:677-678`), and cloud-mode client sockets are accepted *without* the hibernation API (`:1391`), so cloud rooms can never hibernate (cost + eviction sensitivity).

**What happens.** Interactive latency is poor for everyone outside APAC by construction; per-workspace throughput is capped by frame-path CPU on one object; concurrency spikes hit the 6-connection wall; and prod silently rejects the 17th channel. The bench reports (`bench/reports/`, 2026-07-17) all FAIL their own gates — one 100k-message run delivered **22 of 100,000 frames**.

**The fix.** In order of value: (1) set a real prod channel cap and an explicit per-deployment location hint (config-only — chip filed); (2) derive the hint per workspace from the sandbox/user region at first creation; (3) replace base64-in-JSON with binary WebSocket frames + a small binary header on the user-hosted path (the cloud path already does cheap pass-through — `:1434-1455` is the template); (4) hoist the per-frame auth checks to per-connection with revocation push instead of per-frame pull; (5) productionize upstream-open sharding from `worker-h2` if cloud fan-out concurrency matters; (6) hibernate cloud client sockets; (7) re-run the benches until the RUNBOOK gates pass and wire them into CI.

**Done when:** benches pass their existing gates (p99 overhead <100 ms, zero WS loss) from a non-APAC client region, and prod config review shows explicit cap + hint values.

---

### A7. Rate limiting that doesn't actually limit

**Background.** Workers run in many isolates; anything stored in a JS `Map` exists per-isolate. The limiter here (`src/control-plane/rate-limit.ts:31-36`) is exactly that — an in-memory fixed window.

**The problem.** Real limit = configured limit × number of live isolates, and Cloudflare spins up isolates with load — so the limiter loosens precisely when it's needed. Worse, most of the surface has **no limiter at all**: the entire `/api/workgraph/*` surface (24 routes), all 28 document routes, checkpoint/lifecycle routes (which provision real infrastructure), bootstrap/events/session routes. Body-size caps exist in exactly one module (documents, 2 MiB — `documents.ts:29`); the Polar webhook reads its entire body uncapped before verifying (`billing-routes.ts:202-219`).

**What happens.** One misbehaving client (or one bug in the app's retry loop) can hammer Convex through unmetered routes; a large POST to any non-document route buffers unbounded in the isolate. Abuse economics get worse with scale, not better.

**The fix.** Move limits to something shared: Cloudflare's native rate-limiting binding (cheap, approximate — fine for abuse) or a small counter DO per principal (exact, costs a DO call). Apply a default limiter + body cap at the app level (one Hono middleware) with per-route overrides, rather than opt-in per route. Keep the in-memory limiter only as a first-layer local fuse.

**Done when:** a load test from two simulated isolates shows the global limit enforced, and every mounted route inherits a body cap unless explicitly exempted.

---

## Part B — Reliability defects (broken at any scale)

### B1. The sandbox leak reaper never runs — unbounded money bleed ⚠️ *worst operational finding*

**Background.** Hosted agents run in Daytona sandboxes that bill by the hour on **operator** keys. The safety design is three layers: (1) provider auto-stop, (2) an idle policy, (3) a 15-minute GC sweep that lists what the provider is actually running and destroys anything without a valid lease. The design comment at `worker.ts:323-331` says the quiet part: "a silently-dead reaper is the failure mode this design exists to avoid."

**The problem — all three layers are off:**
- GC returns empty unless the driver implements `list()` (`packages/sandbox-manager/src/index.ts:990-998`) — and the **Daytona driver has no `list`** (`drivers/daytona.ts:299-357`; only `exe` and `fetch-bridge` implement it). The sweep destroys nothing, ever, and the route still returns 200, so the cron looks green.
- Daytona `autoStop`/`autoDelete` are **never configured** on the hosted path (`hosted-services.ts:104-126` passes neither; `daytona.ts:288-289` only sends them when defined). The cron comment claiming "Daytona autoStop has long since bounded the money" is currently false.
- The idle policy `decideSandboxIdle` (`lease-policy.ts:95`) has **zero production callers**, and the lease→driver reconciliation query (`sandboxLeases.ts:592`) has zero callers.

The only thing that runs is the Convex-side lease sweep, which *relabels table rows* — by design it holds no provider credentials and cannot destroy anything.

**What happens.** Any sandbox orphaned by a crash mid-provision, a lost lease write, or a driver error **runs and bills forever**. Nothing converges. You would discover it on the Daytona invoice.

**The fix (chip filed).** Implement `list()` on the Daytona (and Cloudflare) driver; pass auto-stop/auto-delete defaults in `hosted-services.ts`; make GC's report distinguish "driver cannot list" from "nothing to collect" and alarm on the former; wire or delete the idle policy. Positive-control test: create a driver sandbox with no lease, run GC, assert it is destroyed — and assert current code FAILS that test first.

**Done when:** that positive-control test passes, and the GC route's response makes a listing-incapable driver loudly visible.

---

### B2. The dead minute-cron backstop

**Background.** Beyond the global 15-minute sweep, there's a finer recovery lane: every minute, find tenants whose settlement went stale and ping just their settler DOs (`worker.ts:337-351`).

**The problem.** The code gates that lane on `controller?.cron === "* * * * *"` — but `wrangler.toml` registers only `*/15 * * * *` (lines ~53 and ~156; cron triggers are not inherited by environments, so both were checked). The branch is **dead code in every environment**. Nobody noticed because nothing fails — recovery just silently degrades to the 15-minute sweep… which is the thing with the A1 walls.

**The fix (chip filed).** Decide the intent: register the `* * * * *` trigger, or fold the stale-tenant fan-out into the 15-minute tick with a subrequest budget. Then add a drift guard: a test that parses `wrangler.toml` and asserts every registered cron string matches a live branch in `scheduled()` and vice versa.

**Done when:** the stale-tenant lane demonstrably runs on schedule (staging observability), and the drift-guard test exists.

---

### B3. Live-sync drops events: wrong-namespace publishers ~~(FIXED same-day)~~, and no way to catch up (still open)

**Background.** Two identity namespaces exist: **Clerk claims** (what tokens carry: Clerk org id, Clerk subject) and **authority-internal ids** (Convex `orgs._id`). Passing the wrong one names a room no subscriber ever joins.

**Problem 1 — two of three publishers rang the wrong room — FIXED on this branch later on 2026-07-28.** At review time, document events passed the authority-internal org id (a self-declared `KNOWN GAP`) and agent attempt-operations were keyed `owner:<subject>`, so org-token subscribers received neither. A same-day parallel session **unified the namespace on authority-internal org ids**: the events route resolves `authority.resolveOrgId` at connect, and both publishers now derive names via `liveSyncRoomNameForPrincipal` (`hosted-app.ts:311-318`, `:516-522`), with e2e coverage. Clerk claims are now auth-only. Residual rule: never hand-compose an `org:` room name — always derive it (`live-sync-room.ts:501-502`).

**Problem 2 — no resume.** The SSE stream never emits `id:` lines (`live-sync-room.ts:329, 436`), so the client's `Last-Event-ID` machinery (`claxedo-events.tsx:461, 508-509`) never advances. A nudge that fails to deliver *while connected* is lost until the user switches tabs or the stream reconnects (`sync-lifecycle.ts:130-139` — recovery is edge-triggered, there is no periodic poll).

**What happens.** Teams (org tokens) see stale documents and stale agent state until they poke the UI. Combined with problem 1, this isn't a rare race — it's the steady state for two event classes.

**The fix (remaining: problem 2 only).** Add a catch-up floor: either emit `id:` lines (room keeps a tiny in-memory counter; client re-fetches on gap) or a slow background poll (e.g., 60 s) as delivery insurance. (Problem 1's namespace unification landed 2026-07-28 — see above.)

**Done when:** a deliberately-dropped nudge is recovered within one poll/gap-detect interval without user interaction.

---

### B4. A Convex blip logs everyone out (503 becomes 401)

**Background.** HTTP status semantics matter to clients: 401 means "your credentials are bad, re-authenticate"; 503 means "backend hiccup, retry."

**The problem.** When Convex is unreachable, context resolution correctly throws a 503-shaped `workspace_authority_unavailable` error (`hosted.ts:439-443, 456-460`). But the WorkGraph router swallows it — `.catch(() => undefined)` → blanket **401 "unauthorized"** (`packages/workgraph/src/http/router.ts:96-99`) — for the entire 24-route surface.

**What happens.** A 30-second Convex incident looks to every client like an invalid session. Apps respond to 401 by discarding tokens and bouncing users to login — turning a transient backend blip into a mass logout.

**The fix (chip filed).** Let errors carrying an explicit status propagate through the router's error response; reserve 401 for genuinely missing/invalid auth. Audit the other hosted routers for the same collapse.

**Done when:** a test asserts authority-down → 503 + `workspace_authority_unavailable` on a workgraph route, while a missing bearer still gets 401.

---

### B5. No timeouts, no retries, no durable idempotency on control routes

**Background.** On a distributed system, every network call needs three answers: how long will I wait (timeout), what do I do on failure (retry policy), and what happens if it ran twice (idempotency).

**The problem.**
- **Timeouts:** essentially none. `AbortSignal` appears on exactly three ancillary paths (PostHog 5 s, catalog read, document relay). Every `ConvexHttpClient` call, the Polar SDK, and the Daytona driver calls have **no timeout** — a slow dependency holds the request open until the platform kills it.
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
- **W5.4:** the vision-verified two-browser live-sync drill on the CF composition was never run (and B3 says it would currently fail for two event classes).
- **W4:** the fenced cron lease (see B5).
- **Benches:** every relay bench report FAILS its gates (see A6); they're also from 2026-07-17 and need a re-run against current code before drawing final conclusions.

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

| # | Item | Type | Effort | Why this order |
|---|---|---|---|---|
| 1 | B1 sandbox reaper (chip filed) | money bleed | S–M | Unbounded operator cost; everything else can wait a day, this can't |
| 2 | B2 dead minute-cron (chip filed) | dead safety net | S | One-decision fix + drift guard |
| 3 | A1 sweep cursor + budget | scale wall | M | Removes the 167/500 walls that cap the whole product |
| 4 | B4 503-not-401 (chip filed) | UX-critical | S | Tiny fix, prevents mass logouts |
| 5 | A6(1) relay prod config (chip filed) | config | S | Two config lines; unblocks real relay behavior |
| 6 | A2 identity-resolution cache | cost/latency | M | 3× Convex traffic → ~1× |
| 7 | A3 Convex index pass | scale wall | M | Mechanical; templates exist in-repo |
| 8 | B5 timeouts/idempotency + W4 lease | failure semantics | M | Makes outages boring instead of cascading |
| 9 | B3 live-sync namespace + resume | correctness | M | Already-tracked identity unification + catch-up floor |
| 10 | A4 room sharding, A5 bounded snapshots | scale walls | M–L | Needed before orgs >100 seats / heavy agent use |
| 11 | A6(2–7) relay data path + regions, A7 real rate limiting, B6 relay failure modes | scale + reliability | L | The relay rework wave; gate on benches passing |
| 12 | B7 Clerk sweep, B8 R2 index | hygiene | S–M | Real but slower-burning |

**Honest scale framing:** with items 1–8 done, "tens of thousands of active tenants" is a defensible target on this architecture. "Millions" additionally requires rethinking the per-command Convex write pattern (2 rows + 2 counter patches per command), the relay's per-frame encoding, and multi-region placement — don't spend on those until the fundamentals hold and the benches pass.
