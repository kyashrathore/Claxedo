# WP-TENANT: Tenant Hardening for the Hosted Control Plane — Architecture Decisions

Status: PROPOSED (design decisions for review; no implementation in this doc)
Last updated: 2026-07-11
Companion docs: `2026-07-11-012-feat-cloud-subscription-launch-plan.md` (the
$9/seat launch this gates), `2026-07-10-004-feat-connection-scoping-team-personal-plan.md`
(the in-flight scoping work Decision 1 sequences against),
`2026-07-03-004-feat-connections-framework-plan.md`.

## Scope

Claxedo is a hard fork of OpenCode, and OpenCode's tenancy model was "one
trusted human on localhost." Claxedo's self-host-first evolution kept that
assumption in several load-bearing places while the hosted control plane
(CF Worker + Convex + relay + sandboxes) grew around it. Every design below
was *correct* for the deployment shape it was built in. None of them is
correct for the deployment shape we are about to sell: two organizations
that do not trust each other, paying $9/seat, on shared infrastructure.

This doc makes four decisions:

1. What the connection "team" partition key becomes on hosted.
2. How tenant isolation is *enforced* in Convex, not just implemented.
3. How a deployment knows it is hosted, and what that refuses to do.
4. Where hosted provider credentials live.

Plus an explicit list of what we are deliberately NOT building at launch and
when each non-goal expires.

---

## 1. Current tenancy architecture — honest appraisal

### 1.1 Per-query membership joins (Convex)

**What exists.** `convex/model.ts` implements authorization as a family of
hand-written helpers — `roleAllows`, `combineRolePrecedence`,
`workspaceRoleForUser` (owner → direct workspace membership → project
membership → org membership → share grant → org share grant), wrapped by
`authorizeWorkspace` / `authorizeProject`. Every exported Convex query and
mutation is expected to *remember* to call one of these before touching
rows.

**Why it was reasonable.** In a self-host deployment the Convex backend
serves one team that already trusts each other; the role machinery exists
to express *intent* (viewer vs editor), not to defend a boundary. Hand-rolled
helpers were the fastest path, they compose precisely (the six-way role
precedence is genuinely subtle and a generic middleware would have obscured
it), and Convex has no built-in RLS to lean on anyway.

**Why it becomes dangerous.** Convention-based authorization has a failure
mode that grows linearly with the number of functions: *one forgotten call
is a silent cross-tenant read*. The convention is invisible to the type
system — `ctx.db.query("sessions").collect()` typechecks identically with
or without an authorize call above it. Today nothing but reviewer vigilance
distinguishes an authorized function from an unauthorized one, and the
service paths in `packages/claxedo-server/src/control-plane/adapters/convex/`
already thread `{ allowUnsigned: true }` through ~15 call sites — each one a
deliberate hole punched for runtime-to-Convex traffic that must now be
re-justified per-site under multi-tenancy.

