# CF Deployment Hardening — Live-Sync, Coordination, Cost, Deployment Nuance

- **Status**: PLANNED (2026-07-18). Executable by parallel opus sub-agents in waves; waves are ordered by risk (safe/self-contained first, the new Durable Object last).
- **Owner context**: Owner decided **Cloudflare = first-class deployment target** after the dial-in relay re-eval ([`docs/tech-docs/cloudflare-relay-evaluation.md`](../tech-docs/cloudflare-relay-evaluation.md)). "First-class target" means the target we build toward — it is **not finished**. This plan closes the gaps that stop CF from "just working," plus the self-contained correctness fixes surfaced along the way, plus the deployment-nuance docs.
- **Companion (read first)**: [`docs/tech-docs/multi-instance-architecture-hazards.md`](../tech-docs/multi-instance-architecture-hazards.md) — the full audit of every place >1 process / >1 isolate breaks an assumption, with the CF and Node target architectures. This plan executes the CF column of that doc.
- **Prime directives for executing agents**:
  1. **Local-first (never deploy to discover a failure).** Every CF change is verified under **Miniflare / `wrangler dev`** (workerd) or targeted unit tests BEFORE any deploy. No "deploy and watch the logs."
  2. **No false-positive verification.** Green typecheck/tests are a *claim*. Coordination/cost fixes require a **positive-control test** (deliberately create the race/condition; prove the test FAILS without the fix). For anything user-visible, vision-reviewed evidence.
  3. **Single-box self-host is correct as-is — do not "fix" it.** Every change here is gated to the multi-isolate CF path or the (future) multi-node Node path. If a change would alter single-box behavior, stop and report.
  4. **Verify before you fix.** One item in the earlier discussion (billing double-apply) evaporated on reading the code — it is already idempotent. Re-read the code for each item; if reality contradicts the plan, stop and report, do not improvise.

---

## 0. Scope & the corrected finding

From the discussion, the standalone issues. **Corrected**: "idempotent billing" is NOT a bug — `apply-polar-state.ts:13` documents it idempotent via a source-timestamp guard and every apply carries `source_ts`; two isolates applying the same state is a no-op. It is downgraded to a **verify** item (W2.4), not a fix.

