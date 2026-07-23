# Claxedo Deployment Feasibility Report — FINAL (verification-corrected)

**Prepared for:** Claxedo owner
**Positioning under evaluation:** "a team self-hosts Claxedo on their own stack"
**Hard requirements:** full org/tenant isolation; whole-team usability (accounts, roles, invites)

> **Critical framing #1 — the two storage layers, corrected & scoped.** "DB" is actually **two** storage layers with different adapter coverage. (1) the **WorkspaceAuthority store** (orgs/projects/workspaces/roles/sessions) has `{sqlite, convex, worker}` adapters; (2) the **central store** has two ports — the **live per-run projection store** (`projectionStore`) and the **durable event log** (`durableSessionLog`) — and *those two ports* are **SQLite-only**: `createSqliteCentralStore` is the only composed impl (`server.ts:677`, `hosted-node.ts:15,27`), and on CF Worker both are a `unusedStore` proxy that **throws** (`hosted-services.ts:181,270-271`). **Correction (verify:storage):** this does **not** mean a non-SQLite deployment "can't replay a session." Convex carries **session message history/replay** — `session_history`/`session_messages` tables (`convex/schema.ts:225,240`), `readMessages` (`convex/sessions.ts:374`) and `syncMessages`/`syncMessagesForService` (`:419,:437`), wired through the authority adapter `readSessionMessages` (`convex-authority-sessions.ts:49-58`), reachable even on the Worker whose live projection/durable-log ports throw. **Correct scoped claim:** *live per-run projection + durable event log = SQLite-only; session message history/replay = also available via Convex.*

> **Critical framing #2 — teams come from identity supply, and only Convex mints them.** Org/role **enforcement machinery exists** on the SQLite authority store and is *intended* to mirror Convex, and — **correction (verify:storage/platform-scale)** — the Convex side is now **verifiable from source** (`convex/model.ts:52` `combineRolePrecedence`), because the full Convex backend lives at **repo-root `convex/`**, not `packages/claxedo-server/convex/` (which holds only `_generated`). The real gap for teams is **identity supply, not enforcement**. **Correction (verify:auth-org):** shared multi-member orgs materialize **only on the Convex path** — the Clerk-org webhook mirror seeds `orgs`/`org_memberships` in Convex (`convex/orgs.ts:173-249` `applyClerkWebhook`/`upsertClerkMembership`; `convex/orgs.ts:269` `membershipByClerkIds`; `clerk_org_id` stamped at `convex-authority-identity.ts:30`, org share grants at `convex-authority-workspaces.ts:233,248`). The **SQLite** authority store can *never* produce a shared org: its only `orgs`/`org_memberships` inserts are inside `ensurePersonalOrg`, hardcoding `kind='personal'` with `clerk_org_id` NULL (`workspace-authority-store.ts:314,318`), and `resolveOrgId`'s Clerk lookup itself requires a pre-existing membership row (`workspace-authority.ts:380-386`) so it always misses and falls back to personal (`:388`). The only shipped self-host auth (embedded Better Auth) emits no org claim and has no invite path.

---

## 1. Deployment Matrix

Legend: **VIABLE-TODAY** = builds/boots and meets hard requirements with existing code · **VIABLE-WITH-WORK** = architecture supports it, concrete code missing · **INVALID** = structurally impossible without a rewrite.

### (A) Cloudflare Workers control plane

