# CF Deployment & Multi-Instance Hardening — Work To Be Done

Single, self-contained work list. Captures every actionable item from the CF-deployment / multi-instance discussion (2026-07-18). No dependency on other docs.

- **Status**: PLANNED (2026-07-18). Executable by parallel opus sub-agents in waves, ordered by risk (safe/self-contained first, the new Durable Object last).
- **Prime directives** (non-negotiable):
  1. **Local-first** — every CF change verified under **Miniflare / `wrangler dev`** (workerd) or targeted tests BEFORE any deploy. Never deploy to discover a failure.
  2. **No false-positive verification** — green tests are a *claim*. Every coordination/cost fix needs a **positive-control test** (deliberately create the race/condition; prove it FAILS without the fix). User-visible changes need vision-reviewed evidence.
  3. **Single-box self-host is correct as-is — never "fix" it.** Every change is gated to the multi-isolate CF path or the multi-instance Node path. If a change would alter single-box behavior, stop and report.
  4. **Verify before you fix** — re-read the code for each item; if reality contradicts this doc, stop and report (one "bug" already evaporated on inspection — see W2.4).

---

## A. Context in one screen

**Owner decisions:**
- **CF (Worker + DO + Convex) is the PRIMARY hosted target.** The `LiveSyncRoom` DO gets built.
- **Multi-instance Node + Convex is the SECONDARY / self-host path** — supported, coordinated by Convex (NOT single-instance-with-interlock, NOT Postgres).
- **Convex is the shared store for BOTH hosted paths.** No Postgres, no Redis.
- **The relay stays on CF Durable Objects** (validated dial-in).

**The one idea behind every hazard:** process memory (a JS `Map`/`Set`/`EventEmitter`/`let`) is visible to every request in *one* process — so it's where the code keeps "who's connected / what changed / who owns this / did this run." Run **two** instances and that memory is a **lie**: instance A's map is invisible to B. On CF Workers it's worse — there's no long-lived process at all, so those patterns can't even deploy. Single instance = the lie becomes truth (correct).

**The four deployments and the one forbidden action each:**

| Deployment | Instances | State | Live-sync | Coordination | Don't |
|---|---|---|---|---|---|
| Self-host single box | 1 | local SQLite | in-memory bus → SSE | in-memory guards | point two writers at one SQLite file / boot a 2nd process |
| **Hosted CF (PRIMARY)** | always (isolates) | Convex + DO | **`LiveSyncRoom` DO** | Cron + **fenced Convex lease** | rely on a per-isolate guard for cross-isolate correctness |
| **Hosted Node multi-instance (SECONDARY)** | N | Convex | **Convex subscription → local SSE** | **Convex leases** | run background timers/ownership without a Convex lease |
| Self-host multi-node | — | (folds into "Node multi-instance + Convex") | — | — | build a Postgres path (decided against) |

**Vocabulary:** `LiveSyncRoom` = the per-owner DO that holds client SSE + fans nudges. **"doorbell"** = the *event/nudge* only (`workgraph.changed`, payload = "reload", not the data). `WorkspaceRelayRoom` = the existing per-workspace relay DO.

---

## B. The work (by wave; risk-ordered)

### Wave 1 — Naming + this doc  ·  STATUS: DONE (docs)
- **W1.1** Reserve "doorbell" for the *event*; the per-owner fan-out DO is **`LiveSyncRoom`**. ✅ done in-repo docs.
- **W1.2** This doc is the self-contained deployment-nuance + work reference. ✅

### Wave 2 — Self-contained correctness + hygiene (4 parallel agents, disjoint files)

**W2.1 — Fix the `wakes` reclaim double-fire.  [CONFIRMED bug]**
- Problem: `runDue` (`packages/wakes/src/wakes.ts:361-362`) does `findReclaimable` (plain `SELECT` of lapsed-lease `firing` rows, `sqlite-store.ts:220`) then `driveFiring` — **no atomic re-claim**. `driveFiring` (`:159`) runs the **sink side-effect first, CAS second**, so two drivers that select the same reclaimed row **both spawn the turn** before either CASes. The claim path (`claimDue`, `:157`) is atomic and safe; only reclaim (and `recover()`) isn't.
- Fix: make reclaim atomic — a store method that re-acquires the lease with a CAS (`UPDATE wakes SET lease_until=? WHERE id=? AND state='firing' AND lease_until<=? RETURNING *`) and only drives rows it wins; same for `recover()`. (Alt: wrap the sink in the existing `once()`/`effect_receipts` for idempotency.)
- Files: `packages/wakes/src/wakes.ts`, `packages/wakes/src/sqlite-store.ts` (+ other `WakeStore` impls).
- DoD: **positive-control test** — two `runDue` calls racing over one lapsed-lease row spawn the sink **exactly once**; FAILS on current code, PASSES after. Existing wakes tests green.
- Deployment: any >1 driver (multi-instance Node). Verify: `bun test` in `packages/wakes`.

