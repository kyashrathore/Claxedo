# WorkGraph live-sync redesign: doorbell + revalidate (and claxedo-owned file watching)

- **Status**: IMPLEMENTED (2026-07-17) — Waves 0–4 landed and live-verified; the three review blockers are fixed. ONE deliberate omission: Wave 3 task 4 ("single local socket") was NOT done — live measurement showed the DoD socket budget is already met without it, so it is a non-blocking optimisation. See §9 for the ledger (deviations, resolutions, live evidence, known-unrelated failures).
- **Driver**: task/board loads stalling 25–35s. Root cause: the browser allows 6 HTTP/1.1 connections per origin, and the app holds several never-ending local-origin requests per tab — 2 SSE streams, the WorkGraph `/changes` long-poll (25s window per cycle), and one documents `watch` SSE per surface. Ordinary fetches starve behind them. Server latency is ~4ms; this is entirely client socket-budget.
- **Method**: start from what the UI actually needs, decide whether the current mechanism is required, then redesign the transport without weakening any guarantee.

## 1. UI requirements (derived from every consuming surface)

| Surface | Data | Freshness needed | Source today |
|---|---|---|---|
| Streams home (project-grouped cards) | all streams + tasks (titles, states, counts) | ≤1–2s while agents work; instant after own action | full snapshot |
| Stats strip (Active / Agents working / Needs you) | derived | same | snapshot + attention |
| Needs-you card / waiting panel | attention list | ≤ a few seconds | attention API (never snapshot-derived — keep) |
| Task dialog | work item + attempts + activity + evidence | at open; after own actions | on-demand fetches |
| Settings dialogs | defaults, capabilities | at open | on-demand |
| Execute eligibility | task states + deps | same as board | snapshot-derived |

Requirements that fall out:

- **R1 — the UI renders state, not events.** No surface replays an event log; the task Activity feed is an on-demand *paged fetch*, not a live stream.
- **R2 — remote mutations are the reason live sync exists** (agents, MCP tools, other tabs). Local mutations already refresh via command results + reload.
- **R3 — freshness is human-scale** (~1–2s) while work happens; zero traffic worth spending when idle.
- **R4 — never *silently* stale.** If currency is unknown (disconnected), show the reconnecting/stall state — this exists today and must survive.
- **R5 — multi-client**: desktop app, extra tabs, MCP agents all mutate concurrently.

## 2. Is the cursored change feed required? Split it into its three roles

1. **Server-side change log (`wg_v2_changes`)** — load-bearing far beyond this UI: settlement/wakes consumers (plan 2026-07-17-002), audit/provenance, MCP, future incremental clients. **Keep, untouched.**
2. **Client change *detection*** — "did anything change after cursor N?" — required (R2/R3/R5). But note what the client actually does today: `change-sync.ts` types the window as `readonly unknown[]` ("only its size matters") and, on any non-empty window, reloads the full snapshot + attention. Client-side ordered/exactly-once *delivery* is unused; snapshot reload is idempotent. The cursor's real client value is a cheap monotonic version + resumability.
3. **Client *transport* (dedicated 25s long-poll)** — **not required.** It is the socket-starvation culprit and conveys nothing that a pushed signal couldn't. This is the thing to replace.

## 3. Proposed design: doorbell + reload (OWNER-DECIDED 2026-07-17: `/changes` route is REMOVED)

**Owner decisions**: (1) the `/changes` HTTP route is deleted outright — no future FE incremental work is anticipated, so no transport is kept "just in case". (2) The nudge rides the existing events stream.

**Which stream — central or workspace-runtime?** Answered from `claxedo-server/src/routes/opencode-compat-events.ts`: in local mode `/api/wr/events` is served by the **central claxedo-server** — it and `/global/event` share one central stream fed by `claxedoBus`; local/unsigned workspaces never open a workspace-scoped connection. Per-workspace `/api/wr/events` (via relay) exists only for cloud/user-hosted workspaces. WorkGraph is central (owner-scoped), so publishing `workgraph.changed` on `claxedoBus` puts a control-plane event on a control-plane stream — planes align, and remote workspaces' runtime streams never carry it.

**Server** (packages/workgraph + claxedo-server host):
- Post-commit (where appended changes become readable), publish `workgraph.changed { ownerUserId }` on `claxedoBus`, coalesced (~100ms) so bursts emit one nudge.
- **Delete** `GET /api/workgraph/changes` (route + http contracts + router long-poll loop). The `wg_v2_changes` log itself stays (settlement/wakes/audit read it in-process/server-side).

