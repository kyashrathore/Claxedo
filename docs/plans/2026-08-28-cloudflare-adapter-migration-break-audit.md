---
title: "Cloudflare adapter migration: two-pass 200-lens break audit"
type: review
status: complete
date: 2026-08-28
reviewed_plan: "docs/plans/2026-08-27-147-refactor-cloudflare-d1-better-auth-cutover-plan.md"
---

# Cloudflare adapter migration: two-pass 200-lens break audit

## Verdict

The pre-audit plan would break in production. The first 100-lens review found three P0 data-loss/identity risks, thirteen P1 security, deployment, and continuity failures, and a set of P2 contract and operability gaps. The second 100-lens review plus its blocker reconciliation found six additional P0 failures and twenty P1 implementation/release blockers. The migration plan has been rewritten to turn each P0/P1 into an explicit dependency, implementation task, test, or release gate.

This was not literally 100 simultaneous agents: the workspace permits three subagents plus the primary reviewer. Four concurrent reviewers split the request into 100 independent failure lenses across auth/clients, data/migration, Cloudflare/deployment/optional services, and cross-cutting build/test/package closure. Each reported issue required a live-code execution path, a concrete failure, and the smallest plan correction. Duplicate observations were merged.

## Findings that would have broken the migration

| Initial severity | Failure | Code evidence | Plan disposition |
|---|---|---|---|
| P0 | Browser and CLI expose different canonical user IDs, so migration can split one person or orphan ownership. | `convex/users.ts:4-14`; `packages/claxedo-server/src/authority/adapters/convex/workspace-authority/identity.ts:18-20`; `convex/schema.ts:192-206` | Canonical hosted `user_id` is `String(users._id)`; provider/token identifiers are ledger aliases; browser/CLI convergence is an acceptance test. |
| P0 | A pending Clerk-triggered org purge can resume after org authority becomes application-owned and delete the migrated org. | `convex/schema.ts:102-115`; `convex/orgs.ts:155-176,787-808,981-1030,1083-1103` | Freeze deletion; inventory/drain/cancel every pending purge/barrier/receipt; install an app-owned deletion generation; prove crash-resume behavior. |
| P0 | “Exclude sessions” can be interpreted to drop durable application transcripts along with auth credentials. | `convex/schema.ts:382-409` | Auth sessions/grants are invalidated; application session history/messages are preserved and verified by count, hash, and a real read. |
| P1 | The retained Clerk verifier accepts issuer-valid credentials without a mandatory browser authorized party or a complete native client/resource/token policy. | `packages/workspace-relay-protocol/src/token-verifier.ts:57-66,173-217`; `packages/claxedo-server-core/src/platform/auth/auth.ts:254-298` | Separate browser and native Clerk policies require exact issuer/audience/`azp` or resource/client/token kind/scopes, with wrong-party negative tests. |
| P1 | The current browser build is a Clerk artifact even if the Worker selects Better Auth. | `packages/claxedo-app/src/app/entry/main.tsx:13,80,104,119`; `packages/claxedo-app/vite.cloud.config.ts:156-159`; `packages/claxedo-server/scripts/deploy/deploy-hosted.ts:47-88` | Certified profiles get matching browser composition roots, Worker entrypoints, build manifests, workflow inputs, and artifact-closure scans. |
| P1 | Better Auth cookie sessions cannot traverse the current Pages-to-Worker transport, and auth rejection retries anonymously. | `packages/claxedo-app/src/platform/api/api.ts:348-455` | Exact-origin credentialed CORS, `credentials: "include"`, ambiguous-credential rejection, no anonymous downgrade, and a real custom-domain cookie E2E are required. |
| P1 | Native logout deletes local files but leaves server credentials valid. | `packages/cli/src/commands/logout.ts:1-6`; `packages/claxedo-desktop/src/main/account/account-service.ts:263-268` | Add adapter-selected remote revocation; revoke before local removal; report offline uncertainty; reject reused access and refresh credentials. |
| P1 | CLI/desktop overwrite the only rotating credential file non-atomically. | `packages/cli/src/json.ts:29-32`; `packages/claxedo-desktop/src/main/account/electron-seams.ts:67-83` | Same-directory mode-0600 temp file, flush, atomic rename, and serialized/CAS refresh ownership with interruption/concurrency tests. |
| P1 | Account deletion has no auth-provider lifecycle boundary, so application cleanup and provider disable/delete can diverge. | Current auth adapter verifies credentials only; no neutral lifecycle port exists. | Add `AuthAccountLifecycle` with idempotent disable/delete/revoke/status and a durable non-revivable deletion saga for Better Auth and Clerk. |
| P1 | Usage facts and rollups mix Clerk subjects/orgs, token identifiers, and Convex IDs under the same field names. | `convex/schema.ts:462-498,577-780`; `convex/sessions.ts:229-234` | Add a field-level semantics manifest, canonicalize facts, recompute/collision-merge rollups, verify totals, and reject ambiguity. |
| P1 | The production WorkGraph exporter loads the whole tenant with `.collect()`, so large tenants can fail before an artifact exists. | `convex/workgraphArchive.ts:59-78,363-382,661-664` | Ban that endpoint for production migration; use a frozen native snapshot or stable paginated, resumable, checksummed per-table export rehearsed at largest-tenant size. |
| P1 | Documents content and credential-bearing job objects share one R2 bucket; adoption can retain sealed auth. | `packages/claxedo-server/src/documents/backends/hosted/backend.ts:66-106,229-245,418-440` | Drain the job lifetime, tombstone then delete `document-jobs/**`, prove zero credential-bearing keys, and adopt only content/index objects. |
| P1 | The retained Convex deployment still physically owns WorkGraph/wakes tables, functions, cascades, and workflow deployment. | `convex/schema.ts:815-1681`; `convex/sessions.ts:2,15-16,216-299`; `convex/orgs.ts:18,553-583,627-663`; `.github/workflows/deploy-control-plane.yml:163-196` | Clerk+Convex cannot be certified until a core-only Convex carve-out completes. Active WorkGraph makes its service unit a conditional prerequisite; verified-unused state is archived and retired. |
| P1 | The guide requires same-site cookies but does not attach or prove custom domains; current workflow advertises `workers.dev`. | `packages/claxedo-server/wrangler.toml`; `.github/workflows/deploy-control-plane.yml:27-30` | Domain/proxy attachment, DNS/TLS readiness, observed-origin comparison, exact CORS/trusted origins, callbacks, and cookie topology now precede auth deployment. |
| P1 | Losing the shared Cloudflare rate-limit binding silently degrades to a per-isolate limiter. | `packages/claxedo-server/src/deployments/hosted-workerd/worker.ts:86-93,203-208`; `packages/claxedo-server/src/platform/governance/rate-limit-config-drift.test.ts:4-11` | Hosted profiles fail preflight and boot without the typed shared limiter; only explicit local/test mode may degrade; every rendered config is tested. |
| P1 | The legacy Durable Object migration workflow references nonexistent files and cannot safely retire the old classes. | `.github/workflows/deploy-worker-migration.yml:28-41`; `packages/claxedo-server/wrangler.toml:18` | Unit 1 must delete or replace it for the selected append-only retirement strategy, with real-file contract tests, ordered drain/archive, dry-run, and approval. |