**W2.2 — Add TTL to the two no-TTL caches.**
- `session-harness.ts:23-24` (invalidated only on data-dir change) and `sandbox-manager/src/drivers/vercel.ts:98` (snapshot IDs) serve stale data indefinitely per instance.
- Fix: bounded TTL / explicit invalidation. DoD: test that a past-TTL entry refetches; no change within TTL.

**W2.3 — Consolidate the duplicated idempotency maps.**
- Two copies of `pullLocks`/`pullResults`: `routes/hosted-control.ts:23-24` and `control-plane/http-idempotency.ts:1-2`.
- Fix: collapse to one module; `hosted-control.ts` imports it. No semantic change this wave. DoD: one impl, both call sites use it, tests green.

**W2.4 — VERIFY billing idempotency (NOT a fix).  [corrected]**
- Earlier flagged as a double-apply bug; on reading the code it's already idempotent — `apply-polar-state.ts:13` documents "idempotent under duplicates and reordering via the source-timestamp guard" and every apply carries `source_ts`.
- Work: **confirm** the Convex `applyPolarState` mutation enforces `source_ts` monotonicity (no-ops equal-or-older). If yes → one-line note in `billing/reconcile.ts` that concurrent cron applies are safe. If no → escalate (becomes a real fix).
- **BLOCKER**: the Convex mutation is not in this checkout (only `convex/_generated/`).

### Wave 3 — Hibernation-safe keepalive (CF cost)