| Item | Class | Deployment that makes it live | Wave |
|---|---|---|---|
| Hosted live-sync missing (Hazard A) | new component | CF (multi-isolate) | **W5** |
| CF cron overlap guard is per-isolate (D/E) | fenced lease | CF (multi-isolate) | **W4** |
| Hibernation-defeating keepalive (cost) | relay edit | CF | **W3** |
| Wakes reclaim double-fire (#2) | atomic reclaim | any >1 driver | **W2.1** |
| No-TTL caches | hygiene | any | **W2.2** |
| Duplicated idempotency maps | hygiene | CF + Node | **W2.3** |
| Billing source_ts guard | **verify only** | CF | **W2.4** |
| Node multi-instance coordination via Convex (reconciler/ownership/schedulers + live-sync) | Convex leases + subscription | Node (secondary) | **W6** |
| Doorbell → `LiveSyncRoom` rename + deployment docs | docs/naming | all | **W1** |

**Deliberately NOT built here** (§8): a Postgres/Redis path (Convex is the store + bus for both hosted paths); sticky routing for a Bun relay (moot — the relay is CF Durable Objects, and Node instances don't hold workspace tunnels). Node multi-instance is a *supported secondary* path here (via Convex, W6), not a deferral — but CF is primary, so the CF waves lead.

---

## 1. Deployment-type nuance (the reference this plan enforces)

Four deployments, three of which we run. **The rule that generates every row: process memory is a lie across instances; single-instance makes it truth.**

**Owner decision (2026-07-18): Convex is the shared store for BOTH hosted paths (no Postgres). CF Worker+DO is PRIMARY; multi-instance Node+Convex is the SECONDARY/self-host path. No single-instance interlock — Node coordinates via Convex leases.**

| Deployment | Instances | State home | Live-sync fan-out | Scheduling & coordination | What breaks if you ignore it |
|---|---|---|---|---|---|
| **Self-host, single box** | 1 (by design) | local SQLite (`~/.claxedo`) | in-memory bus → SSE (correct) | `setInterval` + in-memory guards (correct) | **Nothing** — unless two writers hit one SQLite file, or you boot a 2nd process |
| **Hosted CF (Worker + DO + Convex) — PRIMARY** | always (isolates) | **Convex** (state) + DO (connections) | **`LiveSyncRoom` DO** (per owner) | Cron Trigger + **fenced Convex lease** | live-sync missing (W5); per-isolate cron guard contends (W4); app-ping defeats hibernation → cost (W3) |
| **Hosted Node (Fly), multi-instance — SECONDARY** | N | **Convex** (state + coordination) | **Convex fan-out** — each instance holds a Convex subscription, re-emits to its own SSE clients | **Convex leases** (`claimDue`/lease) for reconciler / ownership / schedulers | coordination not on Convex leases → reconciler triple-fires, `runtimes` ownership races, idle-reaper kills live sandboxes (W6) |

Convex is the single cross-instance layer for both hosted paths — **state, coordination (leases), and (on Node) live-sync fan-out**. The CF path additionally uses the `LiveSyncRoom` DO for fan-out (the DO is the CF-native equivalent of the Node Convex-subscription fan-out). The CF target architecture is diagrammed in the hazards doc §12; the Node target is now Convex-based throughout (§13 updated).

---

## 2. Wave 1 — Naming + deployment docs (do first; unblocks shared vocabulary)

### W1.1 — Rename `Doorbell DO` → `LiveSyncRoom`; reserve "doorbell" for the event
- **Why**: the DO doesn't ring — it holds a user's live connections and fans nudges out. "Doorbell" is the *event* (a nudge that says "reload," not the data). Naming the actor `LiveSyncRoom` matches the existing `WorkspaceRelayRoom` convention.
- **Change**: in `docs/tech-docs/multi-instance-architecture-hazards.md` (§3, §12) and `docs/plans/2026-07-17-004-workgraph-live-sync-redesign.md`, rename the DO to `LiveSyncRoom`; keep "doorbell" only for the `workgraph.changed`/`document.changed` **event/nudge**.
- **DoD**: no doc uses "Doorbell DO" to mean the actor; the event is still called a doorbell; a one-line glossary added: *LiveSyncRoom = per-owner DO holding client SSE + fanning doorbell nudges*.
- **Deployment**: docs only. **Verify**: `rg -n "Doorbell DO"` returns nothing.

### W1.2 — Deployment-nuance reference is complete
- **Why**: "good docs on the nuance of every deployment type and what might break" (the ask).
- **Change**: ensure the hazards doc's §1 table + §12/§13 architectures + the matrix in §1 of *this* plan agree. Add a short "Which deployment am I running, and what must I not do?" checklist to the hazards doc.
- **DoD**: a reader can, from the hazards doc alone, name the four deployments, what state each keeps where, and the one forbidden action for each. Cross-linked from this plan and the relay eval doc.

---

## 3. Wave 2 — Self-contained correctness + hygiene (parallelizable; no new components)

Four disjoint file sets → four parallel agents.

### W2.1 — Fix the `wakes` reclaim double-fire (#2)
- **Problem (confirmed in code)**: `runDue` (`packages/wakes/src/wakes.ts:361-362`) does `findReclaimable` (a plain `SELECT` of `firing` rows with lapsed leases, `sqlite-store.ts:220`) then `driveFiring` — with **no atomic re-claim**. `driveFiring` (`:159`) runs the **sink side-effect first, CAS second**, so two drivers that both select the same reclaimed row both spawn the turn before either CASes. The claim path (`claimDue`, `:157`, atomic `UPDATE ... RETURNING`) is safe; only reclaim isn't. `recover()` has the same shape.
- **Change**: make reclaim atomic — add a store method that re-acquires the lease with a CAS (`UPDATE wakes SET lease_until=? WHERE id=? AND state='firing' AND lease_until<=? RETURNING *`) and only `driveFiring` the rows it wins; apply the same to `recover()`. (Alternative acceptable: wrap the sink in the existing `once()`/`effect_receipts` so a double-drive is idempotent — but the atomic reclaim is the direct fix.)
- **Files**: `packages/wakes/src/wakes.ts`, `packages/wakes/src/sqlite-store.ts` (+ any other store impls behind the `WakeStore` interface).
- **DoD**: a **positive-control test** — two `runDue` calls racing over one lapsed-lease `firing` row spawn the sink **exactly once**; the test must FAIL against current code and PASS after. Existing wakes tests stay green.
- **Deployment**: any deployment with >1 wake driver (multi-node Node; not single-box). **Verify**: `bun test` in `packages/wakes` (Bun-API-free per the test-runner note).

### W2.2 — Add TTL/invalidation to the two no-TTL caches
- **Problem**: `session-harness.ts:23-24` (invalidated only on data-dir change) and `sandbox-manager/src/drivers/vercel.ts:98` (snapshot IDs) can serve stale data indefinitely per instance.
- **Change**: add a bounded TTL (or explicit invalidation hook) to each; keep single-box behavior identical for the common case.
- **Files**: `packages/claxedo-server/src/session-harness.ts`, `packages/sandbox-manager/src/drivers/vercel.ts`.
- **DoD**: a test that an entry past TTL is refetched; no behavior change within TTL. **Verify**: targeted unit test + typecheck.

### W2.3 — Consolidate duplicated idempotency maps
- **Problem**: two independent copies of `pullLocks`/`pullResults` — `routes/hosted-control.ts:23-24` and `control-plane/http-idempotency.ts:1-2`.
- **Change**: collapse to one module (`http-idempotency.ts`), have `hosted-control.ts` import it. **Do not** change semantics in this wave — just dedupe. (Making write-critical idempotency Convex-backed is W4's territory.)
- **Files**: the two above.
- **DoD**: one implementation; both call sites use it; existing tests green. **Verify**: typecheck + existing route tests.

### W2.4 — VERIFY billing idempotency (not a fix)
- **Problem**: earlier flagged as a double-apply bug; reading the code, `apply-polar-state.ts:13` documents idempotency via a source-timestamp guard and passes `source_ts`. The guard itself lives in the Convex mutation (`convex/billing.ts applyPolarState`), which is **not in this checkout** (only `_generated/`).
- **Change**: NONE unless the guard is missing. **Confirm** the Convex `applyPolarState` mutation enforces `source_ts` monotonicity (rejects/no-ops an equal-or-older `source_ts`). If it does → close with a one-line note in `billing/reconcile.ts` that concurrent cron applies are safe by the source_ts guard. If it does NOT → escalate: this becomes a real fix and a new wave.
- **DoD**: a documented confirmation (or an escalation). Ideally a Convex-side test that an older-`source_ts` apply is a no-op.
- **Deployment**: CF (cron multi-isolate). **Verify**: read the mutation; test if possible.

---

## 4. Wave 3 — Hibernation-safe keepalive (CF cost)

### W3.1 — Stop the tunnel keepalive from waking the DO
- **Problem (confirmed)**: the relay keepalive is an application-level JSON ping `{type:"ping", id, sent_at}` every 15s (`bun.ts:476/1450`), handled in the DO message handler by `makeTunnelPong` (`cloudflare.ts:1134`). Every application message **wakes the DO**, so hibernation doesn't fully engage and the cheap cost column ($0.056/user/mo) isn't guaranteed. It can't use `setWebSocketAutoResponse` (fixed-string only) because the ping carries a dynamic `id`/`sent_at` echoed in the pong (`workspace-relay-protocol/src/index.ts:21-34`).
- **Change (CF path only)**: use **WebSocket protocol-level ping/pong control frames** for liveness on the CF relay (CF hibernation auto-answers protocol pings without waking the DO) and drop the app-level JSON ping *on that path*. Keep the app-level ping on the Bun path (no hibernation there) so the protocol contract is unchanged for self-host. Alternative acceptable: split a fixed-string liveness ping (registered via `setWebSocketAutoResponse`) from the RTT-measuring ping (sent only on wake).
- **Files**: `packages/workspace-relay/src/cloudflare.ts` (ping handling + hibernation), possibly `workspace-relay-host-tunnel.ts` (the agent side must send protocol pings on the CF path).
- **DoD**: under `wrangler dev` (Miniflare) a tunnel held idle for ≥60s shows the DO **not** waking per-ping (measure via DO invocation/observability, or a test asserting the message handler is not invoked for protocol pings); self-host Bun path keepalive unchanged; existing relay tests green. Update the "hibernation verification" section of the relay eval doc from GAP → CLOSED with the evidence.
- **Deployment**: CF only. **Verify**: Miniflare/`wrangler dev` local; do not deploy to measure.

---

## 5. Wave 4 — Fenced cron lease (CF coordination)

### W4.1 — Replace the per-isolate reconcile guard with a fenced Convex lease
- **Problem**: `skipOverlappingReconcile` (`worker.ts:73`, `reconcile-serialize.ts:15`) is a **per-isolate boolean** — it stops overlap within one isolate, not across isolates. Cron overlapping the next fire, or cron overlapping the manual admin trigger, runs the reconciler on two isolates against the shared Convex store. (Billing itself is idempotent — W2.4 — so this is about redundant work + triple-nudges + any non-idempotent reconcile step, not a double-charge.)
- **Change**: acquire a **fenced lease** in Convex before the cron reconcile/GC lane runs (a single lease row with a monotonic fencing token; a second isolate that can't acquire skips). Reuse the existing lease pattern (`owner-deletion` lease / `wakes.claimDue`). Keep the per-isolate boolean as a cheap fast-path inside a held lease.
- **Files**: `packages/claxedo-server/src/worker.ts` (scheduled lane), `workgraph-host/reconcile-serialize.ts`, a Convex lease mutation (note: Convex fns live outside this checkout — coordinate the mutation contract; if the Convex side can't be edited here, ship the client half + a contract note and flag the Convex work).
- **DoD**: positive-control test — two concurrent `scheduled()` invocations run the reconcile body **once**; fencing rejects the stale holder. Cron still runs on schedule. **Verify**: Miniflare test of `scheduled()` with a stubbed Convex lease; do not deploy to observe.
- **Deployment**: CF. Also documents the Node equivalent (W6 is the Node interlock).

---

## 6. Wave 5 — `LiveSyncRoom` DO: close the hosted live-sync gap (the big one)

Depends on W1 (naming). This is the one genuinely new component. Sub-stepped so it can be built and verified incrementally under Miniflare before any deploy.

### W5.1 — `LiveSyncRoom` Durable Object (holds SSE, fans nudges)
- **What**: a per-owner (per-visibility-scope: owner for personal, org for teams) DO that **holds the client SSE/WS connections** (hibernatable) and, on receiving a nudge, **fans it to its held connections**. Keyed `idFromName("owner:"+ownerId)` (or `"org:"+orgId`). Mirrors `WorkspaceRelayRoom`'s hibernation-rebuild pattern (`cloudflare.ts:741-786`).
- **DoD**: unit/Miniflare test — N held connections in one room all receive a nudge posted to the room by name; hibernation rebuild works (evict → wake → still delivers); an idle room parks (no per-ping wake — reuse W3's hibernation-safe holding).

### W5.2 — Worker route: hosted SSE terminates at the owner's `LiveSyncRoom`
- **What**: replace the hosted heartbeat-only stub (`hosted-shell.ts` `eventsStream`) so `GET /api/claxedo/events` (and `/global/event`, `/api/wr/events`) on the Worker routes the client's SSE to `LiveSyncRoom.get(owner)`. **Client contract unchanged** — same SSE, same `eventVisibleTo` scoping, same reload-on-nudge. The client (`event-ingress.ts`, TanStack Query) is NOT touched.
- **DoD**: Miniflare test — a browser SSE against the Worker is held by the correct owner's room; `eventVisibleTo` filtering preserved; zero client-side change (grep confirms no client diff).

### W5.3 — Write-path rings the room (nudge origination)
- **What**: on the hosted path, a mutation that changes WorkGraph/documents **rings the owner's `LiveSyncRoom`** by name (from whatever isolate handled the write, or off a Convex change). This is the hosted equivalent of the in-memory `claxedoBus.publish(workgraph.changed)`. The Convex composition currently does NOT publish the doorbell (Hazard A finding #7) — this closes it.
- **DoD**: positive test — a mutation on isolate A causes a client held on isolate B (same owner) to receive the nudge and reload; the same event carried by the in-memory bus on self-host is unchanged. **Verify**: Miniflare end-to-end (two simulated isolates, one room).

### W5.4 — Live-sync integration drill (vision-reviewed)
- **DoD**: on a `wrangler dev` hosted composition, a real WorkGraph change reflects in a second browser tab within the debounce window, with **vision-reviewed** screenshot/video evidence (no false-positive verification). Self-host live-sync unchanged (regression check). Only then flip the relay-eval / hazards docs Hazard A from "proposed/open" to "closed."

---

## 7. Wave 6 — Node multi-instance coordination via Convex (secondary path)

Owner decision (2026-07-18): the Node/Fly control plane runs **multi-instance, coordinated by Convex** — NOT single-instance-with-interlock, NOT Postgres. Convex is already the hosted store; lean on it for coordination *and* live-sync so N Node instances are safe. Secondary priority to the CF waves (CF is primary), but a first-class supported path. Much of the mechanism is **shared with the CF waves**: the fenced Convex lease (W4) and the Convex change-write (W5.3) do double duty here.

### W6.1 — Coordinate background work with Convex leases
- **Problem**: the reconciler (`server.ts:1102`), supervisor ownership (`workspace-supervisor-store.ts:25` `runtimes` map), health monitor (`workspace-supervisor-sandbox.ts:529`), idle-reaper (`workspace-supervisor.ts:455`), and the wakes scheduler are all guarded by **per-process memory**. With N Node instances they triple-fire, race over `runtimes` ownership, and the idle-reaper can kill a sandbox another instance still routes to.
- **Change**: acquire a **fenced Convex lease** before each periodic job / ownership claim (reuse W4's lease + the `wakes.claimDue`/`owner-deletion` pattern). Reconciler runs on the lease-holder; supervisor ownership becomes an **authoritative Convex ownership lease per workspace** (replacing the best-effort mirror in `cloud/mirror.ts`); wakes claims via Convex; health-monitor/idle-reaper act only under the workspace's ownership lease.
- **Files**: `packages/claxedo-server/src/server.ts`, `central-session-runtime.ts`, `workspace-supervisor*`, `cloud/mirror.ts`; Convex lease mutations (**note the BLOCKER — Convex fns not in this checkout**; ship the client half + contract, flag the Convex work).
- **DoD**: positive-control test — N instances against one Convex-backed lease run each job **once**; workspace ownership is single-holder; failover is fenced (stale holder rejected). Single-box: the lease is trivially always-held → zero behavior change.

### W6.2 — Live-sync fan-out via Convex subscription (Hazard A, Node path)
- **Problem**: the in-memory bus doesn't cross Node instances. CF solves this with the `LiveSyncRoom` DO (W5); Node solves it with **Convex**.
- **Change**: each Node instance holds a **Convex subscription** to the per-owner change tip and, on push, nudges its **local** SSE clients (client SSE contract unchanged, same as CF/self-host). NOTE: the current hosted transport is `ConvexHttpClient` (`hosted-runtime.ts:1`) which does **not** subscribe — this needs the subscribing `ConvexClient` (`convex/browser`, works in Node) for the change-tip query only. The change *write* half is already covered by W5.3 (mutations record the change in Convex).
- **Files**: `packages/claxedo-server/src/workgraph-host/*` (add the subscribing client + per-owner tip subscription), the SSE route wiring.
- **DoD**: positive test — a change written on instance A pushes (via Convex) a nudge to a client held on instance B; 2 Node instances + 1 Convex. Self-host single-box unchanged (in-memory bus path untouched).

---

## 8. Deliberately deferred / out of scope

- **Postgres / Redis path** — NOT used. Owner decision: Convex is the store + coordination + (Node) bus for both hosted paths. Removed from scope entirely (no adapter, no `LISTEN/NOTIFY`, no Redis).
- **Sticky routing for a Bun relay** (Hazard B) — moot: the relay is CF Durable Objects (validated dial-in); Node control-plane instances don't hold workspace tunnels, so there's nothing to route stickily.
- **Additional per-job leases** beyond the reconciler/ownership/wakes/health/idle set — add as new periodic jobs appear (same Convex-lease pattern).

---

## 9. Global Definition of Done / gates

- [ ] Every wave verified **locally-first** (Miniflare/`wrangler dev` for CF, targeted tests) — no deploy-to-discover.
- [ ] Every coordination/cost fix has a **positive-control test** (fails without the fix).
- [ ] `bun typecheck` green from the affected package(s) (workspace-relay: `bun run build` in `@claxedo/workgraph` first if types cross; run `tsgo -b` directly to skip the debt-ratchet).
- [ ] Single-box self-host behavior **unchanged** (explicit regression check per wave).
- [ ] Hazard A (live-sync) flipped to CLOSED in the hazards + relay-eval docs **only** with vision-reviewed evidence (W5.4).
- [ ] Hibernation "cost" gate flipped to CLOSED with Miniflare evidence (W3).
- [ ] The deployment-nuance reference (W1.2) is complete and cross-linked.
- [ ] Docs updated: hazards doc (`LiveSyncRoom`, Hazard A/D status), relay-eval doc (hibernation, cost), this plan's status.

## 10. Suggested execution order & parallelism

1. **W1** (docs/naming) — 1 agent, fast, unblocks vocabulary.
2. **W2.1–W2.4** — 4 parallel agents (disjoint files), each with its own test. W2.4 may escalate.
3. **W3** — 1 agent (relay), after W2 (touches relay).
4. **W4** — 1 agent, after W2.4 (billing verify informs how much fencing matters).
5. **W5.1→W5.4** — sequential sub-steps, 1–2 agents; the largest CF wave; gated behind W1 + W3 (reuses hibernation-safe holding).
6. **W6.1–W6.2** (Node secondary) — after **W4** (shares the fenced Convex lease) and **W5.3** (shares the Convex change-write). Lower priority than the CF waves; do once CF (primary) is landing.

**Priority: CF (W1–W5) is primary and leads.** W6 (multi-instance Node via Convex) is the supported secondary path and reuses W4's lease + W5.3's change-write, so it's cheaper once those land. Waves 1–4 are low-to-medium risk and self-contained. Wave 5 is the new DO (vision-review gate). Nothing here requires a production deploy to verify. **Blocker: the Convex functions are not in this checkout — W2.4/W4/W5.3/W6 client halves are in-repo; their Convex mutation/subscription halves need the Convex repo or a contract handoff.**