| Auth | Store | Verdict | Reason |
|---|---|---|---|
| Clerk | Convex | **VIABLE-WITH-WORK** | Only sane CF combo. Clerk verifier is Worker-safe (`verifyClerkBearer`→`createClerkTokenVerifier`, jose/WebCrypto); store = Convex via `composeWorkerAuthority`→`createConvexAuthority` (`hosted-compose.ts:97-103`); orgs/roles ride Clerk `org_id`. Teams verifiable in source (Convex webhook mirror). **But** not a shipped deploy path (`deploy.ts` throws on non-Fly, `:261`; CF disabled with the engine/session reason, `:59-71`). **Correction (verify:platform-scale):** this is **not** merely "control-plane only" — the Worker composes a sandbox execution substrate (below). What is capped is the *in-process central session runtime* (live projection/durable log), not agent execution. |
| Clerk | D1 | **INVALID (today)** | No D1 adapter exists (`adapters/` = `{sqlite,convex,worker}`; the `worker` adapter is not a store — it just composes `createConvexAuthority`). Net-new authority adapter + no D1 central store. **Correction (verify:storage):** the specific "10 GB cap / ~50 writes/s" figures were unsourced external numbers (and dated); dropped. The verdict stands on *no adapter*, not throughput. |
| Clerk | Durable Objects (as primary store) | **INVALID** | DOs are coordination actors (`LiveSyncRoom`, `WakeLane`, `WorkGraphSettler` — `worker.ts:52-71`), not an authority/session/tenant store. No cross-DO joins for admin/global queries. |
| Better Auth (embedded) | Convex / D1 / anything | **INVALID** | Embedded Better Auth is `better-sqlite3` + file DB (native module) — the exact thing `worker.ts:6-8` excludes. Cannot run on a Worker. A Worker-safe Better Auth is pluggable behind the auth port (`auth.ts:208-254`) but **unbuilt**. |

**CF net:** one real-ish path — **Clerk + Convex + DOs**. **Corrected:** the agent engine never runs in the Worker *isolate* (no PTYs/fs/seconds-of-CPU), but the Worker **provisions execution** via sandbox drivers for **Cloudflare Sandboxes and Daytona** (`hosted-services.ts:78-124`, auto-selected `:168-176`, wired via `composeWorkerSandboxManager`, `hosted-compose.ts:71-94`), with live sessions proxied to the workspace-runtime through the relay (`hosted-app.ts:566-584`). The designed execution host is a **sandbox container the Worker provisions**, not necessarily a separate Node/Fly box. What remains disabled on-Worker is the in-process central *session runtime* (SQLite projection/durable log used on the Node hosted path).

### (B) Node server

**Single-instance:**

| Auth | Store (authority) | Verdict | Reason |
|---|---|---|---|
| Better Auth (embedded) | SQLite | **VIABLE-TODAY** *(single-user / no teams)* | Fully built + shipped by `claxedo deploy` (Fly). `bearer()` only, no org plugin (`embedded-auth.ts:108`), emits no orgId (`embedded-auth.ts:130-135`) → every user gets an isolated personal org. |
| Clerk | SQLite | **VIABLE-TODAY** *(single-user / no teams)* — **DOWNGRADED** | **Correction (verify:auth-org):** previously rated "meets team requirement." It does **not**. On the SQLite authority store the only `orgs`/`org_memberships` inserts are `ensurePersonalOrg` (`workspace-authority-store.ts:314,318`, `kind='personal'`, `clerk_org_id` NULL); `resolveOrgId`'s Clerk join requires a pre-existing membership and always falls back to personal (`workspace-authority.ts:380-388`). Net: every Clerk user lands in their *own* personal org — identical to embedded auth, **no shared teams**. Boots and runs; fails the team requirement. |
| Clerk | Convex (authority) | **VIABLE-TODAY** *(meets team requirement)* — **UPGRADED** | **Correction:** this — not Clerk+SQLite — is the **real multi-member-teams path today**. Clerk supplies `org_id`; the Convex org webhook mirror seeds `orgs`/`org_memberships` (`convex/orgs.ts:173-249,269`; `clerk_org_id` at `convex-authority-identity.ts:30`). Requires standing up Convex + wiring Clerk org webhooks → Convex. Central *projection/durable-log* still SQLite locally; session message replay available via Convex. |
| Better Auth (embedded) | Convex | **VIABLE-WITH-WORK** | Boots, but embedded auth emits no orgId, so Convex authority only ever sees personal orgs → same team gap. |
| any | Postgres | **INVALID** | No Postgres adapter; every schema is `sqliteTable` (`drizzle-orm/sqlite-core`), no `pg-core`. Full schema rewrite + adapter build. |

**Multi-instance (horizontal scale):**

| Auth | Store | Verdict | Reason |
|---|---|---|---|
| Clerk | Convex (authority) | **VIABLE-WITH-WORK (heavy)** | Convex authority is multi-writer, but the Node-cluster coordination layer is **PLANNED, not built** (plan `2026-07-18-001`, W6). **Correction:** it is **not** blocked on "absent Convex functions" — those are present at repo-root `convex/`. Blockers are Node-side (below). |
| Better Auth (embedded) | Convex | **VIABLE-WITH-WORK (heavy)** | Same Node-side coordination gaps **plus** the team-orgs gap (no shared orgs from embedded auth). |
| any | SQLite | **INVALID** | File DB, single writer process — cannot span instances (Litestream = read replicas only). |
| any | Postgres | **INVALID** | No adapter (as above). |