**Client** (claxedo-app):
- Subscribe to `workgraph.changed` on the already-open central events stream → debounce-trailing reload of snapshot + attention (the same `reload()` as today; same stall-banner-on-error semantics).
- On route activation, tab → visible, or events-stream reconnect: **reload unconditionally once** (snapshot is small; these are rare). With `/changes` gone, the entire client cursor machinery — `change-sync.ts`, `sync-lifecycle.ts` polling, `WORKGRAPH_CHANGE_WAIT_MS`, `cursor_invalid` handling — is deleted, not adapted.

**Blast radius of removing `/changes`** (verified consumers):
- `claxedo-mcp` `workgraph_changes` tool ("read the ordered change feed", `workgraph-tools.ts:452`) — dies with the route. Agents observing WorkGraph re-read the snapshot/attention instead (request/response fits MCP anyway). ⚠ Owner: confirm the MCP tool goes too, since it's agent-facing (not FE).
- `e2e/helpers/real-workgraph-harness.test.ts` long-polls `/changes` — rewrite against the nudge or snapshot.
- Router/contract/conformance tests covering `/changes` — deleted with the route; store-level change-log tests remain.
- The client `changes()` method, `ChangesResponseSchema`, protocol group entry, SDK surface — deleted.

**Resulting properties**
- WorkGraph holds **0 sockets**; worst-case staleness collapses from 25s-poll-boundary to bus-push latency (ms) with reconnect gaps covered by revalidation.
- Idle cost: zero requests (today: one poll per 25s per visible tab).
- N tabs: no extra sockets for workgraph; a later SharedWorker consolidation multiplies the win across the whole event stream.
- R4 preserved: SSE disconnect already surfaces the reconnect state; revalidate-on-reconnect restores known-currency.

**Failure analysis**
- Missed nudge during an SSE gap → caught by reconnect/visibility revalidation. Within a live connection SSE is in-order and lossless.
- Nudge racing the write → publish after commit; reload reads transactionally; a nudge for an already-seen tip is a no-op (`tip <= cursor`).
- Attention-only transitions: verify every attention write also appends a change (or emit the nudge from attention writes too) — implementation gate below.

## 4. Companion workstream: claxedo-owned file watching (owner decision)

**Owner directive**: file-change notification must be a **claxedo-server capability**, working for every harness — not dependent on the vendored engine's per-directory app instance ("works for all, not just when the opencode harness is working").

