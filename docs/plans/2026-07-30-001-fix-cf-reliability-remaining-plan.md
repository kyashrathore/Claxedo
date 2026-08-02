# Close the remaining CF reliability and scalability findings

Status: active implementation plan
Created: 2026-07-30
Source review: [`docs/cf-reliability-scalability-review-2026-07-28.md`](../cf-reliability-scalability-review-2026-07-28.md)

## Goal

Close every finding the 2026-07-28 hosted-Cloudflare review left open, in the
order that removes real ceilings first, and end with the system's scale limits
**measured** rather than asserted.

The review's own scale claim is the target to beat: "with the fundamentals done,
tens of thousands of active tenants is a defensible target." Getting there is
mostly mechanical — the sharding design is already right. What is missing is
index discipline, a shared rate limit, one DO shard key, and proof.

## Non-goals

- **Not** the "millions of users" rework. That needs a different per-command
  Convex write pattern, a binary relay frame format, and multi-region placement.
  Do not start those until the benches in `W7` pass.
- **Not** re-litigating the sharding shape. Per-workspace relay DOs and
  per-(org, owner) keys are correct and reviewed. See Part C of the review.
- **Not** the relay data-path rewrite (base64-in-JSON → binary frames). That is
  finding A6(3) and belongs to the relay wave after this plan.
- **Not** the tunnel **credit/ack window** — the only real fix for the `W7.1a`
  send-backpressure cliff, deferred to the same relay wave. Scoped here so it is
  not re-derived: the DO cannot observe its own send-buffer depth (workerd
  exposes no `bufferedAmount`/`getBufferedAmount` — pinned by
  `packages/workspace-relay/src/relay-workerd-backpressure.test.ts`), so
  backpressure has to become **explicit in the protocol**: the host acks every N
  relayed frames and the relay stops forwarding past a bounded outstanding-frame
  budget, closing with a named reason instead of letting the runtime destroy the
  socket. Spans `workspace-relay-protocol` (new ack frame + version bump),
  `workspace-runtime`'s host tunnel (send the acks), and the DO (track the
  budget) — three packages and a wire-compat step, which is why it is a wave item
  and not a `W7.1a` follow-up. Severity keeps it out of this plan: real
  interactive sessions do not pipeline 1,600 unacknowledged frames, so this is a
  **load-shape hazard, not a live-user outage** (it does gate the RUNBOOK
  zero-loss claim). **Validation requirement:** the failure is a **race**
  (identical `c10x1600` gave FAIL/PASS/FAIL), so any implementation must be
  validated with **repeated runs of the same shape — 3-5× `c10x2000`, all green
  —  never a single row**; one PASS proves nothing.
- **Not** a guessed per-channel in-flight frame budget. **REJECTED**, do not
  re-propose: with no acks it is a rate limit wearing a backpressure costume — it
  would close healthy fast sessions, and no local harness can calibrate the
  number (local workerd delivers 2000/2000 in 98 ms), so every candidate value
  would need its own cloud row. The credit/ack window above is the shape that
  actually bounds the mechanism.
- **Not** re-deriving findings already fixed. A1, A2, A5, B2, B3, B4 are closed
  and verified; the review carries per-finding status lines. Do not reopen them.

## Current state

Fixed and verified on `dev` as of 2026-07-30 — **do not re-report**:

| Finding | Closed by |
|---|---|
| A1 sweep wall | Index-backed dirty/stale queries + `createSweepSubrequestBudget` (`hosted-runtime.ts:213-242`), self-rotating so no cursor is needed |
| A2 identity round-trips | Per-isolate `identityCache` (`workgraph-host/hosted.ts:283-303`) |
| A5 write serialization + stampede | `workgraph_change_cursors` deleted; doorbell carries a cursor (`sync-lifecycle.ts:134-141`) |
| B2 dead minute-cron | Both crons registered; `worker-cron-drift.test.ts` guards drift |
| B3 live-sync drops | Namespace unified 2026-07-28; `id:` lines + replay ring + gap event |
| B4 503→401 | `isExplicitHttpError` propagates status (`packages/workgraph/src/http/router.ts:98-111`) |
| A6(1) relay prod config | Top-level `[vars]`, cap 256, explicit hint; `relay-config-drift.test.ts` |
| B5 timeouts (half) | `adapters/convex/timeout.ts`, 5 s reads / 10 s writes |
| B1 auto-delete (half) | `lifecycleMinutes()` floors at 1 min; Daytona now gets auto-stop/auto-delete |

**Two corrections carried forward from the re-verification**, because they change
what "done" means:

1. **B1 was overstated.** Daytona auto-stops idle sandboxes after 15 minutes by
   default, so compute was never unbounded. The remaining defect is *visibility*:
   `garbageCollect()` cannot enumerate provider state and reports success anyway.
   The work below is about being able to **see** an orphan, not about cost.
2. **The relay's `apac` pin is deliberate** — it is the closest hint for the
   current India/South-Asia user base. The defect was that it was implicit. Any
   region work must treat a geographically split user base as the trigger, not
   "apac is wrong."
3. **The relay is not broken.** The review's "every bench FAILS its gates" is
   overstated. The local gate re-run on 2026-07-30 **passes** with 2 ms WS
   overhead and zero loss, and the 2026-07-17 `dialin-10k-msgs` cloud run
   delivered 10,000/10,000 cleanly. Exactly one report fails —
   `dialin-100k-msgs`, whose all-50-connections-closed signature and impossible
   negative latency point at a hard limit (very likely the 16-channel cap fixed
   this date), not at a slow frame path. See `W7.1`.

## Architecture

Three facts shape every workstream below.

**Workers are stateless and plural.** One deployment, many isolates, no shared
memory. Anything in a JS `Map` is per-isolate. This is why `W3`'s limiter must
move to a shared store and why `W4`'s idempotency cannot stay in-process.

**Durable Objects are the coordination primitive, and their key is their shard.**
`idFromName(name)` always reaches one instance. The relay is keyed
`workspace:<workspaceId>` (`cloudflare.ts:456`) — correct, horizontally scalable.
Live-sync is keyed `org:<orgId>` (`live-sync-room.ts:244-249`) — one instance per
org, which is `W2`'s ceiling.

**Convex rows are truth; DOs are accelerators.** A wake is written before a DO is
nudged, and a sweep catches what the nudge lost. Preserve that ordering in every
change here.

---

## Implementation

Workstreams are ordered by ceiling removed per unit of effort. `W1`–`W3` are
independent and should run in parallel; `W4`–`W6` are independent of each other;
`W7` gates the release claim.

### W1 — Make the sandbox GC able to see (finding B1 remainder)

The reaper's three layers are still off. Provider expiry now bounds cost, but
nothing can answer "what is running that shouldn't be?"

- [x] `W1.1` **DONE 2026-07-30** (`drivers/daytona.ts`): `list()` on the driver
      plus the `list` the default client never populated
      (`createDefaultClient`, drains the SDK's async iterator). Pages 1-based,
      a short page ends the walk, bounded by `MAX_LIST_PAGES`. Labels are passed
      through **exactly as the provider reports them** and the ownership filter
      is deliberately WIDE (flat `workspaceId` OR dotted `claxedo.workspaceId`):
      narrowing it would re-create the invisible-orphan defect, and the authority
      on what may be *destroyed* is the manager's `app`-label check. A listing
      error propagates rather than degrading to an empty page. `hostId` is
      derived via `labelName(workspaceId)` — the same expression `ensureHost`
      stores on the lease, so a live sandbox cannot fail GC's identity check.
      *(Superseded original text follows.)* Implement `list()` on the Daytona driver.
      `createDaytonaSandboxDriver` (`packages/sandbox-manager/src/drivers/daytona.ts:299-357`)
      returns no `list`; the internal client declares one (`:39`) but the
      default client (`:143-156`) never populates it — implement it there too
      (`Daytona.list()` returns an async iterator in `@daytona/sdk@0.192.0`).
      **Corrected 2026-07-30 — label contract:** do **not** filter on the dotted
      `claxedo.workspaceId` label. `garbageCollect()` matches
      `target.labels?.app !== appLabel` (`index.ts:1008`, `"claxedo"`) and reads
      flat `labels.workspaceId`/`labels.epoch` (`:1012-1013`), built at
      `index.ts:599-605`. Filter on `app: "claxedo"` and build each target's
      `labels` from **`sandbox.labels` on the returned object** — never from
      ensure inputs. Mirror the `exe` driver's *shape* (`exe.ts:220-226`) but
      not its label sourcing (exe reads a per-process `Map`, so post-restart it
      returns `labels: undefined` and GC skips everything).
- [x] `W1.2` **DONE 2026-07-30 — Worker registry, as directed.** Verified first
      that no shortcut exists: `@cloudflare/sandbox@0.8.9` has no enumeration
      surface (`getSandbox` is get-or-create; `listDurableObjectIds` is
      `cloudflare:test`-only), and the account-level REST list-objects endpoint
      returns `{ id: <hex>, hasStoredData }` only — `idFromName` is one-way, so a
      hex id cannot be mapped back to `claxedo-<workspaceId>`, leaving no labels,
      no ownership check, and no safe destroy.

      Built the registry instead: the sandbox Worker writes one R2 object per
      live sandbox under `sandbox-registry/` on `ensure-runtime` and deletes it
      on destroy, with GC's labels in `customMetadata` (so a listing is one LIST
      per page, not one LIST + N GETs). New admin-gated `GET /sandboxes` route
      paginates the registry; `createCloudflareSandboxDriver.list()` consumes it.
      The driver now also sends `labels` on `ensure-runtime` — without that the
      registry could not record ownership or epoch.

      Three deliberate design points:
      - **Deregistration happens only after `destroy()` succeeds**, so a failed
        destroy stays visible to the next sweep.
      - **A registry write never fails `ensure-runtime`.** Stranding a user's
        workspace because R2 is unwell is worse than the degraded path (one
        invisible sandbox = the pre-registry status quo). Logged, not fatal.
        Labels are also capped/filtered: `customMetadata` is ~2KB and
        caller-supplied labels are unbounded, so one long label would otherwise
        make a sandbox **unregisterable** — an invisible orphan.
      - **An un-upgraded Worker throws, never returns `[]`.** 404/501/
        `supported:false` raises `CloudflareSandboxListingUnsupportedError`,
        which `garbageCollect()` converts to `listingUnsupported`. Returning `[]`
        would make GC treat every live sandbox as an orphan and **destroy the
        fleet** — asserted by a test that fails if the sentinel handling is
        removed. A 500 still propagates as a real sweep failure, so a transient
        R2 outage is not laundered into the not-alerted path.

      **Deployment prerequisite (operator action):** GC visibility on this driver
      needs a Worker redeploy *and* the `BACKUP_BUCKET` R2 binding. The deploy
      workflow does not create the bucket —
      `wrangler r2 bucket create claxedo-sandbox-backups` is manual. Until then
      the sweep is loud-but-blind, not silently wrong. Also note this Worker's
      compat date + SDK + wrangler are frozen as one unit behind a ~4.5GB image
      deploy, so **the registry code is unit-tested but has never run on
      workerd** — first real deploy is the remaining risk.

      Coverage: 8 new Worker tests
      (`scripts/sandbox/cloudflare-worker/src/registry.test.ts` — the Worker had
      **zero** tests before), 7 of which fail against the pre-registry Worker.
- [x] `W1.3` Make a listing-incapable driver **loud**. DONE 2026-07-30.
      `garbageCollect()` returns `listingUnsupported: true` + `driver`
      (`sandbox-manager/src/index.ts:990-1003`, type at `:539-553`); the GC route
      logs `console.warn` and answers **501** with
      `error: "sandbox_gc_listing_unsupported"`
      (`claxedo-server/src/routes/hosted-sandbox-admin.ts:41-60`). The cron
      (`worker.ts:391-405`) warns on that specific code but does **not** throw:
      a standing capability gap no run can change would otherwise leave the cron
      permanently red and train operators to ignore the line where a real reaper
      failure appears. Any other non-2xx still throws.
      **Ripple (found in review):** `workspace-supervisor.ts`'s local
      `garbageCollect()` returned a hardcoded result whose `kept` was a LEASE
      inventory — it never looks at provider state, so it too was reporting a
      clean sweep. It now sets `listingUnsupported` with
      `driver: "workspace-supervisor"`; the local supervisor has nothing
      independent to enumerate, so "orphan" is not representable there and
      saying so beats implying a sweep happened.