---

## 2. Per-VIABLE combination detail

### V1 — Node single-instance + **Clerk** + **Convex (authority)**  ★ meets hard requirements today  *(reassigned flagship-teams path)*
- **Pros:** The single-instance combo that actually delivers shared multi-member orgs/roles today — Clerk org membership mirrored into Convex (`convex/orgs.ts:173-249`), honored via `clerk_org_id` (`convex-authority-identity.ts:30`; `workspace-authority.ts:384`). Adapter-symmetric role enforcement is now verifiable on **both** sides (SQLite `workspace-authority-store.ts:391-392`; Convex `convex/model.ts:52`).
- **Cons:** Two external dependencies — **Clerk (SaaS) + a running Convex deployment** (managed or self-hosted OSS) — which **contradicts "self-host on your own stack."** Convex is not bundled; Clerk org webhooks must be wired into Convex. Per-MAU/per-MAO Clerk pricing. Self-hosted Convex is single-node by default (SPOF).
- **EXISTS:** `clerkAuthAdapter`/`verifyClerkBearer` (`auth.ts:196-206,306-324`); Convex authority + org webhook mirror + `membershipByClerkIds` (`convex/orgs.ts:173-249,269`); role precedence both adapters (`convex/model.ts:52`, `workspace-authority-store.ts:392`).
- **BREAKS / MISSING:** `claxedo deploy` never wires Clerk env (`deploy.ts:344-351` warns "runs WITHOUT authentication") and is Fly-only. No first-party invite/accept flow — `convex/billing.ts:343` explicitly marks it a **future** item. No self-host org-claim re-verification of the connections team-partition (see §3, corrected).
- **Effort:** **M** — stand up Convex + wire Clerk org webhooks; **S** to add the auth-choice + Clerk-secret staging into deploy.

### V1b — Node single-instance + **Clerk** + SQLite  *(demoted: single-user only)*
- **Correction:** previously the flagship "meets teams today." **It does not** — SQLite authority mints only personal orgs (`workspace-authority-store.ts:314,318`; `workspace-authority.ts:388`). Use only as a single-user deployment. To make it team-capable you must move authority to Convex (V1) or build the embedded org layer (V2).