**Attack scenario.** A new feature adds `listRecentSessions` for a dashboard.
The author copies an existing query, drops the `authorizeWorkspace` line
while simplifying, tests it as the only user in a dev deployment (where it
behaves correctly by construction — there is nobody else's data to leak),
and ships. Tenant B calls it and receives tenant A's session titles, prompts,
and directory paths. No error, no log line, no test failure: the *absence*
of a check produces no signal anywhere.

### 1.2 Deployment-wide "team" connection partition

**What exists.** `packages/claxedo-connections/src/types.ts` defines
`ConnectionScope = "team" | "personal"` where team is the owner-ABSENT
partition: `// Opaque host-defined partition key. An absent owner is the team
partition.` The SQLite adapter (`connections-host/store-adapter.ts`) maps
team to `owner IS NULL`. Every signed member of the deployment lists, uses,
replaces, and deletes the same team rows.

**Why it was reasonable.** On self-host, "the deployment" and "the team" are
the same set of humans. A team-shared GitHub token that any member's agent
turn can spend is precisely the product feature — that is what a shared
CI-bot-style connection *is*. Modeling team as the null partition kept the
kit decision-free (the host defines what owner strings mean) and made
unsigned-local mode bit-for-bit backward compatible.

**Why it becomes dangerous.** "Deployment-wide" and "org-wide" silently
diverge the moment a second org shares the host. The team partition has no
tenant column; there is nothing to filter by even if the route wanted to.

**Attack scenario.** Org A's admin connects an org GitHub token as a team
connection on shared hosting. Org B's member starts an agent turn; the
turn's capability resolution (`resolveForCapability`) lists team rows —
owner IS NULL matches *the deployment's* team partition — and hands org A's
GitHub token to org B's agent, which happily pushes to whatever repos that
token reaches. This is not a subtle bug; it is the designed behavior of the
current partition applied to an undesigned deployment shape. Same story for
deletion: org B can delete or `confirmReplace` org A's team connection.

### 1.3 Unsigned-local fallback in control-plane auth

**What exists.** `controlPlaneAuthConfig` in
`packages/claxedo-server/src/control-plane/auth.ts`: if
`CLAXEDO_SIGNED_CLOUD_AUTH` is entirely absent, the config is
`{ enabled: false, mode: "local-only" }` and `controlPlaneAuthContext`
returns `{ mode: "unsigned-local" }` for every request — a pass-through.
To its credit, the *misconfigured* case (flag set but issuer/JWKS missing)
already fails closed with a 503. But the *absent* case falls open.

**Why it was reasonable.** Zero-config DX is the self-host product promise:
`claxedo` on your laptop must not demand a Clerk tenant. Auth-off-by-default
is the only shape in which the OSS quickstart works, and the loopback checks
(next section) were the compensating control.

**Why it becomes dangerous.** The dangerous property is not that unsigned
mode exists — it is that unsigned mode is what you get when *nothing* is
configured, which is also what you get when configuration is *lost*. Env
vars get lost constantly: a new Fly region, a rewritten deploy manifest, a
renamed secret, a staging clone promoted to prod. The failure produces a
fully functional server.

**Attack scenario.** The hosted control plane is redeployed from a refactored
Dockerfile that drops the `CLAXEDO_SIGNED_CLOUD_AUTH` secret mount. The
server boots green, health checks pass, and every request — from any tenant,
or from the open internet where a route lacks a loopback guard — is served
as `unsigned-local`, i.e. as the single trusted owner. Nobody notices
because nothing *fails*; the incident is discovered by a curious customer or
a pentest. This is the classic fail-open-on-missing-flag incident pattern
(see Decision 3).

### 1.4 Per-route loopback guards instead of one global gate

**What exists.** `isLoopbackLocalRequest` (from
`routes/local-only-projection.ts`) is called in ~15 separate route files —
`connections-host.ts`, `routes/events.ts`, `routes/bootstrap.ts`,
`proxy.ts`, `central-runtime.ts`, etc. Each route that should be
local-only in unsigned mode individually remembers to stamp the peer
address and check it. `connections-host.ts` even carries a warning comment:
"the loopback check is the effective gate — never copy the ungated
credential/provider-auth mounts."

**Why it was reasonable.** Routes have genuinely different policies: the
OAuth callback must be reachable from the user's browser; relay internals
accept signed machine tokens; some routes are loopback-or-signed, some
signed-only. Per-route composition expressed those differences without a
policy DSL, and in a single-tenant server the cost of a missed guard was
"your own LAN can reach your own server."

**Why it becomes dangerous.** The security posture of the whole deployment
is the *minimum* over all routes, and the set of routes only grows. Every
new route added by every future contributor must independently re-derive
"am I dangerous in unsigned mode?" — the same forgotten-call failure mode as
1.1, but at the HTTP boundary where the attacker doesn't even need an
account. The comment in `connections-host.ts` warning "never copy the
ungated mounts" is the system documenting its own trap.

### 1.5 Fail-closed hosted credential stub

**What exists.** `control-plane/worker-credentials.ts` — the Worker control
plane's `ControlPlaneCredentials` is a stub whose write paths throw
"Credential management is not available in the hosted Worker control plane."
The connections kit maps this to `ConnectionsUnavailableError` → 503.

**Why it was reasonable — in fact, exemplary.** Rather than shipping a
half-thought-through hosted secret path, the surface was stubbed *closed*.
This is the one mechanism in this list that is already the right shape for
multi-tenancy: hosted connections do not exist yet, so there is nothing to
leak.

**Why it still needs a decision.** The stub is a placeholder with a comment
promising "back this with the Worker-safe Cloudflare KV backend
(`credentials/cloudflare.ts`) only." That backend exists but — critically —
stores secrets as **plaintext KV values** (the AES-256-GCM encryption in
`credentials/local.ts` is a property of the *local* backend, not of the
store layer above; `registry.ts` passes `input.secret` to `backend.put`
unencrypted). Filling the stub with the KV backend as-is would make a single
leaked KV API token equal to every tenant's every provider secret in
plaintext. Decision 4 exists so the stub is filled deliberately.

---

## 2. Decision 1 — connection partition key on hosted

### Options

**(a) Org-scoped team partition.** On hosted, "team" means "this org." The
owner column already carries an opaque host-defined string; the host writes
`org:{orgId}` for team rows and `user:{subject}` for personal rows. Self-host
keeps owner-absent as team.

**(b) Workspace-scoped.** Team rows keyed by workspace id.

**(c) Keep deployment-scoped; make hosted a one-org-per-deployment cell
architecture.** Every paying org gets its own control-plane instance, so
"deployment-wide" and "org-wide" coincide by construction.

### Analysis

*Blast radius.* (a) bounds a partition bug to one org — bad, but a
contractual/incident-response problem, not an existential one. (b) bounds it
to one workspace — tighter, but the marginal safety over (a) is small
because the credential *consumer* is an agent turn already scoped to a
workspace whose members are org members. (c) has the best blast radius on
paper (infrastructure-level isolation) and the worst in practice for a solo
operator: N orgs × (Worker config + Convex deployment + relay + secrets)
means the realistic failure is operational — a mis-provisioned cell, a
cross-wired secret during manual setup — and the cost curve makes $9/seat
unviable. Cells are how you serve banks, not how you launch a $9 product.

*Sharing ergonomics.* Teams genuinely want org-wide connections — "our
GitHub org token, usable from any workspace" is the headline use case in the
scoping plan. (b) breaks this: every new workspace re-prompts for the same
token, and users respond by pasting the same secret N times, which is worse
for security (N copies to rotate) and worse UX. (a) matches the mental model
exactly. If a workspace-restricted connection is ever needed, it is
expressible later as another opaque owner shape (`ws:{id}`) without schema
change — that is precisely what the opaque-owner design bought.

*Migration burden on existing self-host rows.* (a): zero. Owner-absent
remains the self-host team partition; no self-host row is rewritten. Hosted
simply never *uses* the null partition — and that becomes an invariant worth
enforcing (hosted host refuses to read or write owner-absent rows). (b)
would force even self-host rows to acquire a workspace key or live in a
legacy partition forever. (c): zero migration, maximal everything else.

*Cost.* (a) is a host-layer change only — the kit (`types.ts`,
`service.ts`) already treats owner as opaque, and `store-adapter.ts`
comments "Owner values remain opaque here; identity and authorization belong
to connections-host.ts." The change is: connections-host resolves the team
partition key from the authenticated principal's `orgId` (already carried in
`SignedControlPlaneAuth.user.orgId` via the JWT `org_id` claim) instead of
null, plus list/visibility filters keyed the same way. Days, not weeks.