- [x] `W1.4` **DELETED** `decideSandboxIdle` (was `lease-policy.ts:95-113`) —
      2026-07-30. Zero production callers confirmed by repo-wide grep: only its
      own unit test, while every sibling in the file is wired
      (`decideSandboxStart`/`decideSandboxHealthFailure` from
      `workspace-supervisor-sandbox.ts:329,633`, `nextSandboxRetryAt` from
      `sqlite-supervisor-state.ts:201`). Idle shutdown is covered twice without
      it: provider expiry (Daytona auto-stops at 15 min, plus explicit
      autoStop/autoDelete) and a GC that can now see. A third never-executed
      safety layer would be trusted the first time it fired having never run.
      Its test was removed with it; a rationale comment holds the spot.
      **Still open, not mine to delete:** `listNeedingDriverReconciliation`
      (`convex/sandboxLeases.ts:592`) is likewise unreferenced by production code
      (only `convex-lease-reaper-policy.test.ts`) and does an unbounded
      `.collect()`. It lives in `convex/`, owned by the `convex-index` agent
      (`W5`) — that agent should delete it or wire it, not leave it dormant.

**Acceptance:** MET 2026-07-30. Positive controls, each shown FAILING against
pre-fix code before the fix landed:

| Control | Pre-fix failure |
|---|---|
| Real Daytona driver + real manager, orphan with **no lease**, asserts destroyed (`drivers/daytona.test.ts`, "W1 positive control") | `expected [] to deeply equal [ 'sb_orphan' ]` |
| Same sweep keeps a **live** lease's sandbox | `expected [] to deeply equal [ 'sb_live' ]` |
| GC flags a listing-incapable driver (`manager.test.ts`) | `expected undefined to be true` |
| GC route 501s instead of 200-ing an empty sweep (`hosted-sandbox-admin.test.ts`) | `expected true to be false` (was 200) |
| Daytona `list()` pages, filters, and throws on listing failure (4 tests) | `spy called 0 times`; `must provide a Promise to .rejects, not 'undefined'` |

Suite: 180/180 in `sandbox-manager`, typecheck clean. **Note the pre-existing
baseline:** `claxedo-server` has ~59 failures at HEAD unrelated to this work
(`CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM` missing in
`workspace-supervisor-cloud.test.ts` and friends), verified by re-running with
all `W1` changes stashed and `dist` rebuilt at HEAD.

### W2 — Raise the live-sync ceiling: measure first, shard only if measurement demands it (finding A4)

**Restructured 2026-07-30 after adversarial verification.** The original
"sharding is the fix; the cap is the symptom" was asserted without measurement:
`MAX_CONNECTIONS = 256` (`live-sync-room.ts:55`) is **self-imposed**, far below
Cloudflare's ~32k hibernatable-socket-per-DO limit, and the room's work per
nudge is a tiny attachment-read + filter fan-out. If one DO comfortably holds
the plan's own 1,000-connection acceptance target, sharding is complexity with
no ceiling removed — and verification found four real hazards in the sharding
design as written:

1. **The plan listed only publishers.** The site that decides which shard a
   connection lands in is the subscriber path — `connectLiveSyncRoom`
   (`live-sync-room.ts:663`, reached from `routes/hosted-shell.ts:344`) — and
   there is a **third** publisher (`workgraph-host/hosted.ts:232`). Also
   `liveSyncRoomName` (`:214-220`) short-circuits to a hand-composed
   `"owner:local"` at `:215`, so "derived in exactly one function" was already
   false.
2. **Shrinking N is a silent, indefinite blackout.** Subscribers held on
   retired high shards receive nothing, and there is no natural
   forced-reconnect: heartbeat reauth (`:735`) compares only
   `user.subject`/`user.orgId` (`:334-338`), which an N change does not alter.
3. **Cursors do not survive a shard move**, and the ahead-cursor direction
   fails silently (`sse.ts:69` short-circuits `hasGap`) — the client keeps a
   dead cursor forever. The comment at `live-sync-room.ts:128-144` names this
   hazard; sharding makes it routine.
4. **`assertLiveSyncRoomName`'s regex goes dead** under a `:<shard>` suffix
   (`org:undefined:3` passes), and fan-out is wrong as a blanket rule anyway:
   `workgraph.changed` is subject-scoped (`event-visibility.ts:66-69`) — ringing
   N shards on the hot command path buys zero delivery.

Also note: the WS path counts `state.getWebSockets().length` (`:461`) while SSE
counts `this.connections.size` (`:486`) — two independent 256s, not one cap.

- [x] `W2.1` Add the missing cap test (both WS and SSE counters), asserting the
      503 body — the current cap has zero coverage.
- [x] `W2.2` **Measure:** drive 1,000+ concurrent connections into one room DO
      under workerd/miniflare (the relay bench machinery is the template) and
      measure connect success and nudge fan-out latency at 256 / 1,000 / as
      high as the harness allows. This is the decision input.
- [x] `W2.3` **If measurement says one DO holds ≥1,000 with acceptable fan-out
      latency:** raise `MAX_CONNECTIONS` to the measured safe number (one
      shared constant for both counters), record the measurement in the review
      doc, and file sharding as a documented future design (carrying the four
      hazards above) — do not build it now.
- [~] `W2.4` **NOT NEEDED — measurement passed 2026-07-30.** One room held
      **16,000** connections at a 100% connect rate with nudge p99 of 417ms
      (p99 at the 1,000 target: **23ms**, ~40x inside the 1s bar); the >16k
      failures were the harness's transport, not the room (`capRefused=0`).
      Sharding would remove no ceiling, so it is NOT built. Cap raised to a
      measured 2,000 (one shared constant) and the four hazards below are
      retained as the design record should an org ever exceed 16k. Original
      item, unstarted: implement sharding with all four
      hazards addressed — subscriber site + all three publishers, per-event-type
      fan-out (org-wide events fan out; subject-scoped events target),
      forced-reconnect on N-epoch change folded into the reauth comparison,
      cursor-reset-on-foreign-shard, tightened name regex, and N cached off the
      publish path. `N=1` byte-identical to today.

**Acceptance:** the cap test exists and fails against a broken cap; a measured
number replaces the asserted one; either the cap is raised to a
measurement-backed value or sharding lands with the four hazards tested. A
1,000-connection org connects fully either way.

### W3 — Real rate limiting and body caps (finding A7)

`createFixedWindowConnectionRateLimiter` (`control-plane/rate-limit.ts:31-35`,
`Map` at `:36`) stores buckets in a per-isolate `Map`, so the effective limit is
`configured × live isolates` — it loosens exactly under load. Worse, most of the
surface has no limiter at all: the `/api/workgraph/*` routes
(`hosted-app.ts:506-507`), the documents routes (`:508-531`), and
checkpoint/lifecycle routes (`:502-504`, including destroy) have none.
**Corrected 2026-07-30:** the limiter has *nine* consumers, not one
(`hosted-app.ts:436-443`, `routes/hosted-workspace.ts:259-271`,
`workspace-connection-routes.ts:28`, `hosted-device-auth.ts:160`,
`billing-routes.ts:148`, `hosted-workgraph-admin.ts:28`,
`workspace-signed-access.ts:68`, `workspace-local-host-link-routes.ts:142`,
`routes/workspace.ts:143-266`), and a **second limiter implementation** exists —
`createSlidingWindowRateLimiter` (`claxedo-channels/src/core/rate-limit.ts:32`,
used by `channels-control-plane.ts:448,452,625`). `W3` must reconcile both.
Sharpest gap: `/api/billing/polar/webhook` is unauthenticated **and** unlimited
— the limiter built at `billing-routes.ts:148` is applied only to /checkout and
/portal because it keys on `auth.user.subject`, which the webhook lacks.

`hosted-app.ts:364` already does `app.use(securityHeaders())`, so an app-level
middleware seam exists (`:364-381` — the only global middlewares). Hono is
4.10.7 and ships `hono/body-limit`, imported nowhere today; the one hand-rolled
cap is documents' 2 MiB (`documents.ts:29`, enforced `:510,:519`) — the
route-inventory test needs an exemption for routes that already cap by hand.
**No Cloudflare rate-limiting binding exists in any wrangler config**; adding
one means a `[[ratelimits]]` block (corrected 2026-07-30: first-class schema
key in wrangler 4.114.0, not the beta `[[unsafe.bindings]]` spelling) that must
be mirrored under `[env.staging]` — wrangler does not inherit bindings into
named environments (the exact bug class behind the relay `[vars]` defect).
Constraint: `simple.period` accepts only 10 or 60 seconds, so the shared window
is not a free parameter.

- [ ] `W3.1` Move limiting to a shared store: Cloudflare's native rate-limiting
      binding (cheap, approximate — right for abuse) or a counter DO per
      principal (exact, costs a DO call). Pick one and record why.
- [ ] `W3.2` Apply a **default** limiter + body cap as one Hono middleware at
      `hosted-app.ts:364`, with per-route overrides — opt-out, not opt-in. The
      current opt-in posture is why 50+ routes have nothing.
- [ ] `W3.3` Cap the Polar webhook body **before** `c.req.text()`
      (`billing/billing-routes.ts:215`), which currently buffers the whole body
      before verifying the signature.
- [ ] `W3.4` Keep the in-memory limiter as a first-layer local fuse only.

**Acceptance:** a load test from two simulated isolates shows the **global**
limit enforced, not 2×. Every mounted route inherits a body cap unless
explicitly exempted, asserted by a route-inventory test that fails when a new
route is added without either.

### W4 — Finish the failure semantics (finding B5 remainder)

Timeouts landed; the rest did not. Note the sharp edge: `withTimeout`
(`adapters/convex/timeout.ts:25-28`) bounds **caller wait** and does *not* cancel
the underlying fetch, so a timed-out mutation may still land. That makes durable
idempotency more urgent than before the timeout fix, not less.

- [ ] `W4.1` Retries with jitter on timeouts/5xx for **idempotent** operations
      only. Reads always; writes only where an `operationId` makes replay safe.
- [ ] `W4.2` Move control-route idempotency keys into Convex. Today
      `control-plane/http-idempotency.ts` is two per-isolate `Map`s (`:1`,
      `:2-6`), so two isolates both execute the "idempotent" operation. It
      already has TTL + max-entries sweeping (`:7-8`, `:95-109`) — the work is
      cross-isolate scope only. Affected routes: register/checkpoint/repair
      (`routes/hosted-control.ts:113,140,172`; `control-plane/http.ts:41,65,93`).
      `operationId` in WorkGraph and ETag CAS in documents are the in-repo
      templates. **Latent bug found 2026-07-30, fix in passing:** in-flight
      entries have no `expiresAt`, so they are neither swept nor evictable —
      hung requests wedge the cache into permanent 503s; and `pullLocks` leaks
      if `run` never settles.
- [ ] `W4.3` Dedup the Polar webhook on `webhook-id`, which is currently read for
      signature verification only (`billing-routes.ts:220`;
      `standard-webhooks.ts:72,95`). Existing protection is only a last-write-wins
      `source_ts` guard.
- [ ] `W4.4` Land W4's fenced cron lease. `skipOverlappingReconcile`
      (`workgraph-host/reconcile-serialize.ts:15` — closure-local, per-isolate
      via the memoized `buildApp` at `worker.ts:130,136`) and a second
      independent per-isolate guard at `hosted-workgraph-admin.ts:65-71`. Its
      own comment records that overlapping reconciles once *hung the Workers
      runtime* (staging run 29514161976). Two isolates can still overlap; fence
      both guards behind one Convex lease.
- [ ] `W4.5` Timeouts on Polar. **Corrected 2026-07-30 — Daytona was wrong:**
      the driver's lifecycle calls carry `DEFAULT_OPERATION_TIMEOUT_S = 60`
      (`daytona.ts:114`); only read/preview/secret calls are untimed — cover
      those, but the genuine gap is **Polar**: untimed calls at
      `billing-routes.ts:346` (user-facing checkout) and `billing/reconcile.ts:47,
      :110` — the latter two inside **serial for-loops on the cron path**, so one
      hung call stalls the whole sweep. `drivers/cloudflare.ts:127`'s real
      `AbortSignal.timeout` is the template; sibling `billing-store.ts` already
      wraps everything in `withTimeout`. For `W4.1`'s jitter there is no in-repo
      server-side template; the closest reusable shape is
      `claxedo-app/src/platform/sync/global-sdk/reconnect-backoff.ts:7-9`.