### V2 — Node single-instance + **Better Auth (embedded)** + SQLite  ★ shipped, but single-user
- **Pros:** True self-host, zero external deps, zero new adapters, works today, `min_machines_running=1` Fly config already generated (`deploy.ts:168-205`). Secret auto-persisted 0600 (`embedded-auth.ts:59-70`), migrations in-process (`embedded-auth.ts:118`).
- **Cons:** **Does not meet the team requirement.** `bearer()` only, no `organization()` plugin, no orgId claim, no invite/add-member/create-org anywhere (only `ensurePersonalOrg` writes a single `'owner'` membership, `workspace-authority-store.ts:305-321`). Result: N isolated single-user personal orgs.
- **EXISTS:** Embedded auth engine + verifier (`embedded-auth.ts`); the authority store already has the full org/role/membership/share schema (`workspace-authority-store.ts:33-103`) — never fed a shared org.
- **BREAKS / MISSING (to make it a team backend):** (a) Better Auth `organization()` plugin (or equivalent) issuing org-scoped tokens with roles; (b) invite/accept flow + email sender (none ships — `convex/billing.ts:343` future note); (c) wiring the org claim → store memberships without Clerk; (d) surface `orgId` from the verifier (currently dropped, `embedded-auth.ts:130-135`); (e) decide source-of-truth (Better Auth org tables vs Claxedo's `WorkspaceAuthority` orgs).
- **Effort:** **L** — the single biggest gap between "shipped" and "team self-host on your own stack."

### V3 — Node single-instance + Clerk/Better-Auth + **Convex (authority), as a scale on-ramp**
- **Pros:** Multi-writer authority substrate present (`createConvexAuthority`, `convex-authority.ts:38`); least new code toward eventual multi-instance. **Correction:** hosted org/role behavior **is verifiable from source** (repo-root `convex/orgs.ts` + `convex/model.ts`) — the earlier "unverifiable / not in this checkout" was wrong (author looked only at `packages/claxedo-server/convex/`, which is `_generated`-only).
- **Cons:** Convex is **not bundled** — needs a running Convex deployment plus deployed root `convex/` functions. Central *projection/durable-log* is **still SQLite** even here (`server.ts:677`), so single-instance runtime benefit ≈ zero (though this is exactly V1's teams path once Clerk webhooks are wired).
- **Effort:** **M** (stand up Convex).

### V4 — CF Worker + **Clerk** + Convex (+ DOs + sandbox execution)
- **Pros:** Genuine horizontal fan-out via single-instance name-addressable DOs — `LiveSyncRoom` per-owner/org (built + wired), `WakeLane` per-serialKey, hibernatable WebSockets. Clerk orgs/roles ride the claim into the Convex store. Convex-side crons fire once by construction (`convex/crons.ts`: `sweepStaleLeases` every 10 min, `flagStaleBillingSync` every 6 h). **Correction:** the Worker **provisions execution** via Cloudflare-Sandboxes/Daytona drivers (`hosted-services.ts:78-124,168-176`; `hosted-compose.ts:71-94`), proxying live sessions through the relay (`hosted-app.ts:566-584`).
- **Cons:** The **in-process central session runtime** is disabled — live projection/durable log throw on Worker (`unusedStore`, `hosted-services.ts:181,270-271`); some session routes return placeholder inventory (`hosted-app.ts:481-526`). SSE must be anchored to a DO (plain HTTP streaming doesn't hibernate). Not wired into `claxedo deploy`.
- **EXISTS:** Whole Worker control-plane surface (`worker.ts`, `hosted-app.ts`), Convex authority + lease, Clerk fail-closed auth (`hosted-services.ts:207-213`), DO fan-out primitives, sandbox drivers, settlement/wakes.
- **BREAKS / MISSING:** No `claxedo deploy` CF/Wrangler orchestration (deployable by hand only). No in-process central session runtime on-platform (the SQLite-port cap is architecturally permanent on Worker; session message replay still works via Convex).
- **Effort:** **M** for a working hand-deployed CF control plane with sandbox execution; **L** for one-command `claxedo deploy cloudflare`.

### V5 — Node multi-instance + Clerk + Convex  — designed, not built
- **Pros:** The only route to horizontal Node scale; authority substrate (Convex) already multi-writer, and the Convex coordination functions (`wakes.reclaimFiringWakes`, `sandboxLeases.sweepStaleLeases`, `crons.ts`, `sessions.ts`) **are present** in repo-root `convex/`.
- **Cons/BREAKS:** Everything **Node-process-shaped** is per-process and must change:
  - In-process event bus (`bus.ts:13,137`) → SSE (`routes/events.ts:64`): a mutation on instance A is invisible to an SSE client on B. **Biggest single blocker.**
  - In-process `runtimes` Map holds ports/handles/timers (`workspace-supervisor-store.ts:25`).
  - Per-process **Node** timers: workgraph reconciler `setInterval` (`server.ts:1274`), health monitor (`workspace-supervisor-sandbox.ts:547`), idle reaper — these run **N× cluster-wide**. (Note: Convex-side crons already fire once; the N×-fire gap is *Node-cluster only*.)
- **MISSING (per plan `2026-07-18-001` W6, all unbuilt — Node-side, **not** blocked on Convex code):** fenced Convex lease per periodic Node job; per-workspace Convex ownership lease replacing the `runtimes` Map; Convex-**subscription** live-sync fan-out in Node (only `ConvexHttpClient` exists today, no subscribing `ConvexClient`); LB session affinity (agent PTYs are box-pinned). *Correction:* the wakes atomic `reclaimFiring` **is** shipped (`convex/wakes.ts`); the Node-side fenced cron lease and ownership lease are the real unbuilt items.
- **Effort:** **L (large, gated on Node-side implementation, not on missing Convex functions).** Self-hosted Convex is itself single-node by default (SPOF). Postgres is out by explicit decision.

---

## 3. Org / tenant isolation + team readiness

**Enforcement EXISTS and is adapter-symmetric — verifiable on both sides.**
- Central event bus is **default-deny per-tenant**: `eventVisibleTo` allowlist with `default: return false` (`event-visibility.ts:20-43`); `document.changed`/`provision` gated on `event.orgId === ctx.user.orgId`.
- SQLite authority enforces role precedence (owner→workspace→project→org→share), `workspace-authority-store.ts:392`; every method authorizes before touching rows (`workspace-authority.ts:421-439,806-845`). **Correction:** the Convex mirror is now confirmable — `combineRolePrecedence` at `convex/model.ts:52` — so "adapter-symmetric" is a **verified** claim, not an asserted one.

**What breaks for multi-tenant self-host = identity supply, not enforcement:**
1. **Embedded auth emits no orgId** (`embedded-auth.ts:130-135`) → `event-visibility.ts:30,34` org checks are always false → org-scoped live-sync (`provision`, `document.changed`) is **inert** for signed self-host subscribers (safe, but nonfunctional); only subject-scoped `workgraph.changed` reaches them.
2. **`resolveOrgId` falls back to `ensurePersonalOrg`** (`workspace-authority.ts:377-388`) → every embedded-auth user, and every Clerk user on the **SQLite** authority, lands in their **own personal org**. Shared teams are impossible without manually seeding `org_memberships`, and **no invite/add-member/create-org route ships** (`convex/billing.ts:343` marks it future; grep of real flows = 0).
3. **Multi-member orgs only via the Convex `clerk_org_id` webhook mirror** (`convex/orgs.ts:173-249`; `convex-authority-identity.ts:30`) — teams today are effectively **delegated to Clerk + Convex**.
4. **Corrected — the "trusts org claims blindly" claim was OVERSTATED.** The authority/data-access path does **not** trust a Clerk claim blindly: `resolveOrgId` (`workspace-authority.ts:380-386`) requires an existing `org_memberships` row before honoring `clerk_org_id`, else falls back to personal org → a forged claim grants **zero** workspace/project/document access. The genuine gap is narrower: `hostedOrgMembershipVerifier` returns `undefined` off-hosted at **`org-membership.ts:43`** (`if (deploymentMode(env) !== "hosted") return undefined`) — **not** `:15-19` (that range is JSDoc) — and it gates only the connections **team-partition** re-check. Combined with §3.1 (org-scoped events are inert on embedded self-host), the "forged claim leaks events" scenario is largely theoretical, not a live leak.
5. **Loopback = full-bus visibility** (`event-visibility.ts:22`, `server.ts:504-506`) — correct for single-user desktop; a proxy/`X-Forwarded` misconfig presenting requests as loopback would leak all tenants' events.

**Verdict:** machinery is ready and verified; **team readiness is unmet in every deployment except Clerk+Convex.** To meet "accounts, roles, invites" on a *pure* self-host stack you must build V2's org-plugin + invite/accept + claim-wiring, and close the connections team-partition re-verification gap (`org-membership.ts:43`).

---

## 4. Multi-instance scalability

**Single-instance Node handles cleanly (plan directive #3 = "never fix it"):** in-memory bus→SSE, in-process `runtimes` Map, per-process reconciler/health/idle timers, SQLite leases — all correct with exactly one process.

**Scalable Node must change (all net-new Node-side work, plan `2026-07-18-001` W6 — *not* blocked on absent Convex code, which is present at repo-root `convex/`):**
- Shared networked store — Convex (Postgres/Redis explicitly excluded by decision).
- Fan-out bus for SSE across instances (Convex reactive subscription; **no subscribing `ConvexClient` built** — only `ConvexHttpClient`).
- Fenced Convex lease / leader election so **Node** cron/wakes/reconcile/settlement fire **once cluster-wide**. **Correction:** Convex-side periodic work already fires once by construction (`convex/crons.ts` `sweepStaleLeases`/`flagStaleBillingSync`; wakes `reclaimFiring` shipped in `convex/wakes.ts`); the unbuilt gap is the **Node-cluster** per-process timers (`server.ts:1274`, `workspace-supervisor-sandbox.ts:547`, idle reaper) that would N×-fire.
- Per-workspace ownership lease replacing the in-memory `runtimes` Map.
- LB session affinity (agent PTYs are box-pinned).
- The live projection/durable-log central-store ports remain SQLite-only (session message replay is available via Convex).

**Where scale actually IS built: CF Workers + DOs (+ sandbox execution).** DOs are single-instance name-addressable actors — the primitive Node lacks. `LiveSyncRoom` + `WakeLane` + Convex wake store + settlement dispatcher are built and wired (§V4), and the Worker provisions sandbox execution. The multi-instance **Node** story reuses the same Convex coordination but is **planned, not built** — gated on Node-side implementation, not on missing Convex functions.

---

## 5. Recommendations

### Ship FIRST (best effort:value for "team self-hosts on their stack")

1. **Node single-instance + embedded Better Auth + SQLite, with `organization()` + invites bolted on.** — *The flagship pure-self-host story and the one worth the big investment.* Everything except the auth org-layer already ships (V2). Effort **L**, but the **only** path simultaneously (a) truly self-hostable on their own stack, (b) zero external SaaS, and (c) able to meet "accounts, roles, invites." Concretely: add Better Auth `organization()` (+ optional `sso`/`scim` later), surface `orgId` from the verifier (`embedded-auth.ts:130-135`), wire an invite/accept + email flow (none ships — `convex/billing.ts:343`), and **keep Claxedo's `WorkspaceAuthority` as the fine-grained source of truth** (`auth.ts:241` already reads `orgId`/`org_id`/`organizationId`). Close the connections team-partition re-verification gap (`org-membership.ts:43`).

2. **Node single-instance + Clerk + Convex — ship as the "don't want to build SSO" teams option.** *(Corrected: this, not Clerk+SQLite, is the teams-today path.)* Effort **M** — stand up a Convex deployment, deploy the repo-root `convex/` functions, wire Clerk org webhooks into Convex (`convex/orgs.ts:173-249`), and wire the auth-choice + Clerk secrets into `deploy.ts` (which today wires none — `deploy.ts:344-351`). Document honestly as **two external dependencies (Clerk SaaS + Convex service), per-MAU/per-MAO cost — not the pure self-host path.** Note: **Clerk + SQLite does NOT deliver teams** (SQLite authority mints only personal orgs — `workspace-authority-store.ts:314,318`); use Clerk+SQLite only as single-user.

3. **CF Worker + Clerk + Convex + DOs + sandbox execution — the "cloud/scale" tier, second wave.** Effort **M** to hand-deploy; **L** to make it one-command. Real horizontal fan-out already lives here, and the Worker provisions sandbox execution (Cloudflare-Sandboxes/Daytona). Be explicit that the **in-process central session runtime** (live projection/durable log) is disabled on-Worker; session message replay works via Convex.

### Roadmap for the rest
- **Multi-instance Node (V5):** execute plan `2026-07-18-001` W6 — Node-side fenced leases, per-workspace ownership lease, Convex-**subscription** SSE fan-out (build a subscribing `ConvexClient`), and (if needed) a Convex projection/durable-log adapter. **This is Node-side engineering, not blocked on missing Convex functions.** Accept that self-hosted Convex is single-node/SPOF; treat this as "scale the app tier, not the store."
- **Postgres authority + central-store adapter:** only if a customer needs multi-instance without Convex. Largest lift — full `sqliteTable`→`pg-core` schema rewrite + two adapters + pooling. Currently excluded by decision.
- **D1:** do not pursue as a primary relational store — no adapter exists, and it is a single-primary relational store poorly matched to this workload. (Throughput/size figures previously quoted were unsourced and are withdrawn; the recommendation stands on architecture.)

### Blunt "what breaks today"
- **`claxedo deploy` ships auth-less.** Wires **zero** auth env, prints "runs WITHOUT authentication" (`deploy.ts:344-351`), Fly-only (`:261`). Nothing you ship is secure until this is fixed.
- **No pure-self-host teams.** Embedded Better Auth gives every user a private personal org — no shared orgs, invites, or roles from the auth layer. **And Clerk+SQLite is the same** — shared teams require the **Convex** path (Clerk org webhook mirror).
- **CF runs agents via provisioned sandboxes, not in-isolate, and cannot hold the in-process central session runtime.** Live projection/durable-log ports throw on Worker; session message replay works via Convex.
- **Multi-instance Node is not real** — in-memory bus, `runtimes` Map, and per-process **Node** timers mean two instances drop each other's SSE and double-fire Node crons. The fix is **planned Node-side work** (not blocked on missing Convex code).
- **"Self-host with Convex" needs an external Convex service.** Convex is not bundled; you must deploy the repo-root `convex/` functions and (for Clerk teams) wire Clerk webhooks. Behavior **is** verifiable from source (repo-root `convex/`).
- **Connections team-partition re-verification is off outside hosted mode** (`org-membership.ts:43`) — a narrow gap (not a blanket "trusts claims blindly": `resolveOrgId` still requires a real membership row before honoring `clerk_org_id`).
- **Doc drift:** the cited `docs/tech-docs/multi-instance-architecture-hazards.md` **does not exist**; real content is `docs/plans/2026-07-18-001-cf-deployment-hardening.md` (STATUS: PLANNED). The memory-index note "Convex fns not in checkout" is also **stale** — they are at repo-root `convex/`.

---

## Corrections applied (delta from the synthesis draft)

1. **V1 downgraded / teams path reassigned (verify:auth-org, load-bearing).** Draft's flagship "Clerk + SQLite ★ meets hard requirements today / only combo that ships real teams" is **FALSE**. SQLite authority mints only personal orgs (`workspace-authority-store.ts:314,318`; `resolveOrgId` fallback `workspace-authority.ts:388`). Clerk+SQLite demoted to single-user; the real teams-today path is **Clerk + Convex** (webhook mirror `convex/orgs.ts:173-249`). Matrix, V1/V1b, §3.2/3.3, and Recommendation #2 rewritten accordingly.

2. **"Convex functions absent / unverifiable from source" — WRONG everywhere (verify:storage + verify:platform-scale).** Full Convex backend is at **repo-root `convex/`** (35+ files: `model.ts:52`, `orgs.ts`, `sessions.ts`, `wakes.ts`, `crons.ts`, `schema.ts`, …); the `_generated`-only dir is `packages/claxedo-server/convex/`. Fixed in V3, V5, §2 framing, §4, and the blunt list; "multi-instance blocked on absent Convex functions" corrected to "blocked on unbuilt **Node-side** coordination." Adapter symmetry upgraded from "asserted/unverifiable" to **verified** (`convex/model.ts:52`).

3. **Central-store claim scoped (verify:storage).** "Message replay is SQLite-only" narrowed to: **live per-run projection + durable event log = SQLite-only**; **session message history/replay = also via Convex** (`convex/schema.ts:225,240`; `convex/sessions.ts:374,419,437`; `convex-authority-sessions.ts:49-58`). §1 framing #1 and V4/V5 updated.

4. **"CF engine can never run / always needs a paired Node/Fly host" — OVERSTATED (verify:platform-scale).** Worker provisions sandbox execution (Cloudflare-Sandboxes/Daytona: `hosted-services.ts:78-124,168-176`; `hosted-compose.ts:71-94`; relay proxy `hosted-app.ts:566-584`). Reworded to: engine not in-isolate, execution via provisioned sandboxes; only the in-process central session runtime is capped. CF-net, V4, and blunt list updated.

5. **"Self-host trusts org claims blindly" — OVERSTATED (verify:auth-org).** `resolveOrgId` requires a real membership row before honoring `clerk_org_id`; a forged claim grants zero access. Real gap is narrow (connections team-partition re-check) and at **`org-membership.ts:43`**, not `:15-19`. §3 point 4 and V1 BREAKS rewritten.

6. **Fenced-cron nuance (verify:platform-scale).** Convex-side crons already fire once (`convex/crons.ts`; wakes `reclaimFiring` shipped). The N×-fire risk is **Node-cluster per-process timers only**. §4 corrected.

7. **Minor citation/factual fixes.** D1 "10 GB / ~50 w/s" figures withdrawn as unsourced (verdict unchanged — no adapter). Clerk-verifier "Worker-safe jose" retained but re-cited to `verifyClerkBearer`→`createClerkTokenVerifier` (the draft's `token-verifier.ts:16` is a generic interface file in `workspace-relay-protocol`, not the Clerk verifier). SQLite `ensurePersonalOrg` insert lines pinned to `workspace-authority-store.ts:314,318`. Invite-flow absence re-cited to the explicit future-item note `convex/billing.ts:343`.