## P2 gaps promoted into implementation constraints

- Shared provider vocabulary can survive import-only closure scans. The plan now guards serialized API schemas and source symbols such as `SignedControlPlaneAuth`, `VerifiedClerkAuth`, `grantedToClerk*`, `clerkOrgId`, `auth.clerk`, Clerk user fields, and `template: "convex"` outside adapter/migration-private directories.
- The neutral principal originally lacked recent-auth/MFA assurance, validated session ID, client, token kind, and scopes. Those are now part of the frozen principal and adapter-neutral reauthentication contract.
- Replace-all session messages had no defined maximum. The authoritative port must now freeze byte, count, and per-message limits plus atomic reject or resumable generation semantics.
- Existing SQLite `authority.db` files had no versioned upgrade strategy. The implementation must preserve their physical shape behind the neutral adapter or add a transactional, fixture-tested upgrade.
- Cloudflare resource bindings were hidden behind string-only environment types and `unknown`/`NodeJS.ProcessEnv` casts. Profile/install-specific generated `Env` types and rendered-config typechecks are now required.

## Lens allocation and reconciliation

The 100 lenses were partitioned before review so a large file count could not crowd out a failure class:

- Lenses 1–25: authentication, browser transport, OAuth/device/PKCE, CLI/desktop storage/revocation, lifecycle, and provider-leak closure.
- Lenses 26–50: identity, authority, Convex/D1/SQLite semantics, transactions/CAS, data transform, artifacts, custody, rollback, and large-tenant behavior.
- Lenses 51–75: Cloudflare Worker/Pages topology, Wrangler resources, bindings, crons/DOs/R2, workflows, relay, optional-service lifecycle, and active-user continuity.
- Lenses 76–100: package and import closure, composition roots, build manifests, configuration generation, contract tests, negative paths, operability, and plan coherence.