**Acceptance:** a fault-injection test with a hanging Convex stub fails fast with
503 instead of holding the request. A duplicate register/checkpoint across two
simulated isolates executes **once**. Two concurrent `scheduled()` invocations
run the reconcile body once.

### W5 — Convex index pass (finding A3)

119 `.collect()` calls across `convex/`. The discipline exists — `workgraphChanges.ts`
names a "no-unbounded-read" invariant and `workgraphCommands.ts` uses
`.withIndex(...).unique()` correctly. It simply was not applied everywhere.
Convex caps documents read per transaction, so these do not degrade — they
**throw**.

Hot-path sites, highest value first:

- [x] `W5.1` `orgs.ts:106` (`setActive`) reads **every org** then does a JS
      `.find()` — on every org switch — while `by_clerk_org_id`
      (`schema.ts:119`) already exists and is unused here (`model.ts:315-320
      orgByClerkOrgId` is the existing indexed helper; reuse it). **Added
      2026-07-30:** `workspaceShares.ts:24` is a byte-for-byte duplicate of this
      bug — convert it in the same pass. Note `setActive` has zero test
      coverage repo-wide; its "results unchanged" test is its first test.
- [x] `W5.2` `sandboxLeases.ts:490` (`countActiveForOrg`) scans **all**
      `runtime_leases` on **every hosted workspace create**. Its own comment
      predicts this: "if this table ever grows past the point where a scan is
      cheap, that index is the fix." Add `by_org`. Note the read-set is the whole
      table, so any lease heartbeat OCC-conflicts with any create.
- [x] `W5.3` Membership authz in `orgs.ts` reads every member of an org to find
      one row, despite `by_org_user` (`schema.ts:181`) existing. **Corrected
      2026-07-30 — five sites, not one:** `:87-90` (`resolveForMe`), `:110-113`
      (`setActive`), `:201-204` (`upsertClerkMembership`), `:243-246`
      (`deleteClerkMembership`), `:316-319` (`membershipByClerkIds`). All use
      the compound index prefix-only then JS-`.find()`; add the second `.eq()`
      + `.unique()` (shape at `workgraphCommands.ts:91-93`). Leave
      `workspaceShares.ts:45-49` — it legitimately wants all members.
- [x] `W5.4` `billing.ts:379, 394, 418` — three separate full `orgs` scans, on a
      6 h cron and twice per 15-min sweep.
- [x] `W5.5` Remaining lease scans (`sandboxLeases.ts:421, 543, 595, 613`),
      `orgs.ts:920` purge, `usageMetering.ts`, `workspaceShares.ts`.
- [x] `W5.6` Make it a standing guard: a test or lint that fails on a new
      `.collect()` without an index predicate, allowlisted exceptions only.
      Model it on `worker-cron-drift.test.ts` and `relay-config-drift.test.ts` —
      both parse config/source and assert an invariant.

**Acceptance:** each converted site has a test asserting results are unchanged,
**and** the source guard holds — measured 2026-07-30: result-equality tests
alone cannot catch a revert to a scan (identical rows, different read-set), so
the guard is the durable half of this acceptance, the behavior tests the
trustworthy half. The guard test fails on a newly introduced unbounded
`.collect()`.

**DONE 2026-07-30.** All 14 unindexed reads in `convex/` converted or bounded;
the tree-wide scan is clean and the guard holds it there.

Schema indexes added (all additive; none removed). `orgs`:
`by_billing_reconcile_flagged_at`, `by_polar_subscription_id`,
`by_purge_requested_at`. `runtime_leases`: `by_org_status`,
`by_owner_subject_status` (compound on `status` so terminal leases — the
unbounded side of that table — stay out of the read-set). `sandbox_lease_events`:
`by_rolled_up_at`.

Two corrections to the plan text above, both verified against Convex's docs and
types rather than assumed:

1. **`W5.4` cannot use a compound index.** Convex requires `.eq` on every
   leading index field before ranging a later one, and `flagStaleBillingSync`
   has no single customer id to pin — so a `[polar_customer_id,
   billing_synced_at]` index is unusable for it. It ranges the existing
   `by_polar_customer_id` above `undefined` instead (candidates bounded by
   *paying* orgs, not signups) and keeps the staleness cutoff as a JS filter.
2. **`W5.2` needed two indexes, not `by_org`.** The count has two scopes by
   design (`org_id`, and `owner_subject` for personal accounts carrying no org
   claim), the ranges overlap, and the pre-index handler counted an overlapping
   row **once**. The conversion therefore deduplicates by document id; counting
   twice would over-report usage and deny a tenant capacity it holds.

The load-bearing Convex semantics, since three conversions depend on it: a
document **missing** an indexed field is still in the index and sorts below every
value, so `.eq(field, undefined)` means "field absent" and `.gt(field,
undefined)` means "has this field at all". That is what makes an optional-field
marker (`purge_requested_at`, `rolled_up_at`, `polar_subscription_id`) an exact
index range rather than a scan-and-filter.

Where a read is a genuine enumeration with no scoping predicate, it is bounded by
a named constant instead: `LEASE_LIST_LIMIT`, `LEASE_RECONCILIATION_LIMIT`,
`LEASE_BACKFILL_BATCH`, `BILLING_SWEEP_SCAN_LIMIT`, `ORG_PURGE_QUEUE_SCAN_LIMIT`,
`USAGE_ROLLUP_ROW_LIMIT`. Each of those sweeps is level-triggered and drains its
own range, so a saturated tick continues next tick rather than skipping rows.
**The guard's allowlist is empty** — no site needed an exception.

One deliberate behavior change, asserted in tests: `sweepStaleLeases`'s `scanned`
now counts live **candidates examined**, not table size. Terminal leases are no
longer merely skipped, they never enter the transaction — which is the point, and
it makes the reaper's idempotence structural (a settled lease leaves the range).

**`sandboxLeases.list` throws rather than truncating, and that is deliberate.**
The plan's `W5.5` framing ("bound the remaining lease scans") is a trap on this
one query. `list` is not an operator-only debug surface — it is the GARBAGE
COLLECTOR's view of lease truth, reached through `SandboxLeaseStore.list()`
(`stores/convex.ts:153`) and consumed by `sandboxManager.garbageCollect()`, which
builds a workspace→lease Map from the result (`sandbox-manager/src/index.ts:1048`)
and **destroys any provisioned sandbox with no matching entry**. A silent
`.take(N)` there would delete a live customer's running sandbox the moment the
table exceeded N — the same fleet-destroying shape GC already refuses to risk for
a listing-incapable driver. So it reads `LIMIT + 1`, detects overflow, and refuses
to answer. Between a cost bug (orphans unreclaimed until someone paginates it) and
a data-loss bug, it fails toward cost. *An earlier revision of this work shipped
the silent `.take()`; it was caught while verifying the deletion handoff below.*

**`W1.4` / `W5.5` — `listNeedingDriverReconciliation` DELETED.** Its comment
claimed it was "consumed by `sandboxManager.garbageCollect()`". It was not: GC
reads leases only through `SandboxLeaseStore.list()`, and there was no call path
to this function at all — the comment described an intention, never a wiring.
Zero production callers repo-wide; the only references were its own tests, whose
`describe` block is removed with it (the file's `sweepStaleLeases` and cron
coverage stays). Deleted rather than wired, per the plan's rule against a third
dormant safety layer, which also closes it as a `W5.5` scan target. Its constants
(`RECLAIMABLE_LEASE_STATUSES`, `LEASE_RECONCILIATION_LIMIT`) went with it.

**`setActive` now has its first-ever tests** —
`control-plane/convex-org-switch-policy.test.ts`, 11 tests covering `setActive`,
`membershipByClerkIds`, and `resolveForMe`. One result is worth recording because
it bounds what "results unchanged" testing can prove: **those tests do NOT detect
a revert to the table scan.** Verified by reverting `setActive` to
`query("orgs").collect().find(...)` — all 11 still passed, because a scan and an
indexed read return identical rows; the difference is read-set size, which no
result assertion can observe. The guard caught it (`convex/orgs.ts:103
(setActive)`). The plan's acceptance criterion ("each converted site has a test
asserting results are unchanged") is therefore necessary but **not sufficient** on
its own — the guard is what makes the conversions durable, and the fixture is
what makes the guard trustworthy.

The suite also pins two things the scan-era code got right and the conversion had
to preserve: a co-member's role must never be returned for the caller (`mem_2`
holds `owner` in the same org — returning it would be privilege escalation), and
the missing-org and non-member cases must share one "Org not found" message, since
distinguishing them would confirm an org's existence to an outsider. One
intentional difference: `.unique()` replaces JS `.find()`, so duplicate
membership rows now raise instead of arbitrarily picking a winner.

**Verification.** `convex` typechecks clean (`tsc -p convex/tsconfig.json`).
153/153 across ten Convex-touching suites (the eight below plus the new org-switch
suite and `lease-store-equivalence`). Guard positive controls, each shown FAILING
first:

| Control | Guard output |
|---|---|
| Unbounded `.collect()` added to `convex/projects.ts` | `convex/projects.ts:44 (guardPositiveControl): return await ctx.db.query("orgs").collect()` |
| `setActive`'s conversion reverted to the original scan | `convex/orgs.ts:103 (setActive): const orgs = await ctx.db.query("orgs").collect()` |
| A real conversion reverted (`workspaceShares.grantedOrg`) | `convex/workspaceShares.ts:29 (grantedOrg): return (await ctx.db.query("orgs").collect())...` |
| Allowlist entry left behind after the site is fixed | `no allowlist entry is stale` → `convex/projects.ts: guardPositiveControl` |