- Today: two watchers. The engine's `packages/core/src/filesystem/watcher.ts` (@parcel/watcher; publishes `file.watcher.updated` over `/global/event`; feeds file tree/review/vcs) — tied to engine instances. And documents' private `fs.watch` per registered doc (`claxedo-server/src/documents/watch.ts`) with its own `/documents/events` SSE per surface.
- Target: one claxedo-server **WatchService port** (parcel-watcher adapter; the engine's watcher code is reusable), directory/path-scoped subscriptions, events published as `file.changed` on the claxedo bus (`/api/wr/events`). Hosted/user-hosted workspaces publish the same event shape from their runtime over the per-workspace relay stream (per-origin pools make those free).
- Consumers migrate: file tree + review consume `file.changed` from the bus; documents' internal watch folds into the service and `/documents/events` (client-facing SSE) retires in favor of `document.changed` doorbell events — documents keeps CAS-at-write as its correctness mechanism, so hints stay fire-and-forget.
- The engine's internal watcher may remain for engine-internal needs (vcs/tool coordination), but no app surface depends on it.

## 5. Execution plan — multiple opus subagents (owner-directed)

Structured as waves; agents within a wave run **in parallel with disjoint file ownership**. Every agent: reads its files fresh before editing (working tree diverges from HEAD), runs targeted tests only (claxedo-server full suite hangs locally), typechecks with `tsgo -b` directly (never `bun typecheck`), never commits. Coordination invariant: `packages/workgraph/src` edits require `bun run build` in that package before dependent packages typecheck (dist is gitignored).

**Wave 0 — contract (1 opus agent, small, blocking).**
Define the doorbell event contract and land it where both sides import it: `workgraph.changed { type, ownerUserId }` (and, for Wave 2-D, `document.changed { type, documentId, version }`) — schema + type in the package that owns `claxedoBus` event types (find the bus's event union in claxedo-server; follow its existing pattern, e.g. how `session.lifecycle` events are typed). Deliverable: types + a doc comment naming publisher/consumer; no behavior. Gate: tsgo clean.

**Wave 1 — server doorbell + route removal (1 opus agent).**
Owns: `packages/workgraph/src/http/*` (delete `/changes` route, its contracts, router long-poll loop, `pollIntervalMs`), `packages/workgraph/src/conformance/*` + router tests (delete route-level `/changes` coverage; keep store-level change-log tests), `packages/claxedo-server/src/server*.ts` + `workgraph-host/*` (publish coalesced `workgraph.changed` on `claxedoBus` post-commit — locate the exact point where appended changes become durable/readable; ~100ms trailing coalesce; include attention-only writes — verify every attention transition either appends a change or gets its own nudge, add test), `packages/protocol/src/groups/workgraph.ts` (drop changes entry). Then `bun run build` in packages/workgraph. Gates: targeted vitest (workgraph router/conformance, claxedo-server workgraph-host incl. a bus-publish test with fake timers for coalescing), tsgo clean in workgraph + claxedo-server. Explicit test: mutation → exactly one nudge after coalesce window; N rapid mutations → 1 nudge.

**Wave 2 — three parallel opus agents (disjoint files, all depend on Wave 1's dist):**
- **2-A client swap (claxedo-app/src/features/workgraph/...):** delete `change-sync.ts`, `change-sync.test.ts`, `sync-lifecycle.ts` poll loop + `WORKGRAPH_CHANGE_WAIT_MS`, the client `changes()` method + `ChangesResponseSchema`; replace with a bus-subscriber (`workgraph.changed` for the owner → debounced `reload()` of snapshot+attention) wired through the existing claxedo-events provider subscription mechanism (see how other features consume bus events in `app/integrations/claxedo-events.tsx`); reload-once on route activation / visibilitychange→visible / events-stream reconnect; keep the stall-banner-on-reload-error + manual retry semantics. Update `workgraph-content.vitest.tsx` + api tests. Gates: targeted vitest green, tsgo clean, zero references to `/changes` remain in claxedo-app.
- **2-B MCP + harness cleanup:** remove `workgraph_changes` tool from `packages/claxedo-mcp/src/workgraph-tools.ts` (+ tests, skill docs mentioning it); rewrite `packages/claxedo-app/e2e/helpers/real-workgraph-harness.test.ts` off the long-poll (poll snapshot or subscribe SSE). Gates: claxedo-mcp targeted tests green, tsgo clean.
- **2-C documents doorbell:** publish `document.changed` on `claxedoBus` from the documents backend's existing watch/save paths; client documents feature consumes it from the central stream; retire the per-surface `GET /documents/events` SSE (`documents-api.ts watch()` + server route) after all consumers (document-index.tsx, external-change.ts) migrate. CAS-at-write semantics untouched. Gates: documents targeted tests green (server + app), tsgo clean.

**Wave 3 — local bus single-socket (1 opus agent).**
Client opens the central bus once: collapse the duplicate `/global/event` + local-mode `/api/wr/events` subscriptions into one connection (remote per-workspace relay streams untouched — see §7, cross-machine fan-in rejected). Gates: app event-ingress tests green; manual: `lsof` shows exactly 1 held local-origin socket at idle with WorkGraph + a document open.

**Wave 4 — integration verification (1 opus agent, after 1–3).**
Live drill per repo verification convention (green tests are claims): restart claxedo-server; open app; (a) DevTools/network capture proving zero `/changes` requests and no held workgraph socket; (b) two-client propagation <2s (mutate via curl/MCP in client 2, observe board in client 1); (c) reconnect drill (kill/restart server → single reload, no silent divergence); (d) attention parity check; (e) task-open under active churn with no multi-second stall — screen-recorded/screenshotted, vision-reviewed. Files owned: none (read-only + evidence into `docs/plans/evidence/`).

**WatchService (claxedo-owned, harness-agnostic file watching) is a separate plan-sized workstream** — it stays specified in §4 but is intentionally NOT a wave here; documents' internal `fs.watch` keeps working under 2-C until WatchService lands.

Ownership matrix (no two agents share a file): Wave1 = workgraph + claxedo-server(workgraph-host/server) + protocol · 2-A = claxedo-app/features/workgraph · 2-B = claxedo-mcp + e2e/helpers · 2-C = claxedo-server/documents + routes/documents + claxedo-app/features/documents · Wave3 = claxedo-app/app/integrations + providers. Sequencing rule: 2-A/2-B/2-C start only after Wave 1's `bun run build` lands; Wave 3 after 2-A and 2-C (it touches the subscriptions they rewire).

## 6. Definition of Done (exact)

> **Amended 2026-07-17 after implementation.** Two lines below were written before §7 settled on deleting the route and are struck through — they are self-contradictory and actively misled implementation agents. Status per line reflects Wave 4's live drill (§9).

- ✅ The app issues **zero** `/changes` requests with `waitMs>0` (asserted via e2e network capture). — *0 hits in a 2950+ request capture.*
- ✅ A mutation from a second client appears on the first client's board in **<2s** (e2e, two contexts). — *1194ms measured. Caveat: verified curl-vs-browser, not two browser contexts.*
- ✅ At idle with WorkGraph open: WorkGraph holds **0** local-origin sockets; total held local-origin sockets per tab **≤2**. — *WorkGraph 0; total 1 (home) / 2 (workspace context). Met WITHOUT slice 3/4, which is therefore a non-blocking optimisation.*
- ✅ Reconnect drill: restart claxedo-server under an open board → exactly one revalidation, board recovers — no silent divergence.
- ~~All existing `/changes` contract/conformance tests pass **unmodified** (endpoint behavior unchanged).~~ **VOID** — a leftover from the pre-removal draft, contradicted by owner-settled §7 (the route is deleted, so route-level tests cannot pass unmodified). Replaced by: **store-level `wg_v2_changes` log tests pass unmodified** — the log is what §2 actually preserves. ✅
- ✅ Retire the per-surface `GET /documents/events` SSE — **FULLY DONE** (owner directive 2026-07-17: external-change detection is over-optimization). Route, `fs.watch` subsystem, and client external-change controller all removed; CAS-at-write remains the correctness floor; the `document.changed` doorbell (index refresh) survives. Note this VOIDS §93's "documents' internal `fs.watch` keeps working" — the owner explicitly chose to drop it, so the §4 WatchService is no longer a prerequisite for this line.
- ✅ Attention parity: an attention-only transition reaches the first client via nudge — *verified live (464ms) and by test; the underlying log gap was a real latent bug.*
- ✅ Visual gate per repo convention: vision-reviewed evidence showing task-open during active agent churn with no multi-second stall. — *104ms under 37 concurrent reloads vs a 79ms baseline. Evidence viewed inline; the preview pane cannot save image files, so no PNGs are archived.*

## 7. Settled owner decisions (2026-07-17)

- **`/changes` route: removed entirely** — no future FE incremental work anticipated. The `wg_v2_changes` log stays server-side. The claxedo-mcp `workgraph_changes` tool is removed with it.
- **Doorbell transport**: `workgraph.changed` published on `claxedoBus` → the central stream. Confirmed central-vs-runtime: in local mode `/api/wr/events` + `/global/event` are ONE central claxedo-server stream; per-workspace runtime streams (relay) never carry workgraph.
- **Bus unification is local-origin only**: the client stops opening the same central bus through two paths (one socket instead of two). **Cross-machine fan-in is REJECTED** — remote workspace runtime streams stay direct via relay (per-workspace auth, no central hop, different browser origin pool so they never contributed to starvation). Do not re-litigate.
- 5s-waitMs stopgap was reverted; the doorbell is the chosen fix, not window-shrinking.

## 8. Open questions (owner)

1. **Hosted control plane** (Worker): the nudge rides the local bus — hosted clients' push channel is the wakes/sinks work's territory (2026-07-17-002); until then hosted WorkGraph has no live client sync (acceptable: hosted workgraph store is the settlement plan's scope).
2. Debounce window for the nudge — default 100ms trailing unless owner objects.

## Rejected alternatives

- **Blind interval polling of the snapshot**: violates R3 idle-cost and worsens the socket math.
- **Client-side incremental application of change envelopes**: not needed by any current requirement (R1); snapshot is small; keep as a future option — the log already carries everything required.
- **Keeping the long-poll with a shorter window (5s)**: caps but does not remove starvation; strictly worse than the doorbell in both latency and cost. (Was briefly applied as a stopgap on 2026-07-17 and reverted.)
- **HTTP/2 for localhost**: dissolves the socket cap but requires local TLS provisioning; orthogonal, larger operational surface.

## 9. Implementation ledger (post-Waves 0–2 review, 2026-07-17)

### Resolutions of the review's open calls
> Provenance: these were resolved from this plan's own §7/§8 plus the owner's explicit "of course we want to remove /documents/events" — NOT from fresh per-item owner sign-off. Both remain open to reversal.
- **`/documents/events` is FULLY REMOVED (owner directive 2026-07-17, supersedes the earlier partial-retirement compromise).** The owner ruled external-change detection an over-optimization: CAS-at-write is the correctness floor, and the live "editor re-reads when the file changes on disk" behavior is not worth its cost. So the whole subsystem goes — the `/documents/events` route, the `fs.watch` machinery (`documents/watch.ts`, `openWatch`, the `document.external_changed` emission), and the client-side external-change controller + SSE `watch()`. The `document.changed` doorbell on the central bus STAYS (fires on save, refreshes the index). **Accepted tradeoff**: an open editor no longer live-updates from an on-disk edit; the next save surfaces a CAS conflict (never silent loss). This also removes the §4 WatchService dependency for closing this item — it's closed now, not deferred.
  - Superseded reasoning (kept for history): the lease had survived "solely because its connection lifetime IS the per-document `fs.watch` lifetime." Removing external-change removes that coupling outright.
- **Hosted WorkGraph goes from 25s sync to none — ACCEPTED as a deliberate trade.** Hosted composition doesn't use `createLocalEmbeddedWorkGraph`, so it never publishes the doorbell. No shipped hosted customer exists; live hosted sync is the settlement/wakes plan's push channel.
- **Orphaned `/changes` cursor telemetry (reporter, monitors, env thresholds): DELETE deliberately** — it alerts on a removed surface. (Any piece load-bearing for the tip-watcher stays.)

### Accepted design deviations from §3
- **Doorbell + ~1s tip watcher, not a pure post-commit doorbell**: `service.execute` is not the only change-row writer (activity, intake, recap, source-planning, attempt settlement, archive append directly). Publishing happens at three points, the third a tip-conditional reconciler (~1s worst-case staleness for those paths; idle cost still zero). Accepted.
- `packages/protocol` needed no change — the Wave-1 instruction to remove a changes entry was wrong; none existed.

### Real bugs found and fixed during implementation
- Attention writes never appended change rows (latent pre-existing bug): mark-read/clear from a second client was invisible to any log-derived signal. Now explicitly nudged, with a test proving the log gap was real.
- Tip-watcher baseline keyed by owner instead of org+owner → endless spurious nudges for idle multi-org owners (R3 violation). Fixed; caught by a positive control after two regression tests passed against the buggy code.
- Bus fan-out was unfiltered to every authenticated subscriber → fixed with default-deny allowlist + cross-tenant negative tests.
- Two e2e harness tests were no-ops (`/changes` 404s instantly); mutation testing proved they caught nothing; rewritten to fail under both real regressions.

### Blockers found by review — ALL FIXED in Wave 3 (each positive-controlled)
1. ~~Doorbell not wired in production~~ — FIXED. `feature-ports.ts` + `app-ports-stub.ts` now configure both features' ports. Backed by a new generic guard (`architecture/app-ports-wiring.guard.test.ts`): any feature exporting `configure*AppPorts` must be called in both wiring files, so "green tests / inert product" cannot recur silently.
2. ~~Architecture guard red~~ — FIXED, 168/0. NOTE: the review's proposed fix was incomplete — the real exemption set is `typeContractCandidates` in `import-graph.ts`; the test's `liveTypeContracts` only mirrors it. Both needed the entry.
3. ~~`connected()` aggregate OR~~ — FIXED. New `app/connection/stream-connectivity.ts` tracks per-kind counts; the context exposes `centralConnected()` beside the `connected()` aggregate. Both revalidation sites moved to central via their existing seams. `agent-status-listener.ts` deliberately KEEPS the aggregate (it reconciles statuses arriving on central *and* relay streams, so "any stream" is genuinely its edge).

### Wave 4 — live verification (evidence: `docs/plans/evidence/2026-07-17-004-wave4/`)
All six drills PASS against a freshly restarted server. (a) zero `/changes` in a 2950+ request capture; (b) two-client propagation **1194ms** at the fetch layer; (c) reconnect → **exactly one** revalidation, board == server truth; (d) attention-only write → reload **464ms**, clear → Needs-you 1→0 at **845ms**; (e) task-open under 37 concurrent reloads: **104ms** (79ms baseline) — the 25–35s stall is gone; (f) WorkGraph holds **0** sockets, total **1** at home / **2** with a workspace context.
- **A stale 2.7h-old server initially answered `/changes` with 200** and nearly invalidated the run — restarting is mandatory for any re-verification.
- **Wave 3 task 4 (single local socket) NOT done, and measurement says it is not needed**: totals are already ≤2. Collapsing needs a refcounted URL-keyed broker owning one socket with both providers as subscribers, restructuring global-sdk's `for await`/backoff/Last-Event-ID loop — a wave of work whose failure mode is a dead session stream. Left as a tracked optimisation.
- Honest gaps: the missed-nudge path was never truly exercised (the client won the reconnect race every time) — reconnect *revalidation* is verified, recovery from a genuinely dropped nudge is not. "Two clients" was curl-vs-browser, not two browser contexts. Timer-based figures are inflated by background throttling; the fetch-layer number is the honest one.

### Bug found LIVE by Wave 4 and fixed: every command was double-nudged
Measured **10 mutations → 20 nudges (exactly 2x)**. The command path nudges post-commit (~136ms); the reconciler tick then sees the tip its *own* command advanced and rings again (~982ms) — ~1s apart, so the 100ms coalesce cannot fold them. The doorbell's own comment justified over-nudging because "a nudge for an already-seen tip is a no-op" — **that inherited reasoning died with the client cursor (§3)**: the client cannot detect redundancy and pays a full snapshot+attention reload per nudge, worst exactly during agent churn. Fixed via `tipWatcher.adopt(context)` from the command wrapper (adopt the current tip as seen without ringing). Safe against under-nudging: the caller already nudged, and that reload reads the whole snapshot, so every row ≤ tip still reaches the client.
**Testing gotcha**: the watcher seeds its baseline silently on first observation, so a regression test MUST tick once before the command or the duplicate cannot appear — a test without it passes against the bug.

### Method note — three tests passed against buggy code
Positive controls (sever the code, demand a FAIL, restore) caught **three** separate would-be-vacuous tests in this plan, across two agents and the integrator. Per repo convention, treat every green here as a claim until falsified.

Remaining tracked debt: client-side event mirrors still have no drift-failing contract test (the shape is written twice, TS cannot see drift — 2-C solved this server-side by importing the bus type); `claxedo-mcp/dist` needs a rebuild before it ships.

### Known failures NOT caused by this work (verified by stashing)
- `convex-store.test.ts` attention-page failure — fails identically at HEAD.
- e2e isolates the same user across organizations — fixture drift from commit `bf576d60b2`.
- workgraph tsgo: 5 pre-existing cast errors in `test/source-issue-connectors.test.ts`.

## 10. Hosted compute placement (owner discussion, 2026-07-17)

Owner direction forming (not yet final): the hosted control plane should run as
the **Node composition on Fly** rather than Cloudflare Workers — CF remains a
portability target (guards stay) and optional proxy/CDN shield, not the primary
runtime. Rationale: one behavior across local/self-host/hosted (a long-lived
Node process runs the same bus + doorbell + Convex reactive subscription that
local runs — closing the "hosted has no live sync" gap without Durable
Objects), and the relay already anchors Fly operationally.

Scale staging: Node-on-Fly holds through ~100k registered users (~10k
concurrent SSE) on a handful of machines. At sustained ~50k+ concurrent
connections (the 1M-users/100k-heavy scenario), insert a **DO-per-owner
connection edge** in front of the same Node control plane — inbound connection
holding only, via the existing `publishChanged`/events-endpoint seams. That
split is backed by measurement: see
`docs/tech-docs/cloudflare-relay-evaluation.md` (restored 2026-07-17) — DO
hibernation works for inbound sockets; DO outbound cross-provider WebSocket
bridging failed decisively (0/800 relayed vs 800/800 direct at c200) and the
Daytona relay ships on Fly/Bun. Reload-amplification work (tip-ETag →
incremental off the preserved `wg_v2_changes` envelopes) becomes mandatory at
that same tier.

Open item this implies: revisit the settlement plan's DO `WakeLane` choice
(2026-07-17-002 recorded "don't re-litigate", but the owner is reopening the
CF-vs-Fly question; the Fly-daemon alternative was evaluated there) — the
hosted-runtime decision and the wakes-carrier decision should land together.