### The sequencing call: inside the in-flight branch, or after?

Current state, verified: the scoping work on `codex/feat-connection-scoping`
is *committed* (it landed inside the mixed commit `6d4a661e8e`; the branch
also carries the entire claxedo-app OSS-quality refactor waves — the
uncommitted working-tree files are WP-D5 app-refactor files, not
connections). The scoping diff vs `dev` is ~16 files across
`claxedo-connections`, `connections-host`, and the settings UI.

Arguments for landing org-scoping inside the branch before merge: never
create rows under a partition scheme you know is wrong; retrofitting a
partition key after rows exist is the classic migration trap.

Arguments against, which I find decisive:

1. **The rows that would need retrofitting cannot exist yet.** Hosted
   credential management is a fail-closed stub (§1.5), so no hosted
   connection row can be created by any deployment of this branch. The only
   rows that will exist post-merge are self-host rows, whose partition
   (owner-absent = team) is *correct forever* under option (a). The
   retrofit-risk argument evaporates when the retrofit set is provably
   empty.
2. **The branch already built the escape hatch deliberately.** Rows carry a
   host-generated `id` and credentials are keyed `integration:{connectionId}`
   precisely so that — quoting `types.ts` — "partitions can evolve without
   rekeying secrets." Org-scoping is the evolution that comment anticipates;
   it needs no kit change.