Plus six fixture tests proving the parser's teeth: a `.filter()` chain is
reported (Convex's `.filter()` reads the whole table — the entire bug class), and
`.collect()` named only in a comment or string is not.

**`W5.6` needed a second guard the plan did not anticipate.** Every converted
site is exercised through a hand-rolled `db` double, and *all six* of them
ignored the index **name** — `withIndex("by_anything", …)` behaved as a plain
field filter. A double that accepts any index name cannot verify a scan→index
conversion at all. `src/test-helpers/convex-index-harness.ts` resolves index
names against the real `convex/schema.ts` and enforces Convex's index-order
stepping and value ordering; all six doubles now use it.

**That immediately surfaced a pre-existing tenant-deletion defect — now FIXED
(2026-07-30).** The WorkGraph owner-deletion cascade queried every table in
`WORKGRAPH_OWNER_TABLES` through `by_tenant`
(`convex/workgraphOwnerDeletion.ts`), and three of those tables never declare it:
`workgraph_dirty_events` (has `by_token`/`by_dirty`/`by_drained`),
`workgraph_agent_checkpoints`, and `workgraph_session_bindings` (both
`by_tenant_id` and friends). Against the real Convex runtime the cascade **threw**
on those tables, so an owner deletion could not run to completion and rows it was
meant to erase stayed — a data-retention defect, security-adjacent. It survived
review because every hand-rolled `db` double ignored the index name.

**No schema change was needed.** All three already carry an index whose first two
fields are exactly `["organization_id", "owner_user_id"]`, and Convex returns
every row matching an `eq` prefix regardless of the trailing field, so a two-`eq`
range over `by_token` / `by_tenant_id` enumerates the tenant completely. Both
trailing fields (`dirty_token`, `id`) are non-optional, so no row can fall
outside the range. The inline `table === quarantine ? … : "by_tenant"` ternary is
replaced by an explicit `WORKGRAPH_OWNER_DELETION_INDEXES` map plus an
`ownerDeletionIndex(table)` resolver; a missing entry means `by_tenant`, and that
assumption is now **asserted** rather than assumed.

**Emptying the ratchet exposed a FOURTH instance of the same bug**, which is the
argument for ratchets that must reach zero rather than merely not grow: the ORG
deletion cascade (`convex/orgs.ts:392` `ORG_DIRECT_TABLES`) built its plan with a
hardcoded `index: "by_tenant"` over the same imported table list, carrying the
same false comment ("every one of those tables carries `organization_id` as the
first column of its `by_tenant` index"). It threw on the same three tables. Both
cascades now resolve through the one shared function, so they cannot disagree
again.

Guarded by four new assertions in
`control-plane/convex-unbounded-read-guard.test.ts`: every cascade table declares
the index resolved for it; each resolved index is tenant-**scoped** (leads with
the tenancy prefix — an index that merely *mentions* those fields could match
another tenant's rows and delete them, which is worse than throwing); no trailing
field can exclude a tenant's row; and the map carries no entry for a table the
cascade does not enumerate. Positive control: reverting the `dirty_events`
mapping fails three of them, including `convex/schema.ts declares no index
"by_tenant" on "workgraph_dirty_events"`. `knownMissingIndexes()` is now empty and
asserted empty.

Pre-existing baseline, verified by re-running with all W5 changes stashed: the
two `architecture.test.ts` R8 failures (`sandbox-relay-target.ts`,
`request-guard.ts`) are identical without this work and belong to other
workstreams. Also note `personalOrgForUser` (`orgs.ts:19`) was already
index-bounded by `by_owner` and needed no change.

### W6 — Slower-burning correctness (findings B6, B7, B8)

- [ ] `W6.1` **The Blob hazard is a landmine.** `socketFrame`/`socketPayload`
      (`workspace-relay/src/cloudflare.ts:402-421` / `:423-430` — corrected
      2026-07-30) silently return `undefined` for `Blob` (no final return;
      caller at `:1149` does `if (!frame) return` — silent drop), and the *only*
      mitigation is the pinned `compatibility_date = "2025-05-01"`
      (`wrangler.toml:47`, whose 15-line comment already documents this exact
      hazard with measured miniflare results — cite it, don't rediscover it).
      At ≥ 2026-03-17 every binary frame drops silently — no throw, no log.
      Teach both to `await blob.arrayBuffer()` and add a **real workerd**
      round-trip test *before* any date bump. The existing tests use hand-rolled
      socket doubles (`cloudflare.test.ts:39`, `:81`) and would not catch it —
      and the relay package has **no** miniflare/workers test pool today, so the
      workerd test needs a new test dependency; budget it. Two additions from
      verification: (a) `socketFrame:415` only handles `Uint8Array` while
      `socketPayload:426-428` handles the general `ArrayBuffer.isView` case — a
      `DataView` frame drops through `socketFrame` today, independent of the
      compat date; fix both symmetrically. (b) `wrangler-h2.toml:23` pins the
      same date with no warning comment and is outside the drift test — bring it
      under the same guard.
- [ ] `W6.2` Relay failure modes: grace established tunnels through short
      resolver outages instead of closing 1008 within ~30 s; define one expiry
      policy (ideally token refresh over the live connection, not a kill); check
      the **host→client** send result — corrected 2026-07-30: the unchecked site
      is `:1263` (`sendSocket(channel.socket, tunnelFrame(message))`), not
      `:1243`; the client→host direction at `:1151-1157` already checks and
      closes 1011. Additional unchecked sends: `:1313`, `:1422`, `:1486`,
      `:1540`. Wrap frame handlers in try/catch (`webSocketMessage:1723-1732`
      awaits bare — a throw rejects the DO message promise with no close, no
      log); error out rebuilt pending requests rather than hanging — verified
      worse than "can hang": `rebuildHibernatedSockets:761-806` resets
      `pending: new Map()` (`:772`) and the pre-hibernation isolate's 30 s
      timeout died with it, so an in-flight request's promise **never settles**.
- [ ] `W6.3` **Clerk membership drift.** Memberships come from webhooks only,
      with no reconciliation sweep — billing has `flagStaleBillingSync` for
      exactly this reason and Clerk has no equivalent. A missed
      `organizationMembership.deleted` means a removed employee keeps org-admin
      access **indefinitely**. Add a daily read-mostly sweep, rate-limit-aware
      (Clerk's limits are tight, which is why the runtime path correctly never
      calls it). Treat as security-adjacent. Two gaps folded in from
      verification (2026-07-30): (a) `deleteClerkMembership`
      (`convex/orgs.ts:233-250`) writes **no audit event**, so instrument the
      delete path as part of the DoD's "with an audit event"; (b) it also has
      **no ordering guard** — `upsertClerkMembership:206` guards replay via
      `clerk_updated_at` but a delayed `.created` redelivery arriving after
      `.deleted` re-inserts the membership; the sweep must be the corrective
      writer for that route too, or the delete path gains its own guard
      (tombstone). Note Convex holds **no Clerk credential today** — the sweep
      needs the Clerk Backend API wired in (an action with a secret), which is
      new surface, not just a new cron.
- [ ] `W6.4` R2 documents: listing is 1 LIST + 2 GETs **per listed object**
      (`documents/hosted-index.ts:31-63`; orphaned/archived entries still pay
      their GETs before being discarded), `findRepository` (`:78-82`, with
      `archived: "all"`) does a full project listing to find one document, every
      write re-LISTs history — verified ~3 LISTs + up to ~150 serial GETs per
      write at the 50-snapshot cap (`hosted-managed.ts:143-174`, `:262`, `:351`,
      `:356-383`, `:384`) — and the accumulation bound **throws** past 10k
      objects (`hosted-managed.ts:517`; note this is a deliberate self-imposed
      bound, not a cursor limitation — the pagination loop at `:507-521` is
      already correct). Maintain a per-project index object; convert the throw
      to truncate-with-warning plus real pagination. O(1) listing additionally
      requires the index object to be authoritative **and** an orphan-cleanup
      path — `create` mints a fresh UUID object per attempt (`:225`), so
      orphans accumulate.

**Acceptance:** a fault-injection suite covers resolver-down, token-expiry,
stalled-client, and DO-restart, each asserting an explicit client experience —
no silent hangs, no silent drops. A seeded Clerk divergence is corrected within
one cycle with an audit event. Listing a 1,000-doc project costs O(1) R2
operations in a counting test.

### W6b — Relay frame-path cost and region placement (finding A6, items 1, 2, 4)

Three cheap, high-leverage changes on the path **every user pays on every
frame**. None of them is the full binary-frame rewrite (deferred — see
Non-goals); these are the drop-in wins.

- [ ] `W6b.1` **Chunked base64.** `bytesToBase64`
      (`packages/workspace-relay/src/cloudflare.ts:372-376`) builds its string
      one byte at a time:
      ```js
      for (const byte of bytes) binary += String.fromCharCode(byte)
      ```
      JS strings are immutable, so every `+=` allocates a new string and copies
      everything so far — quadratic in payload size. Replace with a chunked
      `String.fromCharCode.apply` over `subarray` slices of 0x8000:
      ```js
      let binary = ""
      const CHUNK = 0x8000
      for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK))
      }
      ```
      Byte-identical output. *Measured 2026-07-30: 2.0–3.7× on large frames,
      not the 10–50× originally claimed — modern engines rope-optimize string
      `+=`, so the old loop was never truly quadratic.* Keep `CHUNK` under
      the engine's argument-count limit — that is why it is 32k, not larger.
      **This is a drop-in; it does not change the wire format.**
- [ ] `W6b.2` **~~Per-connection auth instead of per-frame~~ — REWRITTEN
      2026-07-30 after adversarial verification; the original premise was
      inverted.** The two per-frame awaits are **already in-memory cache hits**,
      not round-trips: `worker.ts:181-186` wraps both resolver calls in
      `createCachedTargetClient` / `createCachedRevocationClient` (plain `Map`
      lookups with TTL 10 s / 5 s, negative results cached, concurrent misses
      coalesced — `server.ts:296-336`), and the room object is memoized per
      isolate. Steady-state per-frame cost is two Map gets and two resolved
      awaits — a microtask hop. There is no per-frame win to harvest here; the
      real frame cost is `W6b.1`'s base64 and the JSON envelope.

      Worse, removing the per-frame check would be a **security regression on
      the production path**: under hibernation the 30 s watchers are *not
      installed at all* (`:1521`, `:1524` — `hibernation ? undefined : watch…`),
      because timers do not survive DO hibernation. On that path the per-frame
      cached check (`:1137-1148`) is the **only** revocation enforcement in
      existence.

      **The rewritten item:** make revocation actually work under hibernation.
      Keep the per-frame cached check exactly as is; add an **alarm-based**
      periodic re-check (DO alarms survive hibernation; timers don't) so a
      revoked token on an idle hibernated connection is closed within the
      check interval instead of only on its next frame. Also note the token
      `exp` short-circuit at `runtimeAccessTokenActive` (`:1105-1113`) already
      bounds worst-case revocation latency to token TTL.
- [ ] `W6b.3` **Derive the location hint per workspace.** Placement is fixed at
      first DO creation (`cloudflare.ts:632`, `locationHint`) and never migrates,
      so today's single deployment-wide value is permanent per workspace. The
      `apac` default is right for the current user base and is now explicit in
      config — but a geographically split user base cannot be served by one
      value. Derive the hint at create time from the workspace's `homeRegion` or
      the requesting user's CF region, falling back to the configured default.
      Note `homeRegion` is currently near-cosmetic (`"us-east"` is hardcoded at
      `workspace-supervisor-sandbox.ts:125`), so making it a real routing input
      is part of this item.

**Acceptance:** a byte-equality test proves chunked and per-byte base64 produce
identical output across empty, 1-byte, 32k-boundary, and >1 MiB payloads, plus a
benchmark showing the improvement. A revoked token still closes an established
connection within the watcher interval with **zero** per-frame auth awaits,
asserted by counting calls. A workspace created with a non-default region gets a
DO whose location hint reflects it, asserted at the `idFromName` call site.

### W7 — The proofs (finding B9)

Per the repo's own rule ([`feedback_no_false_positive_verification`]), green unit
tests are claims. Several items above are currently asserted by unit tests only.

- [ ] `W7.1` Re-run the relay benches **in cloud** against current code, from a
      non-APAC client region.

      *Corrected 2026-07-30 — the earlier "every bench FAILS" framing was wrong.*
      The local gate was re-run on this date and **PASSES**: `c20/load20`, HTTP
      p99 overhead 8.64 ms, WS p99 2.04 ms, 80/80 relayed frames delivered,
      connect p95 2.82 ms. The relay's logic and frame path are sound at moderate
      load.

      *Second correction, same date, after adversarial verification:* that PASS
      is the best of **14** local-dry-run pairs written that morning. Same-day
      `c50/load50` siblings: two 0-delivery runs (`{1011: 50}`), then a post-fix
      100,000/100,000 run whose WS p99 was **273 ms — still over the 100 ms
      gate**. And the 2026-07-17 `dialin-10k-msgs` "clean" sibling also FAILS
      its latency gate (WS p99 3,654 ms); only its *delivery* was clean. Honest
      summary: **delivery** cliffs at high load (the 16-channel-cap hypothesis
      stands), **latency** degrades gradually and is already over gate well
      below 100k frames. "Sound at moderate load" = up to ~40k frames locally.
      Also: `bench/reports/` is gitignored, so every report cited here is
      unreproducible off this machine — CI wiring (`W7.2`) is what fixes that.

      The one genuinely failing report is `dialin-100k-msgs` (2026-07-17,
      `c50x2000`): 22 of 100,000 delivered. Read together with its sibling
      `dialin-10k-msgs` — same relay, same target, same 50 connections, same day,
      **10,000/10,000 delivered, no failure codes** — the 100k run is a *cliff*,
      not a gradient. Its `upstreamFailureCodes: {1006: 50}` means all 50
      connections abnormally closed, and its `wsMessageP99OverheadMs: -8972`
      is physically impossible, so the run's latency statistics are invalid
      rather than merely bad.

      **Leading hypothesis: the 16-channel production cap** (fixed 2026-07-30 —
      50 concurrent connections against a cap of 16 yields 503s and closures),
      possibly compounded by buffer exhaustion from pipelining 2,000
      unacknowledged frames per connection. The cloud re-run is what settles it.
      *Local data point supporting the pipelining half (2026-07-30, found when
      the shape-label fix de-conflated report history):* `c20/load20/m2000`
      delivers 40,000/40,000 with zero loss but WS p99 **109.66 ms** — a gate
      breach from pipelining alone, no channel cap involved, reproducible with
      zero credentials. The 100k cliff is therefore plausibly cap × pipelining
      compounded; the latency half already reproduces locally.
      Do **not** treat the relay as broken for interactive use on the strength of
      that one report; a real session is nothing like 2,000 pipelined frames with
      no flow control.

      Requires Cloudflare + Daytona credentials, so this is an owner-triggered
      run.

      **RUN EXECUTED 2026-07-30. The hypothesis above is FALSIFIED. The cliff's
      actual mechanism is still UNIDENTIFIED — see the correction below; an
      earlier version of this entry wrongly claimed it was solved.**

      *Phase 0 (all four gates PASS, run before any deploy):* `bun test src`
      376 pass / 0 fail; `tsc -p tsconfig.json` and `tsc -p bench/tsconfig.json`
      both clean; `local-dry-run c20` → `c20/load20/m4`, HTTP p99 overhead
      10.12 ms, WS p99 1.85 ms, 80/80, connect p95 2.72 ms, trace
      `source=relay-trace`; `cf-dev-smoke --config wrangler.toml` → `c8/load8/m4`
      PASS on real workerd, 32/32.

      *Deployed (all destroyed, see teardown):*
      `claxedo-workspace-relay-reeval-0730` (current code, production `[vars]`
      cap **256** confirmed in the deploy output),
      `claxedo-relay-resolver-reeval-0730` (`ACCESS_MODE=user-hosted`),
      `claxedo-relay-resolver-dialout-0730`, Daytona sandbox
      `82a967e0-cf3c-4627-804d-7b35b1d99006`.

      *Measured (dial-in topology, matching the 2026-07-17 `dialin-*` rows;
      direct-leg baseline is `0/0` because the loadgen cannot send Daytona's
      `x-daytona-preview-token`, so overhead columns are `n/a` — absolute numbers
      and delivery are still valid):*

      | Row | Shape | relayed WS | failure codes / reasons | connect p95 | verdict |
      |---|---|---|---|---|---|
      | `reeval-0730-c50x200` | c50x200 | **10000/10000** | none | 1622 ms | PASS |
      | `reeval-0730-c50x2000` | c50x2000 | 26000/100000 | `1006`×37 "Connection ended" | 4897 ms | FAIL |
      | `reeval-0730-c50x2000-sup` | c50x2000 | **0/100000** | `1006`×50 "Connection ended" | 795 ms | FAIL |
      | `reeval-0730-c10x2000` | c10x2000 | 9057/20000 | `1011`×10 "User-hosted tunnel disconnected" | 476 ms | FAIL |

      **Verdict vs 2026-07-17: the cliff PERSISTS, and the 16-channel-cap
      hypothesis is dead.** Three independent falsifications: (1) the cliff
      reproduces with the cap at **256**; (2) `c50x200` runs the *same 50
      connections* through the *same relay* clean at 10,000/10,000, so 50
      concurrent channels were never the problem; (3) `c10x2000` uses only **10**
      connections — an order of magnitude under any cap — and still fails. Even
      the 2026-07-17 data already refuted it: same-day `dialin-c1000-stock`
      delivered 1000/1000 with **1000** holder channels, which a cap of 16 would
      have rejected at the 17th. Message volume per connection is the variable,
      not connection count.

      **CORRECTION (same day, before any fix work started). The cloud cliff's
      mechanism is NOT known.** An earlier version of this entry claimed the cause
      was a hardcoded 64-frame pre-open queue. That claim does not survive its own
      data and is retracted. What the run actually establishes:
      - the cliff is **not** the channel cap (three falsifications above);
      - it tracks **messages per connection**, not connections: 200/conn is clean
        at both 50 and (on 2026-07-17) 50 connections; 2,000/conn fails at both 50
        and 10 connections;
      - the failures are `1006` "Connection ended" and `1011` "User-hosted tunnel
        disconnected", i.e. the tunnel or client socket dropped — no relay-side
        rejection code was returned.

      *The 64-frame queue IS a real, separately reproducible bug — just not this
      one.* `bun bench/local-dialin.ts --messages N`, ONE connection, local Bun
      relay: `N=64` → **64/64**, `N=65` → **0/65**. That boundary is exactly
      `DEFAULT_WS_PRE_OPEN_QUEUE_LIMIT = 64`
      (`packages/workspace-runtime/src/workspace-relay-host-tunnel.ts:76`),
      enforced in `forwardFrame` at `:447-449`: frames arriving past the limit
      while the host's upstream socket is still `CONNECTING` close the channel with
      1013 "Host upstream WebSocket queue overflow". Confirmed in both directions —
      `wsPreOpenQueueLimit: 100000` turns 0/2000 into **2000/2000**, and
      `wsPreOpenQueueLimit: 1` makes even `--messages 4` fail (both patches applied
      to a copy and reverted; `bench/local-dialin.ts` is unmodified). The knob is
      set **only in tests**; every production call site
      (`claxedo-server/src/user-hosted-tunnel.ts:137` and `:198`,
      `workspace-runtime/src/server.ts:656`) takes the hardcoded 64.

      **Why it cannot be the cloud cause — the check that caught the error:** the
      cloud `c50x200` row pipelines **200** frames per connection, over three times
      the 64 limit, and delivered a clean **10,000/10,000**. Had the pre-open queue
      been the cloud mechanism, that row was required to fail. It is a startup race
      that localhost exposes (upstream open loses to the burst) and the cloud path
      evidently does not. Fix it on its own merits — production blast radius
      unknown, since a real client does not pipeline 65 frames before the socket
      opens — but do **not** expect it to move the cloud numbers.

      Also note the earlier "pipelining" note above is NOT resolved by this:
      `c20/load20/m2000` is the dial-OUT path and passed; the cloud cliff is
      dial-IN. The two paths differ and neither explains the other yet.

      **Two further shipping-code defects found in the same run:**
      - *The host tunnel's main socket has no `error` handler.* Per-channel
        upstream sockets get one (`workspace-relay-host-tunnel.ts:423`), but the
        tunnel socket sets only `onopen`/`onmessage`/`onclose` (`:512-623`). Under
        Node's `ws` an `error` with no listener is an unhandled `'error'` event,
        so a transient relay 500 on reconnect **kills the host process** instead
        of backing off — observed live (`Error: Unexpected server response: 500`
        → exit, every channel lost). The `scheduleReconnect` backoff directly
        below is unreachable in the exact case it was written for. This is a real
        product defect: a user's workspace dies on a relay hiccup.
      - *The relay returned 500 on host-tunnel re-registration* while a prior
        tunnel for the same `hostId` was still held. Deserves its own repro.

      **Vantage caveat (honest):** the loadgen ran from **this machine, Jaipur,
      India (AS55836 Reliance Jio) — APAC**, against a relay whose
      `CLAXEDO_RELAY_LOCATION_HINT` is `apac` (CF edge `SIN`). The plan's
      "non-APAC client region" row is **still open** and must not be marked done
      on this run. Fly was excluded per owner instruction.

      **Also corrected:** the Daytona snapshot pinned in `bench/provision.ts`
      (`claxedo-workspace-runtime-0-5-1-ae435f536c-v8`) **no longer exists** on
      the account — provisioning fails with `DaytonaValidationError`. The run used
      `CLAXEDO_DAYTONA_SNAPSHOT=claxedo-workspace-runtime-0-5-0-v7`. Repointing
      that constant is a follow-up. Separately, `bench/setup-dialin.ts` uploads
      the 161 KB agent bundle via `echo <base64> | base64 -d`, which **silently
      exceeds the command-length limit** and leaves no bundle — the agent then
      dies with `MODULE_NOT_FOUND` while the script still reports success. Use
      `sandbox.fs.uploadFile` instead.

      **Follow-ups this run created** (none applied — W7.1 is a measurement item):
      1. ~~Find the real cloud cliff mechanism~~ **FOUND 2026-07-30 — see
         `W7.1a` below.** Unguarded WebSocket send backpressure in the
         Cloudflare DO. *The 45 s dead-socket-watchdog suspicion recorded here
         earlier is FALSIFIED — on close-code and code-path grounds, not on
         timing.* Three independent reasons:
         - **The watchdog's only exit emits `1001` with the named reason "Host
           tunnel watchdog: relay silent"** (`workspace-relay-host-tunnel.ts:586`).
           Across every failing cloud row, the observed codes are `1006`
           "Connection ended" and `1011` "User-hosted tunnel disconnected".
           **`1001` appears in ZERO reports**, and no report contains the string
           "watchdog". Had the watchdog fired, it would have signed its work.
         - **It cannot fire under this load by construction.** `lastInboundAt` is
           refreshed inside `socket.onmessage` (`:611-612`), which runs for
           *every* `ws.frame` the relay forwards. During a 2,000-frame row the
           tunnel receives frames continuously, so the budget resets constantly
           and `Date.now() - lastInboundAt` never approaches `pingIntervalMs*3`.
           The premise that a saturated host "starves its own loop past 45 s"
           requires inbound traffic to *stop*, which is the opposite of what a
           high-volume row does.
         - It also cannot explain the non-monotonicity (same shape PASS/FAIL/PASS)
           or why 32-byte frames fail where 64-byte frames pass.

         **Correction to my own earlier note:** a previous version of this bullet
         claimed the failures "land at 0.4–4.6 s wall clock". That was wrong —
         those figures are `connectP95Ms`, which is WebSocket *handshake* time
         (`loadgen.ts:234`, `p.connectMs`), not run duration. The loadgen records
         no elapsed-time field at all, so **this run cannot time failure onset**
         and the timing signature was never actually tested. The falsification
         above does not depend on timing. If anyone still wants the timing
         signature, the loadgen needs a duration field added first.
      2. ~~Fix the 64-frame pre-open queue~~ **DONE 2026-07-30** — byte-based
         either-bound (8 MiB / 8192 frames, mirroring the relay side's
         semantics from `ddb0c6d0e`), env-tunable at all three production call
         sites (`WORKSPACE_RUNTIME_RELAY_PRE_OPEN_QUEUE_MAX_FRAMES`/`_MAX_BYTES`);
         positive controls 0/65→65/65 and 0/2000→2000/2000 via
         `bench/local-dialin.ts`. Reframed as a startup-burst bound; expressly
         NOT the cloud cliff fix.
      3. ~~Attach an `error` handler to the host tunnel's main socket~~ **DONE
         2026-07-30** — identity-guarded `onerror` → `cleanupSocket()` →
         single `scheduleReconnect` (error-then-close pinned to ONE reconnect
         by test). A transient relay 500 no longer kills the host process.
      4. Repro the relay 500 on host-tunnel re-registration — **did NOT
         reproduce locally** on either adapter (second tunnel for the same
         hostId gets 101, prior closed 1012). *Correction to the
         `relay_durable_object_boot_failed` lead, 2026-07-30:* that path is
         **not** 500-shaped either. `worker.ts:286` calls `json(...)` with **no
         status argument**, and `json()` defaults to **503** (`worker.ts:73`) —
         so the boot-failure path returns 503, same as everywhere else.
         `grep -n ", 500)\|status: 500" src/*.ts` finds **no explicit 500
         anywhere in the relay**, which means the observed
         `Unexpected server response: 500` was generated by the **Cloudflare
         runtime above our code**, not returned by the worker. That reframes the
         item: it is not a missing error branch to find but a platform-level
         failure (isolate/DO start failure or an internal CF error) — the place
         to look is `wrangler tail` `outcome`/`exceptions` at the moment of the
         500, not the worker source. Corroborating evidence that the 503 path is
         the *reachable* one: booting the relay before its secrets were set
         returned exactly `{"error":{"code":"relay_durable_object_boot_failed",
         "message":"CLAXEDO_RELAY_RESOLVER_URL or CLAXEDO_CENTRAL_URL is
         required"}}` — a real boot failure, surfaced as 503.
         Still worth capturing the body on the next cloud 500.
      5. Repoint the dead snapshot constant; fix the bundle upload.
      6. Re-run from a non-APAC vantage once (1) is understood.

      **Teardown confirmed:** Daytona sandbox destroyed and the account lists
      **0 sandboxes**; all three `-reeval-0730` workers deleted (relay + its
      Durable Object, both resolvers) and the account lists **0** scripts
      matching `reeval-0730`; no `.dev.vars` left. The three 2026-07-17 leftovers
      noted here (`claxedo-workspace-relay-reeval`,
      `claxedo-workspace-relay-h2-reeval`, `claxedo-relay-resolver-reeval`) were
      **deleted in the `W7.1a` run below**; the account now shows 0 `reeval`
      workers of any kind.

- [ ] `W7.1a` **Cliff mechanism identified 2026-07-30 (second cloud run):
      unguarded WebSocket send backpressure in the Cloudflare Durable Object.**
      Evidenced from BOTH sides — client close codes AND `wrangler tail` — against
      the current tree *including* `tunnel-fix`'s `onerror` and byte-based
      pre-open-queue changes (bundle rebuilt from that tree and uploaded via
      `sandbox.fs.uploadFile`; the two fixes were confirmed working first, see
      "presentation" below).

      **The code.** `sendSocket` (`src/cloudflare.ts:1049-1056`) calls
      `socket.send()` in a `try/catch` and returns a boolean. It never reads
      `bufferedAmount`. Both user-hosted directions use it fire-and-forget:
      client→host at `:1676-1682` (every client frame is `JSON.stringify`d onto
      the ONE tunnel socket) and host→client at `:1793-1795`. When a producer
      outruns the socket's drain rate, frames pile into the DO's outbound buffer
      until the runtime destroys the socket — surfacing as `1006 "Connection
      ended"` or, when it is the tunnel socket that dies, `1011 "User-hosted
      tunnel disconnected"` (`:1908-1909`, which takes every channel with it).

      **~~The asymmetry is the proof.~~ RETRACTED 2026-07-30 — the asymmetry was
      never real.** This paragraph claimed the **Bun** relay survives because it
      guards precisely this, at `src/bun.ts:1412` (client channel, 1011 "Client
      WebSocket backpressure limit exceeded") and `:1435` (host tunnel, 1011
      "Host tunnel backpressure limit exceeded") — those are the **pre-fix** line
      numbers; the repaired guards now live at `:1455` and `:1478` — both against
      `WS_BUFFERED_AMOUNT_MAX_BYTES_DEFAULT = 8 MiB`, versus **zero**
      `bufferedAmount` hits in `cloudflare.ts`. The grep was accurate; the
      conclusion drawn from it was not. **Both Bun guards were dead code.** They
      read a `bufferedAmount` *property*; `Bun.ServerWebSocket` exposes
      **`getBufferedAmount()`**, a *method*. The non-null assertion in
      `(socket as { bufferedAmount?: number }).bufferedAmount!` silenced the type
      error, leaving `undefined > 8388608` — permanently false. Measured on a real
      `Bun.ServerWebSocket` with 16.8 MB queued to a non-reading peer (2x the
      limit): guard silent, `guardExpressionFires: false`. Neither close had ever
      executed, so Bun's survival has some other cause and the two adapters were
      never behaving differently *here* at all.

      What still stands from the original paragraph: with the pre-open queue
      masked the Bun relay delivers 2000/2000, and so does the real DO **on local
      workerd** (2000/2000 in 98 ms) — the cliff needs real network drain rates,
      which is why neither local harness had ever caught it. The **mechanism**
      section above is unaffected; only this prior-art argument and the fix shape
      it implied are withdrawn.

      **Measured (cloud, `-reeval-0730b`, one Daytona sandbox, dial-in):**

      | Shape | holders | delivered | codes | verdict |
      |---|---|---|---|---|
      | c1x200 / 400 / 800 / 1600 / 2000 | 1/1 | 100% each | none | PASS |
      | c5x2000 | 5/5 | 10000/10000 | none | PASS |
      | c50x400 | 50/50 | **20000/20000** | none | PASS |
      | c10x800 | 10/10 | 8000/8000 | none | PASS |
      | c10x1200 | 10/10 | 12000/12000 | none | PASS |
      | c10x1600 | 10/10 | 9600/16000 | 1006×4 | FAIL |
      | c10x2000 | 10/10 | 3950/20000 | 1006×2 1011×7 | FAIL |
      | c10x2000 (repeat) | 10/10 | 20000/20000 | none | PASS |
      | c10x2000 **@32-byte frames** | 10/10 | 16000/20000 | 1006×2 | FAIL |

      Four results, each killing a rival hypothesis:
      - **Not total frames.** At 20,000 total, `c50x400` PASSES and `c10x2000`
        FAILS — fan-out across channels is *safer* than depth on few.
      - **Not a per-connection ceiling.** `c1x2000` is clean; one connection never
        failed at any depth. It takes concurrency *and* depth together.
      - **Not bytes.** Halving frame size (64→32 B) did **not** rescue
        `c10x2000` (16000/20000 FAIL) — pressure is queue entries, not payload.
      - **Not a fixed limit at all — a RACE.** Identical shape `c10x1600` three
        times, 25 s apart: **FAIL 9725 → PASS 16000 → FAIL 14400** (of 16,000). No
        deterministic ceiling behaves that way; an unguarded buffer racing the
        drain rate does. That non-monotonicity is why earlier runs read as an
        arbitrary "cliff" and why single-shape sampling misled the 2026-07-17 run.

      **Relay-side evidence (`wrangler tail`, 2,810 events) — kills the CPU
      story.** Outcomes: `ok` 2677, `responseStreamDisconnected` **39**,
      `canceled` 87, `exception` 6, `unknown` 1. **`maxCpuTime` = 13 ms** (max
      wall 28.8 s). Thirteen milliseconds is not DO thread starvation, so "the
      frame path is too slow / the DO is CPU-bound" is dead — the isolate is idle,
      *waiting on I/O*, while its send buffer overflows. The 6 `exception`
      outcomes carry an **empty** `exceptions` array and no logs: the socket is
      destroyed beneath the isolate rather than throwing into it, which is exactly
      why nothing was ever logged and why the previous run could only see client
      close codes.

      **Failure presentation vs `tunnel-fix` (coordination note).** Their fixes
      changed presentation exactly as the lead predicted to watch for, and I
      confirmed both before measuring: `local-dialin --messages 65` went 0/65 →
      **65/65**, and the sandbox agent now **survives** a tunnel drop and
      reconnects (`open` twice, process alive) where it previously died with an
      unhandled `'error'`. Neither changed the cloud numbers. One artifact worth
      knowing: because the agent now recovers instead of dying, a row that drops
      the tunnel can leave the relay briefly refusing upgrades, so the *next* row
      reports `holders 0/N` + "Expected 101 status code" — collateral, not a new
      mechanism (a small row passes immediately after). Rows in the table above
      were re-run with a 20–25 s settle to avoid it.

      **~~The fix shape is the Bun guard ported to `cloudflare.ts`~~ — FIX SHAPE
      FALSIFIED 2026-07-30, and the mechanism REMAINS UNFIXED in the DO.** The
      proposed port (read `bufferedAmount` before `send()` on both user-hosted
      paths, close with a named reason) is **not implementable**, and the blocker
      recorded here — "`WorkspaceRelayDurableObjectSocket` (`cloudflare.ts:277`)
      does not currently expose `bufferedAmount`, so that must be surfaced first"
      — was not a typing gap that adding a field would solve. **The runtime has no
      such value to surface.**

      Measured in real workerd (miniflare 4.20260722.0), full prototype chain
      enumerated: a DO WebSocket's entire surface is `accept`, `send`, `close`,
      `serializeAttachment`, `deserializeAttachment`, the `READY_STATE_*`
      constants, `readyState`, `url`, `protocol`, `extensions`, `binaryType`,
      plus `EventTarget`'s three methods. `"bufferedAmount" in socket` is
      **false**, `typeof socket.bufferedAmount` is **`"undefined"`**, and there is
      no `getBufferedAmount()` either — at compat **2026-03-16 and 2026-07-22**,
      on **both** the `addEventListener` path and the hibernation
      `webSocketMessage` path production actually uses. Queue **~32 MiB** at a
      peer that never reads and the isolate still sees `bufferedAmount`
      `undefined` and `readyState` **1 (OPEN)**: no depth, no drain event, no
      throw. `@cloudflare/workers-types` 4.20251008.0 concurs —
      `grep -c bufferedAmount` is **0** in `latest/`, `experimental/`, and
      `2023-07-01/`; the authoritative `interface WebSocket extends
      EventTarget<WebSocketEventMap>` declares only the members listed above.
      Cloudflare's WebSocket is simply not the browser's.

      So a ported guard would compile, read `undefined`, and — under the
      (correct) fail-open rule for sockets that cannot report — **never fire**. It
      would have shipped as a permanent no-op sitting exactly where this plan says
      the cliff was fixed. That is why it was **not** written.

      **DONE in code (`file:line`), none of it a guard in the DO:**
      - `packages/workspace-relay/src/relay-workerd-backpressure.test.ts` (new,
        8 tests) — real-workerd canary pinning every fact above, plus the
        `workers-types` cross-check and the Bun accessor shape. If Cloudflare ever
        ships the getter, this test **fails** and tells the reader the port has
        become possible. Positive-controlled by shimming a `bufferedAmount` getter
        onto workerd's prototype inside the fixture: 4 of the workerd assertions
        flip to fail (`hasBufferedAmountProperty` false→true, `typeofBufferedAmount`
        `"undefined"`→`"number"`).
      - `packages/workspace-relay/src/bun.ts:216` `relayBufferedBytes()` and
        `:236` `relayOverBackpressureLimit()` — reading **`getBufferedAmount()`**
        with a property fallback for browser-shaped sockets, non-finite treated as
        "cannot report", and **fail-open** documented as load-bearing. Wired at
        `bun.ts:1455` (client channel) and `bun.ts:1478` (host tunnel), replacing
        the dead property reads. Bun's two guards now actually fire; **this does
        not fix production**, which runs the Cloudflare adapter.
      - `packages/workspace-relay/src/bun.test.ts` (+9 tests) — **decision:**
        over-limit closes, at-limit passes (boundary exclusive), fail-open on `{}`
        / missing accessor / `NaN` / `Infinity` / non-numeric,
        method-preferred-over-property so a stale property cannot mask a breach,
        and one driving a **real** `Bun.ServerWebSocket` over the limit.
        **Wiring (end-to-end, real relay + real host tunnel + real client):** a
        saturated client channel closes **1011 "Client WebSocket backpressure
        limit exceeded"** while the tunnel survives; a saturated tunnel closes the
        **client** 1011 "Host tunnel backpressure limit exceeded" (Bun's semantic —
        one noisy client does not kill every channel); and healthy 64 KiB traffic
        at the **real 8 MiB default** relays untouched. Positive control:
        reverting `relayBufferedBytes` to the pre-fix property read fails **5** of
        these (3 decision + both wiring tests) plus the code-shape test — the
        assertions that were missing when the dead guard was written. *Honest
        limitation:* the two wiring tests force the breach with a negative limit,
        because a loopback peer drains faster than a test can outrun it — even at
        a limit of 0 the buffer is back to 0 bytes by the next frame handler
        (measured; that variant timed out). They prove the call site, close code
        and reason on a real socket; the 8 MiB arithmetic is the unit tests' job.

      **Ripple check on the now-live Bun guard (ruling 2), measured not assumed.**
      Nothing local trips it. `bench/local-dialin.ts` — which boots the real Bun
      relay in **user-hosted** mode and so drives **both** newly-live guard sites —
      passes `2000/2000` and `20000/20000`. `bun run bench:gate` (the CI row)
      passes at `c20/load20/m4` with **no close reasons**. The cloud-mode path at
      `c50/load50/m2000` delivers **100000/100000**, also with no close reasons;
      that row does report a gate FAIL, but on the **WS p99 latency gate at an
      extreme non-default shape**, and it fails **identically with the guard
      reverted to its dead form** (100000/100000, same breach) — so it is
      pre-existing and unrelated. The 8 MiB default was not touched.

      **Still open — the actual mechanism.** No pre-send guard of any kind is
      writable in `cloudflare.ts` while workerd reports no buffer depth, no send
      completion, and no drain signal for WebSocket frames. Bounding it needs a
      **protocol-level credit/ack window** on the tunnel, now scoped as a named
      relay-wave item under **Non-goals** (with its cross-package surface and its
      repeated-cloud-run validation rule) and deliberately **not built here**. The
      guessed per-channel in-flight budget was **rejected** there too, with
      reasons, so it is not re-proposed.

      Severity framing unchanged: a real interactive session is nothing like
      1,600 unacknowledged frames across ten channels, so this is a load-shape
      hazard rather than a live-user outage — but it is why the RUNBOOK zero-loss
      gate cannot pass, and that gate stays red.

      **Cloud verification still required and NOT done — and it must be REPEATED
      runs, never one row.** Only real network drain rates produce the failure
      (local workerd delivers 2000/2000 in 98 ms), and the failure is a **race**:
      identical `c10x1600` gave **FAIL / PASS / FAIL** 25 s apart. A single green
      `c10x2000` therefore proves **nothing** — it is one sample of a
      non-deterministic outcome, and it is exactly how the 2026-07-17 run was
      misled into reading an arbitrary "cliff". The standard for this mechanism is
      **3-5× the same shape, all green**. Note also what such a run can and cannot
      show today: **nothing landed that changes the DO's send path**, so a re-run
      is a baseline re-measurement of a still-open mechanism, **not** a fix
      verification. The first cloud rows worth gating on are the credit/ack
      window's (see Non-goals), under the same repeated-shape rule.

      **Suite state at this change:** `bun test src bench` **408 pass / 0 fail**
      (391 baseline + 8 workerd canary + 9 Bun guard), `typecheck` and
      `typecheck:bench` both clean, `relay-config-drift` 6/6.

      **Vantage caveat unchanged:** Jaipur, India (APAC) against an `apac`-hinted
      relay. The non-APAC row stays open.

      **Teardown:** Daytona destroyed (account shows **0** sandboxes);
      `-reeval-0730b` relay + resolver deleted **plus the three 2026-07-17
      leftovers**. Account shows **0** workers matching `reeval`; only
      `claxedo-workspace-relay-staging` remains. No `.dev.vars`. The scratch
      workerd dial-in harness written for this investigation was deleted.
- [x] `W7.2` **DONE 2026-07-30** — credential-free half wired and enforced.
      `.github/workflows/relay-bench-gate.yml` (modeled on `workgraph-stress.yml`)
      runs three steps on any `packages/workspace-relay/**` change: bench
      typecheck, unit tests, then the gate. New scripts in the relay
      package.json, appended: `bench:gate` (→ `local-dry-run.ts`, the
      credential-free row), `bench:gate:cf` (→ `cf-dev-smoke.ts`, miniflare, for
      local use), `typecheck:bench`; `test` widened `bun test src` →
      `bun test src bench`, which adds exactly one file and 8 tests —
      `bench/lib/stats.test.ts`, the gate-evaluation logic CI had never executed.

      **Enforcement was already there.** `local-dry-run.ts:132-137` exits 1 on a
      gate breach and 2 on a harness error; nothing swallowed it, so only the
      wiring was missing. No build step is needed — the gate runs
      `bun src/main.ts` directly, so there is no `dist` to stale out.

      **Runner-variance budget, measured not assumed.** Six local runs at the
      default `c20/load20` shape (2026-07-17 + 2026-07-30): HTTP p99 overhead
      7.58–9.96 ms (~10x under the 100 ms gate), WS-message p99 1.73–2.18 ms
      (~46x). WS keeps the strict RUNBOOK gate. HTTP's 10x is inside the "within
      ~5x of runner noise" band once a shared runner adds tens of ms to a request
      percentile, so the **CI copy only** raises HTTP to 250 ms — still ~25x the
      local worst case, so a real 10x regression still fails. Per-gate override
      on purpose: one shared knob would have relaxed the 46x gate to accommodate
      the 10x one.

      `bench/lib/stats.ts` gained `CLAXEDO_BENCH_{HTTP,WS}_P99_GATE_MS`, both
      **defaulting to the RUNBOOK 100 ms** — the RUNBOOK gates are untouched and
      a local `bun run bench:gate` is unaffected. A malformed or non-positive
      override falls back to the strict default (`=0` cannot disable a gate), and
      **loss gates have no override at all**, since "zero" does not degrade with
      runner noise. Four new tests in `stats.test.ts` pin exactly that.

      **Caveat recorded:** `bench/` had never been typechecked and had drifted —
      `setup-separate.ts` has 12 errors (implicit `any` + Daytona SDK signature
      drift) in a densely-written, credential-requiring cloud provisioning script
      run by hand from the RUNBOOK. It is `exclude`d in `bench/tsconfig.json`
      with the reason inline; every file on the gate path (`local-dry-run.ts`,
      `loadgen.ts`, `cf-dev-smoke.ts`, `local-dialin.ts`, all of `lib/`) IS
      checked. Deleting that exclude line is the follow-up.

      **Positive controls** (all run locally, exit codes captured unpiped):

      | Control | Result |
      |---|---|
      | Breach the gate (`CLAXEDO_BENCH_HTTP_P99_GATE_MS=1`) | `EXIT_CODE=1`, verdict `FAIL`, `GATE FAIL: metric set produced but a gate did not pass` |
      | The real CI config (`=250`) | `EXIT_CODE=0`, verdict `PASS`, HTTP 8.07 ms / WS 2.16 ms, 80/80 relayed |
      | HTTP override must not mask a WS breach (`HTTP=250 WS=1`) | `EXIT_CODE=1` — the raised HTTP gate does not rescue a WS failure |

      Note the shape label is ambiguous and a reader will be misled by it:
      `c20/load20` appears on both the 80-message default row (~2 ms WS) and on
      40,000-message runs (66–81 ms WS, i.e. inside the 100 ms gate). The CI job
      runs the default shape. Report artifacts are uploaded with `if: always()`
      because `bench/reports/` is gitignored and a FAILING run is the one whose
      numbers matter.
- [x] `W7.3` Run the W5.4 vision-verified two-browser live-sync drill on the CF
      composition. It has never been run. B3's fix is unit-tested only.

      **RUN 2026-07-30 — 8/8 PASS, with video.** Harness:
      `packages/claxedo-server/scripts/drill/live-sync-two-browser.ts` (+ the
      viewer page beside it). Repro:
      `cd packages/claxedo-server && node --import tsx scripts/drill/live-sync-two-browser.ts`
      (add `--headed` to watch). Artifacts land in
      `packages/claxedo-server/.artifacts/drill/live-sync-two-browser/`
      (gitignored): one `.webm` per browser plus `verdicts.json`.

      **Ran at "level 1.5": the real hosted events ROUTE, not just the DO.** Two
      real Chromium browsers over real HTTP against workerd/miniflare serving the
      real `LiveSyncRoom` Durable Object **and** the real
      `HostedShellRoutes` at the real `/api/wr/events`. That matters more than
      the DO alone: the route is what resolves the authority-internal org id at
      connect and hands it to the room, which is the namespace half of `B3`
      (problem 1) — the existing workerd test calls `connectLiveSyncRoom`
      directly and skips it. Publishers go through
      `liveSyncRoomNameForPrincipal`, the same single derivation `hosted-app.ts`
      uses for the documents sink and the WorkGraph nudge. The viewer replicates
      `claxedo-app/src/app/integrations/claxedo-events.tsx`'s fetch + manual
      reader loop and its `Last-Event-ID` handling line for line — deliberately
      NOT `EventSource`, which cannot attach `Authorization` and would only ever
      exercise the 401 branch.

      **Why not the full app UI.** `createHostedApp` cannot boot without real
      Clerk + real Convex, behind three independent fail-closed gates
      (`hosted-app.ts:216-238`, `hosted-services.ts:364-374`,
      `deployment-mode.ts:236-247` — the last 503s *every* request when hosted
      mode sees auth disabled). No env var relaxes any of them. Clerk/Convex are
      therefore replaced via the injection points the route already exposes
      (`HostedShellRouteOptions.verifier` / `.resolveOrgId`, the
      `customVerifierAuthAdapter` seam) — the bearer token is the subject, as in
      `hosted-app.test.ts`'s `fakePlane`. Going further would also require a
      Convex-backed documents backend and WorkGraph store just to have something
      to publish *from*, plus pinned-port CORS and a dedicated vite, at which
      point most of "the CF composition" is doubles.

      | Scenario | Verdict |
      |---|---|
      | live delivery — B receives A's `document.changed`, zero interaction | PASS |
      | `id:` line advances the client cursor | PASS |
      | subject-scoped visibility — `workgraph.changed` reaches only its owner, though both share the org room | PASS |
      | reconnect replay — nudge published while B is disconnected is recovered from `Last-Event-ID` | PASS |
      | replay-gap — evicted cursor yields an explicit `stream.replay-gap`, not a silent hole | PASS |
      | positive control — wrong-room publish reaches nobody | PASS |

      **Positive controls, both run.** (1) The publisher rings another org's room:
      B receives nothing for 10 s, the nudge reports `held=0 delivered=0`, and
      the very next correct-room publish arrives — so the silence is the wrong
      room, not a dead harness. This reproduces the `B3` problem-1 failure mode
      on demand. (2) Stronger: B3's actual fix was reverted in source
      (`live-sync-room.ts:773`, dropping `envelope.id` from the bridge `write`)
      and the drill went **8/8 → 4/8**, failing live-delivery, cursor-advance,
      reconnect-replay, and replay-gap. Source restored byte-identical
      (shasum-verified).

      **One assertion was too weak and is now fixed** — worth knowing, because it
      is the exact false-positive shape the plan's quality bar warns about. The
      reconnect-replay check originally only asserted "the missed frame arrived",
      which **passed even with the fix reverted**: a cursor-less resume replays
      the whole ring, which happens to include the missed frame. It now also
      asserts nothing redundant arrived (`doc_live` still seen exactly once), so
      it distinguishes cursor-driven resume from full-ring replay. That is what
      makes it fail on reverted code.

      **Finding: the sequence resets on DO hibernation, and a HELD connection
      gets no gap notice.** Observed in the video (B's `Last-Event-ID` went
      *backwards* 3 → 1), then isolated in
      `scripts/drill/live-sync-eviction-probe.ts`: after ~12 s idle the ring
      resets and a held subscriber's next frame is `id: 1` again, silently.
      `live-sync-room.ts:432-433` claims this "is not silent: `cursorAhead` turns
      a cursor from a lost sequence into the gap notice" — but `cursorAhead` is
      only reached from `replayFrames`, i.e. on **connect**, so a connection held
      across the reset never passes that check. **It does still fail safe**, which
      `scripts/drill/live-sync-post-reset-resume-probe.ts` measures rather than
      argues: a client re-synced onto the new sequence then dropped gets its
      missed frame REPLAYED, and a client reconnecting with a cursor from the
      lost sequence gets the gap notice. So this is a comment accuracy defect
      plus a cosmetic cursor regression, not data loss — no chip filed against
      `B3`, but the comment's claim should be narrowed to "on reconnect".

      **What remains for a full-app version:** nothing in the transport is
      unproven, but the app-shell projection is not in this loop — what
      `document-index.tsx:365` and `sync-lifecycle.ts:134` *do* with a delivered
      nudge is covered only by app-level tests. Note if that is ever built:
      WorkGraph has a ~30 s poll fallback (`sync-lifecycle.ts:163`) that makes
      rows refresh even with the doorbell fully broken, so a WorkGraph-based UI
      assertion must be time-boxed under the poll interval or it proves nothing.
      The Documents index has no such fallback and is the sound target.
- [ ] `W7.4` Re-measure the ceilings and update the review's scale claim with
      **measured** numbers.

**Acceptance:** benches pass their existing gates (p99 overhead < 100 ms, zero WS
loss) from a non-APAC region, in CI. The two-browser drill passes with video
evidence.

---

## Inherited quality bars

Carried from the repo's standing rules and the review's own method.

- **No false-positive verification.** Green tests are claims, not proof. Every
  workstream names a positive control: a test that must be shown FAILING against
  current code before the fix, so the test is proven to have teeth. `W1` and
  `W5.6` state this explicitly; apply it everywhere.
- **No duct tape.** Read provider docs and in-repo issues before guessing at API
  behavior. This plan exists partly because the review asserted Daytona billed
  forever without checking that auto-stop defaults to 15 minutes.
- **Additive and strangler-shaped.** `N=1` sharding must be byte-identical to
  today. Default-on middleware must not change behavior for routes that already
  limit correctly.
- **Make illegal states unrepresentable.** Prefer a type or a config guard over a
  convention. `lifecycleMinutes`' one-minute floor is the model: Daytona reads 0
  as "delete immediately," so the code makes 0 unreachable rather than
  documenting it.
- **Drift guards over vigilance.** Three config bugs in this review
  (`B2` cron, `A6` channel cap, `A6` location hint) were all "a value nobody
  noticed was missing." Each fix ships a test that parses the config and asserts
  the invariant. `W5.6` extends the pattern to Convex reads.
- **Cite file:line and verify before asserting.** Line numbers in the source
  review had already drifted by two days.

## Definition of Done

- [x] Sandbox GC can enumerate provider state on every hosted driver, and a
      listing-incapable driver fails **loudly** rather than reporting success.
      Progress: **DONE in code 2026-07-30.** Daytona enumerates via the SDK
      (`W1.1`); Cloudflare via a new sandbox-Worker R2 registry + `GET /sandboxes`
      (`W1.2`). Both loud paths are asserted: a driver that cannot list (or a
      Worker predating the registry) yields `listingUnsupported: true`, a 501 GC
      route, and a cron warning — never four empty arrays behind a 200. The local
      `workspace-supervisor` manager reports it too, since it has no provider to
      enumerate. **Gated on an operator step:** the Cloudflare half needs a Worker
      redeploy plus a manually created `BACKUP_BUCKET`, and that Worker code has
      not yet run on workerd.
- [x] A sandbox with no lease is destroyed by GC, proven by a positive control
      that first fails against pre-fix code. Progress: **DONE 2026-07-30** —
      real Daytona driver + real manager; pre-fix failure
      `expected [] to deeply equal [ 'sb_orphan' ]`. A companion control proves
      a live lease's sandbox SURVIVES the same sweep, so the test cannot be
      passed by a reaper that simply destroys everything.
- [x] The dead idle policy is wired or deleted — not left dormant. Progress:
      **DELETED 2026-07-30** — `decideSandboxIdle` removed with its test after
      grep-confirming zero production callers; rationale in `lease-policy.ts`.
      `convex/sandboxLeases.ts:592`'s `listNeedingDriverReconciliation` is the
      same shape and still dormant — flagged for the `convex-index` (`W5`) owner.
- [x] The live-sync connection ceiling is a **measured** number, not an asserted
      one: a 1,000-connection org connects fully, via a raised measured cap or
      (only if measurement fails) sharding with the four named hazards tested.
      The cap has test coverage on both counters. Progress: **DONE 2026-07-30.**
      Measured under workerd: 100% connect success up to 16,000 connections on
      one DO (harness-transport-bounded floor, not the room's ceiling), fan-out
      p99 23 ms at 1,000 / 417 ms at 16,000. Cap raised 256 → 2,000 (one shared
      constant, both counters through `this.size`; env override clamped 16k).
      Sharding NOT built — measurement passed ~40× over criterion. Bonus defect
      fixed: WS and SSE previously held two independent 256 budgets. 6 new cap
      tests incl. real-workerd; measurement recorded under A4 in the review doc.
- [x] Live-sync room names remain derived through the single helper path; no
      caller hand-composes a room name. Progress: **HOLDS 2026-07-30** — no
      shard suffix was introduced, so the derivation is unchanged; the
      `owner:local` short-circuit stands as the documented local-mode name.
- [x] The rate limit is enforced **globally**, verified from two simulated
      isolates. Progress: **DONE 2026-07-30** — Cloudflare `[[ratelimits]]`
      binding (first-class wrangler 4.114 key; period constrained to 10/60 s),
      mirrored prod + staging with a config drift test; in-memory fixed-window
      kept as the local first-layer fuse; Node self-host degrades to the fuse.
      Two-instance shared-store test shows the global limit, not 2×.
- [x] Every mounted route inherits a body cap unless explicitly exempted,
      asserted by a test that fails when a new route skips it. Progress:
      **DONE 2026-07-30** — default guard middleware at the hosted-app seam
      (after auth-posture, before mounts); `route-guard-inventory.test.ts`
      fails on any new route without a cap or named exemption; documents'
      hand-rolled 2 MiB cap exempted by name; Polar webhook body capped before
      buffering + IP-keyed limiter.
- [x] A duplicate register/checkpoint across two isolates executes once.
      Progress: **DONE 2026-07-30** — durable idempotency in Convex
      (`convex/idempotency.ts`, leased in-flight claims + completed receipts,
      TTL'd), in-memory map demoted to per-isolate fast path; two-isolate test
      proves single execution; dead-holder takeover after lease expiry; the
      latent unsweepable-in-flight-entry bug fixed in passing.
- [x] Two concurrent `scheduled()` invocations run the reconcile body once.
      Progress: **DONE 2026-07-30** — fenced Convex cron lease
      (`convex/cronLease.ts`: TTL + monotonic fence + heartbeat + takeover;
      motivating hang documented in the header), covering both formerly
      per-isolate guards (`reconcile-serialize`, `hosted-workgraph-admin`).
- [x] No unbounded `.collect()` on a hot path; a guard test fails on new ones.
      Progress: **DONE 2026-07-30** — all 14 sites converted or bounded,
      allowlist ships EMPTY; `convex-unbounded-read-guard.test.ts` parses
      source (`.filter()` chains included) with declaration-anchored allowlist
      entries requiring written reasons. Measured: behavior tests alone cannot
      catch a scan revert; the guard is the durable half. Bonus: destroy-input
      reads THROW on overflow rather than truncate (a silent `.take(1000)` on
      GC's lease-truth input would have destroyed live sandboxes).
- [x] Org switch and workspace create no longer scan a whole table. Progress:
      **DONE 2026-07-30** — `setActive`/`grantedOrg` via `by_clerk_org_id`;
      `countActiveForOrg` via two new status-scoped indexes with `_id` dedup
      (overlapping org/owner scopes); five membership-authz sites through one
      indexed `orgMembership()` helper with `.unique()`.
- [x] `socketFrame`/`socketPayload` handle `Blob`, proven by a **real workerd**
      binary round-trip test, before any `compatibility_date` bump. Progress:
      **DONE 2026-07-30** — both handle Blob + DataView symmetrically;
      miniflare 4.20260722.0 added; real-workerd round-trip proves pre-fix
      decoders drop frames at compat 2026-03-17 and post-fix do not. No date
      bump. Correction recorded: the binaryType flip is per-delivery-path —
      real exposure was cloud client/upstream sockets, not the hibernating
      user-hosted path; wrangler-h2.toml brought under the drift guard.
- [x] Resolver-down, token-expiry, stalled-client, and DO-restart each have an
      asserted client experience — no silent hangs or drops. Progress:
      **DONE 2026-07-30** — resolver-unreachable now serves stale cache and
      closes only after sustained failure (explicit revoked/inactive still
      fail closed); host→client send results checked with 1013 closes (5
      sites); frame handlers wrapped (log + close, no unhandled DO rejection);
      hibernation rebuild errors out discarded pendings — probe disproved the
      "never settles" prediction (guarded once-per-isolate rebuild → 503), and
      the invariant is now enforced rather than accidental.
- [x] A removed Clerk member loses access within one reconciliation cycle, with
      an audit event. Progress: **DONE in code 2026-07-30** —
      `convex/clerkReconcile.ts` daily cursor-paged sweep (429-aware, per-org
      completeness before any delete — no partial-diff deletions), audit events
      on webhook deletes AND sweep corrections, tombstones block delayed
      `.created` resurrection (with reaper cron), `flagStaleClerkWebhooks`
      liveness lane. 41 policy tests. **Operator step:** set the Clerk secret
      env var on the Convex deployment.
- [x] Listing a 1,000-doc project is O(1) R2 operations; a >10k-object project
      paginates instead of throwing. Progress: **DONE 2026-07-30** — verified
      per-project roll-up object (ETag-checked, self-healing rebuild, orphan
      cleanup on the natural path): 1,000-doc listing 2,001 ops → 2;
      `findRepository` 403 → 4; write path 3 LISTs + ~159 serial GETs → 1 LIST
      + 57 concurrent; >10k returns truncated=true + cursor. Byte-exact
      round-trip gate untouched and green.
- [x] `bytesToBase64` is chunked, proven byte-identical to the per-byte version
      across empty / 1-byte / 32k-boundary / >1 MiB payloads. Progress:
      **DONE 2026-07-30** — byte-equality + mutation-verified controls;
      measured 2.0–3.7× (the 10–50× claim corrected — engines rope-optimize).
- [x] Revocation is enforced under hibernation: a revoked token on an idle
      hibernated connection is closed within the alarm interval, proven by a
      test; the per-frame cached check is retained. Progress: **DONE
      2026-07-30** — alarm-based sweep (alarms survive hibernation; timers
      don't) multiplexed with existing alarm use; per-frame checks kept.
- [x] A workspace's DO location hint is derived from its region rather than one
      deployment-wide constant. Progress: **DONE 2026-07-30** — relay derives
      the hint from `?region=` at DO create; the runtime tunnel composer sends
      it; cloud workspaces use the LEASE's `homeRegion` (placement is
      permanent — config-derived would be an unfixable mis-placement), local
      uses the configured default. Both skew directions asserted in an
      executable seam test (old relay ignores the param; old runtime omits it).
- [~] Relay benches pass their own gates from a non-APAC region, in CI —
      including a cloud `c50` run that resolves whether `dialin-100k-msgs` was
      the 16-channel cap. Progress: **CI half DONE 2026-07-30** —
      `relay-bench-gate.yml` runs typecheck + unit tests + the credential-free
      gate with per-gate headroom-derived CI overrides (WS strict at 46×
      headroom; HTTP 250 ms CI-only at 10×) and a control proving one
      loosening cannot mask the other gate. **Cloud half remains
      owner-triggered** (Daytona + CF creds). New local data point: `m2000`
      pipelining alone breaches the WS gate (109.66 ms at zero loss) — the
      100k cliff is plausibly cap × pipelining compounded.
- [x] The two-browser live-sync drill passes with video evidence. Progress:
      **DONE 2026-07-30, 8/8 PASS** — two real Playwright browsers against the
      REAL hosted events route (`HostedShellRoutes` with injected verifier)
      over the real LiveSyncRoom DO under miniflare, so connect-time
      `resolveOrgId` namespace resolution (B3 problem 1) is in the loop. Live
      delivery with zero interaction, `id:` cursor advance, subject-scoped
      visibility, reconnect replay, explicit replay-gap, wrong-room control —
      all with video (`.artifacts/drill/live-sync-two-browser/`). Teeth proven
      by source revert: dropping B3's `envelope.id` fix takes the drill 8/8 →
      4/8. One assertion was itself caught as a false positive and tightened
      (cursor-less resume replays the whole ring, so "missed frame arrived"
      passes on broken code — replay tests must also assert nothing redundant
      arrived). Repro: `node --import tsx
      scripts/drill/live-sync-two-browser.ts` in claxedo-server. Full-app UI
      variant remains blocked on real Clerk+Convex (three fail-closed gates);
      if built later, assert on the documents index, NOT WorkGraph — its ~30 s
      poll fallback refreshes rows even with the doorbell dead. Side finding:
      the sequence-reset comment at `live-sync-room.ts:432` overstates scope
      (gap notice only on reconnect, not held connections) — measured fail-safe
      both paths, comment should say "on reconnect".
- [~] The review doc's scale claim is restated with **measured** numbers.
      Progress: A4 restated with the 16k/2,000 measurement (2026-07-30);
      full restatement gated on the drill + the owner-triggered cloud bench.

## Execution: parallelize with agents and workflows

The workstreams were scoped for disjoint file ownership. Run them concurrently.

**Parallel from the start — no shared files:**

| Agent | Owns | Files |
|---|---|---|
| `sandbox-gc` | `W1` | `packages/sandbox-manager/src/drivers/*`, `packages/sandbox-manager/src/index.ts` |
| `livesync-shard` | `W2` | `packages/claxedo-server/src/live-sync-room.ts` + the 3 named call sites |
| `rate-limit` | `W3` | `control-plane/rate-limit.ts`, `hosted-app.ts` middleware block, `billing-routes.ts` |
| `convex-index` | `W5` | `convex/*.ts`, `convex/schema.ts` |
| `relay-blob` | `W6.1`+`W6.2` | `packages/workspace-relay/src/cloudflare.ts` |
| `relay-frame` | `W6b` | same file — **sequence with `relay-blob`, do not run concurrently** |

**Contention to manage:** `W3` and `W4.4` both touch `hosted-app.ts`; sequence
them or split by line range. `W2` and `W3` both touch `hosted-app.ts` route
mounting — `W2` only at the two publish sites (`:321`, `:527`), `W3` only at the
middleware block (`:364`). Assign explicitly.

`W6.1` (Blob) and `W6b.1` (chunked base64) touch **adjacent functions** —
`socketFrame`/`socketPayload` at `cloudflare.ts:382-410` call `bytesToBase64` at
`:372-376`. Give both to one agent, or land the base64 change first: it is a
pure drop-in with a byte-equality test, so it is the safer of the two to merge
first and rebase the Blob work onto.

**Pipeline, do not barrier.** Each workstream's verify stage should start as soon
as *that* workstream's implementation lands, not after all of them. Only `W7`
is a genuine barrier — it measures the composed system.

**Parallelize research and adversarial verification.** For each finding, run
independent verifiers with distinct lenses (does it reproduce / is the test a
real positive control / does it regress the `N=1` path) rather than one reviewer
reading everything. Findings that survive an adversarial pass are the ones worth
shipping.

**Suggested wave order:**

1. **Wave 1 (parallel):** `W1`, `W2`, `W3`, `W5` — four agents, disjoint trees.
2. **Wave 2 (parallel):** `W4`, `W6` — after Wave 1 settles `hosted-app.ts`.
3. **Wave 3 (barrier):** `W7` — benches and the two-browser drill against the
   composed result.