After integration, the same three specialist streams re-read the current plan in blocker-only mode. That pass caught two plan-level P1 contradictions: Unit 6 both depended on and blocked completion of Unit 3, and “active feature” alternately required a service or allowed an undefined outage. The rewrite now gives Unit 3 an acyclic Phase A/Phase B boundary and permits no-service cutover only after an explicit archive-and-deactivation that makes the feature inactive at cutover. It also corrected the retained-profile guide to require its in-place identity-alias rewrite.

That was the first-pass reconciliation. A second independent 100-lens pass was then run against the rewritten plan rather than the original proposal.

## Second 100-lens pass

After duplicate observations were merged, the second pass found five additional P0 failures and nineteen P1 implementation or release blockers. These were omissions in the plan, not evidence that implementation had already failed:

| Severity | Newly exposed failure | Code-grounded correction added to the plan |
|---|---|---|
| P0 | Bounded Clerk organization reconciliation can leave stale membership as permanent application authority. | Complete paginated every-organization/member reconciliation, two identical hash passes, a durable cutover inbox, then removal of Clerk organization webhook/reconcile/crons while retaining Clerk as an auth adapter. |
| P0 | Allowing import rejects or choosing a “highest” duplicate role can silently delete data or grant privilege. | Per-table conservation and zero unapproved core rejects, duplicate target keys, broken references, ambiguous identity merges, or ambiguous role merges. |
| P0 | Deploying the target Worker before the browser/import gate leaves no enforceable first-write boundary. | Persisted release lock, dark candidate, build/profile binding, exhaustive producer fence, and one atomic write-admission action. |
| P0 | Documents runtime hydration/renew/writeback callbacks have no route through a person-only private gateway. | Capability-scoped core callback gateway with hydrate, renew, writeback, conflict, dispose, replay, and disable-mid-job tests. |
| P0 | WorkGraph provider webhooks have no route after extraction behind a private service binding. | Dedicated narrow public webhook hostname, raw-body preservation, service-owned verification, replay/rate controls, registration, drain, and removal lifecycle. |
| P1 | Better Auth origin policy does not protect the application's custom mutation routes from same-site CSRF. | Default-on unsafe-method CSRF middleware plus an explicit custom-route inventory and negative tests. |
| P1 | An already-open live-sync stream remains authorized after membership removal. | Periodic/current authority revalidation using a suspension or authorization epoch, failing closed. |
| P1 | CLI/desktop refresh credentials are not bound to an exact deployment, issuer, client, resource, adapter, and token kind. | Persist those fields and reject missing or mismatched metadata; no compatibility interpretation. |
| P1 | One runtime admin secret spans core-operator and sandbox trust domains. | Separate machine identities and secrets, equality/cross-use preflight, and independent rotation. |
| P1 | “Freeze writes and crons” misses webhooks, delayed work, Durable Objects, workflows, and scheduled settlement. | Persisted `cutover_epoch` checked by every producer plus drain and two stable source scans separated by the longest producer window. |
| P1 | In-flight idempotency work can commit after the source snapshot. | Zero in-flight proof, wait beyond the retry window, receipt import for the retained horizon, and explicit invalidation of ephemeral work. |
| P1 | Normal billing stale-state sweeps are not a complete Polar source reconciliation. | Full provider pagination, zero unresolved/cancel failures, webhook drain/switch, and a post-target reconciliation pass. |
| P1 | Invalidating application leases does not prove paid provider sandboxes were destroyed. | Provider inventory with destroy-or-handoff evidence and a declared `control-plane-only` or `full-hosted` posture. |
| P1 | Usage raw facts expire while rollups persist, so one recomputation rule corrupts old totals. | Retention cutoff: recompute recent facts, algebraically merge older rollups, and verify the two populations separately. |
| P1 | Largest-tenant WorkGraph checks miss tenants omitted from bounded source enumeration. | Authoritative paginated deployment-wide `(org, owner)` census with one import/archive/abandonment disposition per tenant. |
| P1 | Documents R2 listing stops at 10,000 keys. | Resume until `truncated=false`, repeat to a stable listing, and test a bucket above 10,000 objects. |
| P1 | R2 adoption lacks a restore path, while read probes can perform repair or cleanup writes. | Immutable restore-tested backup plus read-only migration mode and an explicit first-write boundary. |
| P1 | Separate auth and control-plane D1 databases can be restored to incompatible points in time. | Shared recovery epoch, paired backup/restore/rebind, and boot/first-request rejection on mismatch. |
| P1 | WorkGraph transcript extraction can lose the usage facts that drive billing attribution. | One idempotent bridge operation retaining transcript and usage together by stream/run/item identifiers. |
| P1 | Desktop has no closed, typed transport for independently installed WorkGraph/Documents services. | Browser and Electron service registries with typed operations; no generic renderer fetch escape hatch. |
| P1 | A greenfield guide can report success while cloud workspace creation always returns “sandbox driver unavailable.” | Make posture explicit; hide the feature for `control-plane-only`, or provision and smoke a real driver for `full-hosted`. |
| P1 | Existing boundary and route-inventory policies still require WorkGraph in the core artifact. | Separate core/self-hosted, WorkGraph, and Documents closure policies and entrypoint tests. |
| P1 | The bundled device plugin alone does not implement the resource-bound OAuth provider flow required by native clients. | Pin the OAuth-provider companion and device-authorization packages, use the OAuth token endpoint, and disable unauthenticated dynamic client registration. |
| P1 | Hard-coded account-scoped Cloudflare rate-limit namespace IDs can couple independent deployments. | Renderer-allocated deployment-unique positive IDs with duplicate rejection and rendered-config tests. |