3. **The branch is already dangerously large and mixed.** It carries a
   multi-week app refactor plus the scoping feature in one lineage, with one
   mixed commit. Adding org identity plumbing (JWT org claim → owner
   resolution → new tests) would bloat an already hard-to-review change and
   couple the self-host-safe scoping feature's merge to hosted-tenancy
   questions it doesn't need answered.

**Decision: (a) org-scoped team partition, landed as a follow-up AFTER
`codex/feat-connection-scoping` merges — but gated so it must land BEFORE
`worker-credentials.ts` (or any hosted host) stops being a stub.** The
ordering invariant is not "org-scoping before the scoping branch"; it is
"org-scoping before the first hosted connection row." Concretely, the
subscription launch plan (013/014 siblings) must list as a hard gate:
*hosted connections remain 503 until the connections host derives the team
partition from `orgId` and refuses owner-absent rows in hosted mode.*

One addition that SHOULD ride along early (cheap, closes a latent hole): the
turn-credential record (`connections-host/turn-credentials.ts`) carries
`sessionId` + `subject`; when org-scoping lands it must also carry the org,
so a personal-scope resolution can never cross an org boundary even if a
subject id collides across issuers.

---

## 3. Decision 2 — isolation enforcement architecture (Convex)

### Options

**(a) Convention + structural guard test.** Keep hand-written authorize
calls; add an architecture test asserting every exported Convex function
calls an authorize helper. Precedent: the guard-test suite in
`packages/claxedo-app/src/architecture/` (import-graph, layering,
session-boundary, single-writer guards with ratcheted baselines) and
`packages/claxedo-server/src/architecture.test.ts`.

**(b) Mandatory authorization wrapper.** Replace raw
`queryGeneric`/`mutationGeneric` with custom builders (`authedQuery`,
`authedMutation`, `serviceQuery`) that resolve identity and an authorization
context *before* the handler runs; handlers receive the authorized principal
as an argument and cannot execute without one.

**(c) Row-level tenant scoping.** `tenant_id` (org) on every row; all reads
go through scoped reader helpers that inject the tenant filter.

### What each actually prevents

| Bug class | (a) guard test | (b) wrapper | (c) row-level |
|---|---|---|---|
| Forgotten authorize call (new function ships with no check) | Yes — test fails | Yes — raw builder unavailable/flagged | Yes |
| Wrong join (authorize called against the wrong workspace, or role check on object X while reading object Y) | No — the call exists, the test is happy | Partially — wrapper can bind "the object you authorized" to "the reader you get," but only if handlers use the scoped reader | Yes for tenant boundary; no for intra-tenant role errors |
| Confused deputy (service path with `allowUnsigned: true` forwards an unvalidated workspace id) | No | Partially — service builders can force an explicit machine-principal + target declaration per call | Yes at tenant granularity — even a confused service call can only read within the tenant it names, *if* the tenant is derived from something verified |
| Cross-tenant leak via missing index filter in a fan-out query | No | No | Yes |

The honest reading: (a) alone is a linter, and it lexically cannot tell a
*correct* authorize call from a decorative one. (c) alone is the strongest
boundary but is a schema-and-every-query refactor across all Convex tables
plus every adapter in `control-plane/adapters/convex/` — weeks of high-risk
churn precisely when the launch needs stability, and Convex's lack of
native RLS means (c) is still convention under the hood (scoped readers are
helpers someone can bypass) unless paired with (a)/(b) anyway.

### Cost and regression profile

- (a): ~1–2 days. Zero runtime cost. Regression risk per new function: the
  test catches omission on the next CI run. Known weakness: source-text
  guards can be satisfied vacuously (the existing
  `source-text-assertions.guard.test.ts` machinery exists because the team
  already learned this).