**W3.1 — Stop the tunnel keepalive from waking the DO.  [CONFIRMED]**
- Problem: the relay keepalive is an application-level JSON ping `{type:"ping",id,sent_at}` every 15s (`bun.ts:476/1450`), handled by `makeTunnelPong` in the DO message handler (`cloudflare.ts:1134`). **Every app-level message wakes the DO**, so hibernation doesn't fully engage → the cheap cost column ($0.056/user/mo) isn't guaranteed (drifts toward ~$4/user/mo). Can't use `setWebSocketAutoResponse` (fixed-string only) because the ping's `id`/`sent_at` are dynamic and echoed in the pong (`workspace-relay-protocol/src/index.ts:21-34`).
- Fix (CF path only): use **WebSocket protocol-level ping/pong frames** for liveness on CF (hibernation auto-answers them without waking) and drop the app JSON ping on that path. Keep the app-level ping on the Bun path (no hibernation there). Alt: split a fixed-string auto-response liveness ping from the RTT ping.
- Files: `packages/workspace-relay/src/cloudflare.ts` (+ maybe `workspace-relay-host-tunnel.ts` agent side).
- DoD: under `wrangler dev`, a tunnel idle ≥60s does **not** wake the DO per-ping (measure via DO observability, or assert the message handler isn't invoked for protocol pings). Bun path unchanged. Verify: Miniflare, no deploy.

### Wave 4 — Fenced cron lease (CF coordination) — shared with W6

**W4.1 — Replace the per-isolate reconcile guard with a fenced Convex lease.**
- Problem: `skipOverlappingReconcile` (`worker.ts:73`, `reconcile-serialize.ts:15`) is a **per-isolate boolean** — stops overlap within one isolate, not across isolates. Cron overlapping the next fire, or cron overlapping the manual admin trigger, runs the reconciler on two isolates against shared Convex. (Billing itself is idempotent — W2.4 — so this is redundant work + triple-nudges + any non-idempotent reconcile step, not a double-charge.)
- Fix: acquire a **fenced Convex lease** (monotonic fencing token) before the cron reconcile/GC lane; a second isolate that can't acquire skips. Reuse the `owner-deletion` lease / `wakes.claimDue` pattern. This same lease serves the Node reconciler in W6.
- Files: `worker.ts` (scheduled lane), `reconcile-serialize.ts`, a Convex lease mutation (**BLOCKER: Convex fns not in checkout** — ship client half + contract, flag Convex work).
- DoD: positive-control test — two concurrent `scheduled()` invocations run the reconcile body **once**; fencing rejects the stale holder. Verify: Miniflare `scheduled()` test with a stubbed lease.

### Wave 5 — `LiveSyncRoom` DO: close the hosted live-sync gap (CF PRIMARY; the big build)

Hosted SSE today is a heartbeat-only stub (`hosted-shell.ts` `eventsStream`) subscribing to no bus → **hosted has NO live-sync**. Sub-stepped; verify each under Miniflare before deploy.

**W5.1 — `LiveSyncRoom` Durable Object.** Per-owner (owner for personal, org for teams) DO that **holds client SSE/WS** (hibernatable) and, on a nudge, **fans it to held connections**. Keyed `idFromName("owner:"+id)`. Mirrors `WorkspaceRelayRoom` hibernation-rebuild (`cloudflare.ts:741-786`). DoD: Miniflare test — N held connections in one room all receive a room-posted nudge; hibernation rebuild works; idle room parks (reuse W3 hibernation-safe holding).

**W5.2 — Worker route: hosted SSE terminates at the owner's `LiveSyncRoom`.** Replace the heartbeat stub so `GET /api/claxedo/events` (+ `/global/event`, `/api/wr/events`) on the Worker routes the client SSE to `LiveSyncRoom.get(owner)`. **Client contract unchanged** — same SSE, same `eventVisibleTo` scoping, same reload-on-nudge; client code (`event-ingress.ts`, TanStack Query) NOT touched. DoD: Miniflare — SSE held by the correct owner's room; filtering preserved; grep confirms zero client diff.

**W5.3 — Write-path rings the room.** A hosted mutation that changes WorkGraph/documents **rings the owner's `LiveSyncRoom`** by name (from the handling isolate, or off a Convex change). The hosted equivalent of `claxedoBus.publish(...)`; the Convex composition doesn't publish today. **This write also serves the Node path (W6.2).** DoD: mutation on isolate A → client on isolate B (same owner) reloads; self-host in-memory bus unchanged. Verify: Miniflare two-isolate.

**W5.4 — Live-sync integration drill (vision-reviewed).** On `wrangler dev` hosted composition, a real WorkGraph change reflects in a second browser tab within the debounce window, **vision-reviewed** evidence. Self-host live-sync unchanged. Only then flip live-sync status to CLOSED.

### Wave 6 — Multi-instance Node coordination via Convex (SECONDARY; reuses W4 + W5.3)

The Node/Fly control plane runs **multi-instance, coordinated by Convex**. Lower priority than the CF waves; cheaper once W4 (lease) and W5.3 (change-write) land.

**W6.1 — Coordinate background work with Convex leases.** Reconciler (`server.ts:1102`), supervisor ownership (`runtimes` map, `workspace-supervisor-store.ts:25`), health monitor (`workspace-supervisor-sandbox.ts:529`), idle-reaper (`workspace-supervisor.ts:455`), wakes — all per-process today → triple-fire / ownership races / idle-reaper kills live sandboxes with N instances. Fix: **fenced Convex lease** before each periodic job / ownership claim (reuse W4); supervisor ownership becomes an authoritative per-workspace Convex ownership lease (replacing the best-effort `cloud/mirror.ts`). DoD: positive-control — N instances run each job once; ownership single-holder; fenced failover; single-box lease trivially always-held (no change). **BLOCKER: Convex fns.**

**W6.2 — Live-sync fan-out via Convex subscription.** Each Node instance holds a **Convex subscription** to the per-owner change tip and nudges its **local** SSE clients. NOTE: current transport is `ConvexHttpClient` (`hosted-runtime.ts:1`, no subscriptions) — add the subscribing `ConvexClient` (`convex/browser`, works in Node) for the tip query. Write half = W5.3. DoD: change on instance A → client on instance B nudged via Convex; single-box unchanged.

---

## C. Explicitly NOT doing
- **Postgres / Redis path** — Convex is the store + coordination + (Node) bus for both hosted paths. No adapter, no `LISTEN/NOTIFY`, no Redis.
- **Single-instance interlock** — dropped; Node runs genuinely multi-instance via Convex leases (W6).
- **Sticky routing for a Bun relay** — moot; the relay is CF Durable Objects; Node instances don't hold workspace tunnels.

## D. Blockers / dependencies
- **Convex functions are not in this checkout** (only `convex/_generated/`). The Convex-side halves of **W2.4** (billing guard), **W4** (lease mutation), **W5.3** (write-path nudge if Convex-originated), **W6** (leases + subscription) need the Convex repo or a contract handoff. All *client* halves + the DO + relay + wakes changes are in-repo.
- W6 reuses W4's lease and W5.3's change-write → sequence W4/W5.3 first.

## E. Global Definition of Done
- [ ] Every wave verified **locally-first** (Miniflare/`wrangler dev` / targeted tests) — no deploy-to-discover.
- [ ] Every coordination/cost fix has a **positive-control test** (fails without the fix).
- [ ] `bun typecheck` green from the affected package(s) (`@claxedo/workgraph`: `bun run build` first if types cross; `tsgo -b` directly to skip the debt-ratchet).
- [ ] **Single-box self-host behavior unchanged** (explicit per-wave regression check).
- [ ] Live-sync (W5.4) and hibernation-cost (W3) flipped to CLOSED only with real evidence.

## F. Suggested order
1. **W1** (done). 2. **W2.1–W2.4** parallel. 3. **W3** (relay). 4. **W4** (fenced lease). 5. **W5.1→W5.4** (CF primary, the big build). 6. **W6.1–W6.2** (Node secondary, after W4 + W5.3). CF (W1–W5) leads; W6 follows and reuses CF mechanisms. Nothing here needs a production deploy to verify.