The operational gates, migration sequence, deployment guide, success measures, and repository evidence list were rewritten around these findings.

### Final blocker-only reconciliation

The blocker-only recheck found one further P0 contradiction and one P1 manifestation of the same release-order defect:

| Severity | Recheck failure | Final correction |
|---|---|---|
| P0 | The guide attempted a successful Better Auth sign-in while the target was still locked, even though sign-in writes `AUTH_DB`; opening the lock first would let an ordinary request race the irreversible canary. | Replace the Boolean lock with persisted `locked` → exclusive `canary` → `provider_sync` → `multiplayer_validation` → `open` states. `locked` rejects sign-in; the one release-bound canary owns the first target mutation; ordinary traffic cannot race it. |
| P1 | Opening ordinary traffic before callback switch, provider drain, complete Polar/authority reconciliation, and paired backup could expose stale billing entitlement and checkout state. | `provider_sync` keeps application writes, checkout, and billing portal denied while old/new callback paths drain with dedupe, reconciliation reaches zero unresolved records, and the paired backup completes. A fenced multiplayer smoke follows; only then may `open` publish the browser. |

After those corrections, the security, migration/operations, and build/deployment reviewers each reported no remaining P0/P1 blocker in the pre-multiplayer plan. Across the second run plus its blocker-only reconciliation, the deduplicated result was six P0 failures and twenty P1 implementation/release blockers. This is still a plan-level result: the implementation gates remain open until executable evidence closes them.

## Multiplayer branch addendum

The later review of `codex/single-tenant-multiplayer-ready` materially expanded the target. The branch's implementation commit `c97d1fe3ce` and dossier commit `1537de86f8` are code-grounded inputs, not merge approval: the branch declares itself **NOT READY TO MERGE** and records 15 P1 plus 3 P2 findings.

The migration plan now lands directly on the multiplayer schema/runtime instead of reproducing single-user D1 first. It imports these branch requirements as release blockers:

- application-owned immutable human/agent actors; browser versus CLI cannot rewrite actor kind;
- canonical org/project/workspace identity with backend-equal repository keys and session/workspace project equality;
- private sessions requiring current workspace authority plus creator/active-participant/org-admin status;
- idempotent atomic session create/fork registration with cleanup or durable ambiguous-outcome reconciliation;
- one durable prompt-turn lease across runtime reconstruction;
- producer-backed message authors, leaving unknown history unattributed;
- one complete transcript route/event policy covering HTTP, process-log aliases, PTY, SSE, replay, reconnect, and compatibility proxy;
- default-deny tenant visibility for sessionless signed events;
- renewable stream grants linked to revocable parent authority, with bounded cache/queue/concurrency/readiness and exact 401/403/503 behavior;
- complete actor/project/workspace/session/participant migration verification and a real two-signed-user gate before traffic.

Product topology is deliberately separate from that shared tenant-safe model:

| Deployment | Organization policy | Multiplayer | Billing |
|---|---|---|---|
| Claxedo-hosted | Many isolated customer orgs | Required inside every org | Full Polar billing, usage attribution, subscription enforcement, callbacks, reconciliation, and UI |
| User-deployed | Exactly one deployment org; deployer is initial owner; other users join that org | Required inside the one org, with wrong-org denial still tested | No Claxedo billing/Polar routes, UI, secrets, webhooks, jobs, gates, or provider resources |

This avoids a second single-tenant implementation: user-deployed remains structurally tenant-scoped, but a static product-policy adapter prevents creation or switching of additional orgs. Billing is likewise a static Claxedo-hosted composition, not an unconfigured feature left in user deployments.

## Scope of this audit

This audit rewrites the implementation plan; it does not implement the migration. The repository already contains unrelated uncommitted work, which was not modified. Passing this document review means the plan names the known break paths and gates—it does not prove Better Auth on Workers/D1, D1 concurrency, Convex contraction, service extraction, or Cloudflare deployment until their executable unit acceptance tests pass.