- (b): ~3–5 days for the builders + mechanical migration of existing
  functions (the authorize helpers already exist and keep their exact
  semantics; they move from "called inside the handler" to "called by the
  builder with handler-supplied args"). One extra identity read per call at
  runtime — already being paid, just relocated. Regression risk per new
  function: near zero for *omission* (a new function written with the raw
  builder is caught by the (a) guard; one written with the authed builder
  cannot skip identity). Wrong-join risk remains but is squeezed: the
  builder returns the authorized object, so the natural code path reads
  from what was checked.
- (c): weeks; touches every table, every query, all `allowUnsigned` service
  paths, plus a backfill migration. Perf: additional index component on
  every hot query — fine in Convex, but the refactor risk dwarfs it.

### Decision

**(b) mandatory wrapper as the enforcement mechanism, with (a) as the
structural ratchet that makes (b) unavoidable, and (c) deferred with a
defined trigger (§6).**

Concretely:

- Introduce `authedQuery` / `authedMutation` builders in `convex/` that call
  `requireIdentity` + the relevant authorize helper and hand the handler
  `{ user, workspace|project, role }`. Introduce `serviceMutation` for the
  runtime paths that today use `allowUnsigned: true`, requiring an explicit
  machine credential check rather than an ambient boolean — this converts
  each of the ~15 punched holes from "trust the caller" to "verify the
  caller," which is the actual confused-deputy fix.
- Add a Convex architecture guard test (same pattern as
  `claxedo-app/src/architecture/*.guard.test.ts`): no exported function in
  `convex/*.ts` may be built from raw `queryGeneric`/`mutationGeneric`
  outside the builder module; baseline file ratchets existing exceptions to
  zero. This is the piece that keeps decision (b) true two hundred functions
  from now.
- Do NOT attempt (c) pre-launch. Record it as the known ceiling: the wrapper
  guarantees *a* check runs; it cannot guarantee the check matches the rows
  read. That residual class (wrong-join) is mitigated by review + the
  builder returning authorized objects, and is accepted at launch scale.

---

## 4. Decision 3 — deployment-mode model

### The problem with inference

Today "hosted" is not a fact the system knows; it is an emergent property of
which env vars happen to be set. `CLAXEDO_SIGNED_CLOUD_AUTH` absent →
unsigned-local single-owner (§1.3). The system cannot distinguish "operator
chose self-host" from "operator lost an env var," and those two states
deserve opposite behaviors. Fail-open-on-missing-flag is a canonical
incident pattern because *absence is the most common misconfiguration*:
flags get dropped in deploy-manifest refactors, secret-store renames,
region migrations, and disaster-recovery rebuilds — precisely the moments
when nobody is watching auth behavior. A security posture that degrades to
"open" under the most likely operational error will eventually be exercised.

The codebase already half-knows this: `controlPlaneAuthConfig` fails the
*misconfigured* case closed (flag set, issuer missing → 503). The gap is
only the fully-absent case, which today is indistinguishable from intent.

### Decision

**Introduce `CLAXEDO_DEPLOYMENT_MODE` with values `self-host` (default when
absent) and `hosted`, and make `hosted` fail-closed at boot.**

- `hosted` asserts at composition time (not per-request): signed auth
  enabled and fully configured, a workspace authority resolved, a hosted
  credential decision made (Decision 4 backend or the fail-closed stub —
  never the local file backend), and org-derived connection partitioning
  active (Decision 1). Any assertion failing = **refuse to start**, with a
  message naming the missing piece. A hosted deployment that cannot
  authenticate must be down, not open. Ordinary uptime monitoring then
  converts a lost env var into a visible outage instead of a silent breach.
- `self-host` (or absent) keeps today's behavior bit-for-bit: zero-config
  boot, unsigned-local, loopback-guarded. DX is untouched because the flag
  is something only the hosted deploy manifests set — our own Worker/Fly
  configs — never the OSS quickstart.
- Why not overload `CLAXEDO_SIGNED_CLOUD_AUTH=required`? Because deployment
  mode governs more than auth: credential backend selection, the null-owner
  connection partition refusal, and which routes may exist at all (the
  hosted Worker already forbids most root routes). One mode flag, many
  consumers; auth remains one consumer of it.

### Where the unsigned-local guard sits

The per-route `isLoopbackLocalRequest` calls (§1.4) invert the safe default:
routes are open-unless-guarded. Move the decision to one place:

- A single global middleware at the server composition root resolves the
  request's auth context once: in hosted mode, `unsigned-local` is simply
  unreachable (boot assertion above); in self-host signed mode, the
  middleware classifies the request (signed / loopback / neither) and
  attaches the classification, defaulting *deny* for "neither."
- Routes with genuinely weaker policies (OAuth callback, relay
  machine-token paths) opt *out* explicitly and visibly — an allowlist of
  exceptions is auditable; a scatter of guards is not.
- Keep the existing per-route checks during transition as defense-in-depth;
  they become redundant, not wrong. The `connections-host.ts` "never copy
  the ungated mounts" comment gets to retire.

---

## 5. Decision 4 — hosted credential store

### Options

**(a) Build on the existing Cloudflare KV backend**
(`credentials/cloudflare.ts`) — exists, Worker-adjacent, low-latency.
**(b) Convex-stored encrypted blobs** — secrets as rows next to the app data.
**(c) External secret manager** (CF Secrets Store per-tenant, or Vault).

### Analysis

*The non-negotiable, whichever backend wins: envelope encryption above the
`SecretBackend` seam.* Verified in §1.5: the KV backend stores plaintext
values today; encryption is a property of the local backend only. So the
real design is a store-layer wrapper — encrypt with a per-secret DEK,
wrap the DEK with a KEK held as a Worker secret (or in CF Secrets Store),
prefix ciphertext with a key-id so KEK rotation is "add new KEK, re-wrap
DEKs lazily on read, retire old key-id" rather than a migration event. This
wrapper is backend-agnostic and roughly a week of careful work including
rotation tests. With it in place, the backend choice becomes a question of
blast radius, latency, and ops burden rather than confidentiality.

*(a) KV.* Blast radius of a KV-token compromise drops from "all secrets
plaintext" to "ciphertext only" once enveloped; an attacker needs the KEK
(Worker secret) *and* KV. Latency from the Worker is single-digit ms and, if
the values are bound rather than REST-fetched, effectively free. Ops burden
for a solo operator: one KV namespace, one Worker secret — minimal. Existing
code is a head start though not decisive (it reads `process.env` and REST;
Worker bindings need a thin adaptation either way). Weaknesses: KV is
eventually consistent (a rotated/deleted credential may be readable for ~60s
at other edges — acceptable for provider tokens, worth documenting) and
key enumeration via `/keys` means naming must not leak tenant identity
(hash the provider id, as the local backend already does for filenames).

*(b) Convex blobs.* Puts ciphertext inside the same system that holds all
app data and whose query surface is the thing Decision 2 exists to harden —
co-locating secrets with the largest attack surface is backwards. It also
enrolls secrets in Convex backups/exports and function logs by default, and
adds a Worker→Convex round-trip on the token path. Its one genuine
advantage — transactional delete-with-row — matters little because the
connections design already tolerates credential/row divergence (status
"broken").

*(c) External manager.* Vault is disqualified on operational burden alone
for a solo operator (an HA stateful service with its own sealing/unseal
ceremony, to protect a $9/seat launch). CF Secrets Store is attractive but
is designed for operator-scale config secrets, not thousands of
programmatically-written per-tenant items; using it for the KEK only (not
the per-tenant DEK-wrapped payloads) captures its value without fighting
its shape.

### Decision

**(a): Cloudflare KV as the byte store, mandatory envelope-encryption
wrapper at the store layer, KEK in a Worker secret (CF Secrets Store when
available), key-id-prefixed ciphertext for rotation.** Additionally:
per-tenant key derivation (KEK + org id → per-org subkey via HKDF) so that
no single decryption context ever holds a position over multiple tenants'
secrets, and so a future "delete org" can be a key-destruction operation.
`worker-credentials.ts` stays a fail-closed stub until wrapper + Decision 1
partitioning both exist — the stub is currently doing correct security work
and should not be filled early.

---

## 6. Risks, deliberate non-goals, and the acceptability ladder

Each non-goal below is a decision, not an omission. Each has an expiry
condition; when the condition trips, the debt is due.

**Not building row-level tenant scoping (Decision 2's option (c)).**
Acceptable at launch because the wrapper + guard test close the dominant
bug class (omission), the tenant population is small enough that incident
response can be personal, and the data at risk in the residual class
(wrong-join within an authorized function) is metadata-shaped more often
than secret-shaped (secrets live behind Decision 4, not in Convex).
*Expires when*: any of — first enterprise/security-questionnaire customer;
~50 paying orgs (the review-based mitigation stops scaling); or the first
wrong-join incident, whichever is first. At that point `tenant_id` columns
plus scoped readers get scheduled as a wave, made cheap by the fact that
every function already flows through the Decision 2 builders (one choke
point to change instead of every handler).

**Not reauthorizing established relay sockets mid-stream.** A user removed
from an org keeps any live relay/workspace socket until it naturally closes;
revocation takes effect at the next connection. Acceptable at launch
because token lifetimes are short, sockets are bounded by session activity,
and offboarding at 10–100 seats is a Slack-message-latency event, not an
adversarial race. *Expires when*: contractual offboarding SLAs appear
(enterprise), or seat counts make "who still has a live socket" unknowable —
roughly the several-hundred-seat mark. The fix then is periodic in-band
reauth of long-lived sockets against the workspace authority, not
per-message checks.

**Not doing per-tenant infrastructure isolation (cells).** Rejected as the
launch architecture in Decision 1; also a non-goal as a *partial* measure
(per-tenant Convex deployments, per-tenant relays). Acceptable because
logical isolation (Decisions 1–4) addresses the credible threat — accidental
cross-tenant exposure through application bugs — and the launch price point
cannot carry cell economics. *Expires when*: a regulated/compliance-bound
customer offers revenue that funds it (single-tenant tier as a product SKU,
not a default), or MRR in the tens of thousands makes one shared blast
radius an unacceptable business risk.

**Not revoking third-party tokens at the provider on owner removal.**
Carried over from the scoping plan (`removeOwner` deletes rows and local
credentials only). Acceptable because local deletion removes *our* ability
to spend the token, and provider-side revocation requires per-integration
API work. *Expires when*: hosted onboarding/offboarding is self-serve —
at that point "we deleted our copy" stops being an honest answer to "did
you revoke access."

**Residual risks accepted with eyes open.** (1) The wrong-join class
survives Decision 2 until row-level scoping lands. (2) Self-host
deployments that *choose* signed mode on a shared network but never set
`CLAXEDO_DEPLOYMENT_MODE=hosted` get the old per-route posture; the global
middleware narrows but does not eliminate this. (3) KV eventual consistency
gives revoked credentials a ~minute of undead readability at edges. (4) The
mixed provenance of `codex/feat-connection-scoping` (scoping + app-refactor
waves + one mixed landing-page/RBAC commit) makes bisecting any
post-merge connections regression harder than it should be; the follow-up
org-scoping change should land as a clean, single-purpose branch.

## Summary of decisions

| # | Decision | Gate it creates |
|---|---|---|
| 1 | Org-scoped team partition via the existing opaque owner key; self-host rows untouched; land AFTER the scoping branch merges | Hosted connections stay 503 until org partitioning is live |
| 2 | Mandatory `authedQuery`/`authedMutation`/`serviceMutation` builders + Convex architecture guard test; row-level scoping deferred with trigger | No exported Convex function outside the builders (ratcheted to zero) |
| 3 | `CLAXEDO_DEPLOYMENT_MODE=hosted` fail-closed at boot; single global auth middleware, per-route guards demoted to defense-in-depth | Hosted refuses to start unsigned; self-host DX unchanged |
| 4 | CF KV byte store + envelope encryption (per-org HKDF subkeys, key-id rotation); KEK in Worker secret; stub stays until 1 + wrapper exist | `worker-credentials.ts` remains fail-closed until both preconditions land |
