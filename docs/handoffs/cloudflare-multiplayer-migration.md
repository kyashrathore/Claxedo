---
artifact_contract: "ce-handoff/v1"
created_at: "2026-08-28T06:43:58Z"
title: "Cloudflare multiplayer migration implementation checkpoint"
summary: "Rebased and verified checkpoint covering Better Auth/D1 peer adapters, retained Clerk/Convex, optional services, private multiplayer streams, D1 turn admission, and the remaining security and release blockers."
keywords: ["cloudflare", "better-auth", "d1", "convex", "multiplayer", "private-sessions", "handoff"]
cwd: "/private/tmp/claxedo-boundary-base/.worktrees/codex/cloudflare-multiplayer-migration"
resume_focus: "Review the checkpoint, then close authoritative turn fencing, terminal capability revocation, canonical PTY-to-session binding, retained Convex parity, author provenance, and real deployment gates without backward-compatibility fallbacks."
repository: "Claxedo"
repo_root_sha: "728cedf2a29e2f9da901c8c36620ce5efc09e6b2"
branch: "codex/cloudflare-multiplayer-migration"
head: "0a94030c05"
worktree_path: "/private/tmp/claxedo-boundary-base/.worktrees/codex/cloudflare-multiplayer-migration"
---

# Cloudflare multiplayer migration checkpoint

## Continuation 2026-08-31: desktop sign-in unblocked on live staging

A takeover session resolved the blocker the previous session died on: the
desktop PKCE token exchange "hang" against the live staging Worker.

### Root cause (evidence-grounded, not a code bug in the auth stack)

- Workers observability showed every "hung" `POST /api/auth/oauth2/token` and
  `POST /api/auth/oauth2/revoke` invocation as `outcome: canceled`, ~3 ms CPU,
  30–301 s wall, no response, and the authorization codes never consumed in
  D1 — the Worker received request HEADERS but the BODY never arrived.
- The stall reproduces from Electron/undici (HTTP/1.1) and curl (HTTP/2)
  alike, and only for a POST reusing a keep-alive connection that previously
  served a GET on this origin; the identical POST on a fresh connection
  completes in under a second. It is intermittent (poisoned windows of
  minutes), edge-side, and client-stack independent.
- The desktop always fetches `/api/claxedo/auth/descriptor` moments before the
  exchange, so sign-in rode exactly that warm connection and died at the 30 s
  transport timeout every time.

### Fix (committed on this branch)

- `packages/claxedo-desktop/src/main/account/electron-seams.ts`:
  `postToTokenEndpoint` now gives the first attempt a bounded stall budget,
  aborts it (destroying the poisoned socket), and retries once on a fresh
  connection inside the original overall budget. Safe against code/refresh
  replay because the aborted attempt's body never reached the authorization
  server. Regression tests in `electron-seams.test.ts`.
- Proven live at 15:06Z on a reload: one token POST `canceled` at the stall
  budget, its fresh-connection retry `200` eight seconds later, app stayed
  `signed`.

### Live state after this continuation

- Desktop OAuth sign-in completes end to end against
  `release-acc-oauthconsent-260831-182225-3851` (authorize 302 → loopback →
  exchange 200 → `signed` in 16 s), using the already-granted consent and the
  existing browser session.
- Both multiplayer-validation identities are registered for the CURRENT
  release via the operator API (`--register-multiplayer-identity-1/2`):
  owner `sha256:d8efc051…` and personal `sha256:3ff15431…`. Signed product
  reads (`/api/claxedo/bootstrap`, `/api/workspace?access=cloud`) are admitted;
  the signed UI renders workspaces with no error surface.
- Note: identity receipts are per-release. Every immutable successor needs
  both registrations replayed before signed desktop/web traffic passes the
  multiplayer gate — the earlier "stream 503 after sign-in" was exactly a
  missing receipt on a fresh release, not a stream defect.
- Revocation POSTs can still hit the edge stall (30 s, degrades to
  `uncertain`); acceptable for logout, not yet retried.
- The edge stall itself deserves an infra follow-up: consider bumping
  `compatibility_date` (currently 2025-05-01) on a future certified release
  and re-observing, and filing with Cloudflare with the request IDs recorded
  in this session (e.g. `f4dd34de1a523c74c7d380d2775dc57e`).

### UI-driven acceptance and the deeper transport truth (same day, later)

A human-driven UI test (real clicks: Log out → Sign in, system browser)
surfaced the rest of the story and passed end to end:

- The stall is not per-connection-history: during a bad window the app's
  requests produced NO Worker invocations while parallel fresh-connection
  probes returned 200 instantly. Poisoned keep-alive sockets sit in the
  client's pool and the app's own polling keeps them warm forever, so pooled
  clients never recover without a restart. It bites BROWSERS too: the user's
  Chrome hung loading /oauth2/authorize (never reached the Worker) until its
  socket pools were flushed (`chrome://net-internals/#sockets`), which makes
  this an origin-side incident class affecting real web users, not a desktop
  quirk. CF ticket material: request id `f4dd34de1a523c74c7d380d2775dc57e`,
  timelines in this doc.
- Desktop remedies, all committed with tests: stall-abort-retry in the token
  transport; a bounded stall guard for hosted reads; a 20s refresh-failure
  cool-down so serial boot operations fail fast instead of chaining stalled
  refreshes under the splash; and finally `no-reuse-fetch.ts` — core-origin
  account traffic now uses one fresh node http(s) connection per request
  (`agent: false`, explicit `Connection: close`), which removes the
  poisoned-pool class outright. Boundary ceilings raised to measured values
  after verify:closure.
- Verified live through the real UI: Log out → remote revocation CONFIRMED;
  Sign in → authorize 302 with the existing browser session (zero clicks) →
  token exchange 200 in 549 ms on the fresh-connection transport → signed,
  org reads flowing.
- Desktop builds MUST set `VITE_AUTH_ENABLED=true` or the renderer omits the
  hosted-contributions chunk and the account menu hides Sign in while
  unsigned (`bun run build` alone produces a local-only build).
- Known follow-ups: the auth-enabled renderer can mount an empty root on
  first load (a reload fixes it; reproduce and fix the mount race); signed
  bridge state reports `identity.userId` as an empty string; the worker's
  multiplayer gate maps AuthenticationError to a generic 503 instead of 401.

### Still open for "all happy flows on real Cloudflare"

- Two-user sharing through the real UI (second GitHub identity on web/mobile
  opening a shared workspace, revocation check) — needs the user.
- Multiplayer-validation evidence kinds and the `open` transition afterwards.
- Retained Convex turn adapter, producer provenance, and the other checkpoint
  P1s below remain as before.

## Why this checkpoint exists

The user asked to pause implementation, publish an honest done/pending report, and push the branch so another agent can review and continue. This document records the current code state and the adversarial review findings. It is not a release declaration.

## User requirements that remain authoritative

- Better Auth+D1 and Clerk+Convex are peer adapters. Do not remove Clerk or Convex.
- Do not add backward-compatibility fallbacks, synthesized authority data, or request-time fallback between adapters.
- Claxedo-hosted is multi-organization, multiplayer, and Polar-billed.
- A user-deployed instance uses the same tenant-safe multiplayer implementation, but exactly one organization belongs to the deploying owner and Claxedo billing is absent.
- Self-deployers bring their own authentication and OAuth credentials for now.
- WorkGraph and Documents are part of the migration, but are independent pluggable services. Disabled services must provision zero resources.
- `codex/single-tenant-multiplayer-ready` is review/reference input, not a branch to merge wholesale.
- This branch must stay rebased on current `dev` before integration.

## Branch and base

- Branch: `codex/cloudflare-multiplayer-migration`.
- Final checkpoint base: `origin/dev` at `3865ea6ac9`.
- The final rebase completed cleanly after porting the provider-neutral sandbox-auth import across an upstream route extraction.
- The dependency lock was regenerated and `bun install --frozen-lockfile` passed.
- The working tree was clean before this handoff update.

Checkpoint commits, oldest to newest:

1. `028986fddf` — grounded Cloudflare/Auth/D1/optional-service migration checkpoint.
2. `cdbe14bd43` — runtime privacy bypass hardening.
3. `3bba4c4be9` — earlier handoff snapshot.
4. `f319c9b346` — renewable private event-stream authority.
5. `95a08ee0d1` — managed client event-stream session scoping.
6. `9a704531ba` — local stream lease cap against clock skew.
7. `965cdbc034` — provider-neutral durable D1 turn authority.
8. `0182e928fb` — agent-hook, PTY, and worktree security.
9. `f0218899e8` — stream-renewal cancellation, jitter, shared TTL, and route checks.
10. `0a94030c05` — rebased lockfile refresh.

## Authoritative design and ownership

- `docs/plans/2026-08-27-147-refactor-cloudflare-d1-better-auth-cutover-plan.md` contains the full migration plan and release gates.
- `packages/claxedo-server/src/deployments/hosted-shared/deployment-profile.ts` owns static product, adapter, billing, sandbox, and optional-service posture.
- `packages/claxedo-server/src/authority/provider-neutral-hosted-services.ts` and `packages/claxedo-server/src/authority/adapters/worker/better-auth-d1-compose.ts` own hosted authority composition.
- `packages/claxedo-server-core/src/platform/auth/` owns provider-neutral authentication, private-session, runtime-actor, and turn-authority contracts.
- `packages/workspace-runtime/src/session-access-policy.ts` and `packages/workspace-runtime/src/remote-session-authority.ts` own the runtime authorization boundary.
- `packages/workspace-runtime/src/routes/session-event-privacy.ts` owns managed SSE scope and renewal.
- `packages/workspace-runtime/src/routes/session-turn-lease.ts` owns runtime-side renewable turn admission.

## Completed in this branch

### Provider and product composition

- Better Auth browser/native authentication and D1 authority implementations exist as selected adapters.
- Clerk+Convex remains present as a retained peer composition; it was not removed.
- Browser provider selection is static, and unselected provider code is excluded from the selected browser closure.
- Hosted and user-deployed product postures are explicit: hosted remains multi-org+billing; user-deployed is one-org multiplayer without Claxedo billing.

### WorkGraph and Documents

- Both have separate service packages, manifests, migrations, Workers, workflows, renderers, and lifecycle contracts.
- Core with no optional service selected has no WorkGraph/Documents binding, Durable Object, R2, migration, cron, or implementation edge.
- Installation state, fenced deployment locks, step receipts, resource ownership, and lifecycle stages are durable and service-specific.

### User-deployed owner bootstrap

- A one-time D1 owner claim stores hashes and consumption state, not the raw claim.
- Provisioning uses an exact 256-bit claim and verifies the provider subject.
- Claim consumption atomically creates the user, deployment organization, and owner membership.
- The browser owner-bootstrap surface is explicit and keeps secrets out of URLs and browser storage.

### Private sessions and clients

- Managed create/fork reserves a preassigned session ID before runtime mutation, registers the exact operation, marks ambiguity, and compensates definitive denial.
- Managed app `/global/event` and `/api/wr/events` connections now carry the canonical live `sessionID`.
- Reconnect preserves `sessionID` and `Last-Event-ID`; canonical `LiveSession` replaces stale caller query state.
- When there is no active canonical session, stale session scope is removed and the client stays on the central lifecycle stream.

### Renewable managed streams

- `/event`, `/global/event`, `/api/wr/events`, and `/api/wr/runtime-events` exchange the establishment RHT for a short renewable lease.
- Renewal uses the lease rather than retaining the RHT, rechecks durable parent RAT and membership, and closes on denial, malformed response, outage, or hard expiry.
- Local expiry is capped by the shared 15-second authority TTL to prevent clock skew from extending access.
- Renewal has bounded early-only jitter, catches synchronous policy failures, and is aborted when the client disconnects.

### Durable D1 turn admission

- `SessionTurnAuthority` is provider-neutral and has a conformance suite.
- D1 migration `0010_session_turn_leases.sql` and its adapter implement reconstruction, expiry takeover, monotonic fencing, renewal, release, and stale-owner rejection.
- Better Auth+D1 hosted composition issues renewable signed turn capabilities independent of the original RHT.
- Managed `/message` and `/prompt_async` acquire before route mutation and abort/fence runtime publication on loss.
- Managed V2 prompt fails closed with `503` because its byte proxy cannot yet fence the authoritative producer.

### Agent hooks, PTYs, and worktrees

- Agent lifecycle mutation is POST-only; GET returns `405`.
- Managed lifecycle writes require a running PTY and use runtime-recorded workspace and actor ownership.
- Terminal-child callback tokens are opaque, PTY-scoped, workspace-bound, and accepted only for the lifecycle POST route.
- Provider-native session IDs remain `providerSessionId`; unverified caller IDs never become canonical Claxedo session ownership.
- Hook logs contain coarse shape metadata only, not prompts, assistant content, transcript paths, or provider-session IDs.
- PTY metadata and operations enforce runtime-recorded ownership, with owner/admin oversight.
- Worktree list/get/create uses verified context and the selected private-session policy; the store cannot return another workspace's record.

## Verification at this checkpoint

Passing after the final rebase:

- `bun install --frozen-lockfile` — passed with no lockfile change.
- `bun turbo typecheck` — 40/40 package tasks passed; app architecture suite reported 270/270, timeline suite 21/21, and app Vitest suite 37/37.
- D1 private-session + durable-turn and runtime authority tests — 12/12.
- Provider-neutral turn contract tests — 2/2.
- Agent runtime tests — 39/39.
- Individually isolated managed stream suites:
  - workspace event wiring — 11/11;
  - runtime event authority — 9/9;
  - workspace-runtime bus stream — 10/10;
  - stream lease lifecycle — 6/6.
- The hook/worktree slice had 146/146 focused/integration tests before the final rebase; its affected package typechecks also pass after rebase.
- `git diff --check` passed before the final documentation update.

Testing caveat: a single combined Bun invocation of 13 workspace-runtime suites reported 156 passes and four managed-scope failures, while each of those four failing files passed alone. This appears to be cross-file test-process contamination, not an observed single-file behavior failure, but it should be isolated and fixed before relying on that combined lane.

Known environment caveat: direct Bun execution of the SQLite authority suite can crash in `better-sqlite3` N-API initialization; its Node Vitest lane passed previously.

## Adversarial review: live blockers

These findings are code-grounded and should be treated as release blockers, not polish.

### P1 — stale turn output can persist before the in-memory fence checks it

- `packages/agent-sdk-runtime/src/runtime.ts` checks admission only after a committing adapter yields.
- Production SDK and ACP adapters append authoritative events before yielding them.
- A lease-losing isolate can therefore append stale transcript output before the runtime refuses downstream publication.

Required direction: carry the durable fencing generation into every authoritative `startTurn`, `appendEvent`, projector, and `finishTurn` write, and atomically reject stale generations in the store itself.

### P1 — synchronous prompt releases before final checkpoint/publication

- `packages/workspace-runtime/src/routes/session-core.ts` releases the durable lease in `finally` before the final message checkpoint and assistant publication.
- A replacement turn can acquire and interleave while generation N is still committing final effects.

Required direction: hold the lease through document flush, checkpoint, final publication, and durable outcome recording; recheck the fence before every producer effect.

### P1 — terminal callback capability survives membership revocation

- PTY creation snapshots actor, workspace, and role into a PTY-lifetime callback capability.
- The lifecycle path restores that snapshot without current membership/RAT validation.
- A removed or downgraded member retains hook-write authority until the terminal exits.

Required direction: introduce a short-lived renewable terminal-capability authority operation bound to PTY ownership, current role, workspace, and parent RAT.

### P1 — viewer can change host hook installation

- `/setup` and `/setup/status` are relay-authenticated but not authorized as host administration operations.
- A workspace viewer can currently rewrite host-level hook wrappers.

Required direction: add a distinct current owner/admin host-administration authorization operation for setup and an explicit read policy for status.

### P1 — managed streams drop terminal/process/agent lifecycle state

- Managed `/api/wr/events` permits only events whose producer-owned session ID equals the selected private session.
- PTY/process events have no canonical private-session ID, and managed hook events deliberately clear caller-provided session IDs.
- The safe result is suppression, but multiplayer clients lose live terminal and agent state.

Required direction: create and persist a runtime-owned PTY/process-to-canonical-session binding at authoritative creation, then stamp all derived events from that binding. Keep provider-native agent IDs separate.

### P2 — incomplete stream teardown proof

- Renewal-denial route tests exist for two paths, but all four routes are not covered at route level.
- Existing tests prove readers close, not that the underlying subscriber is removed exactly once.

Required direction: instrument subscription counts for all four managed SSE routes, deny renewal, assert reader completion and exactly one unsubscribe, then prove later private frames are not written.

## Other required work

### Adapter parity and provenance

- Clerk+Convex has no `SessionTurnAuthority` adapter/conformance yet. Managed prompts fail closed with `503`; do not add an in-memory fallback.
- Canonical producer-signed author provenance is incomplete. D1 synchronization still derives attribution from the authenticated synchronizer and message metadata.
- SQLite needs turn authority only if it becomes a managed multiplayer deployment profile.

### User-visible multiplayer lifecycle

- Finish private participant add/remove through real browser, CLI, and desktop entrypoints.
- Prove invisibility before grant, replay filtering, reconnect denial after revocation, fork ownership, wrong-org isolation, and two-human concurrency/recovery.
- Managed Session V2 create/fork/prompt remains intentionally denied until it can use reservation and producer fencing.

### Deployment, migration, and release evidence

- The public self-deploy guide still stops honestly at a locked Worker; canary/open transition and real owner/provider-sync/multiplayer validation are incomplete.
- Run real GitHub-only and Google-only Better Auth configurations with deployer-owned credentials; password email must fail closed without a sender.
- Complete real Clerk/Convex export, conservation, transform, verify, callback drain/replay, paired D1 recovery, and retained-adapter neutralization evidence.
- Execute optional-service lifecycle drivers in a real Cloudflare account, including crash retry, fence loss, drain/revoke, retirement, and zero-resource disabled deploys.
- Run the plan's browser, CLI, desktop, Worker, relay, runtime, billing/no-billing, migration, outage/recovery, and release-workflow gates.

## Recommended continuation order

1. Independently review commits `f319c9b346` through `f0218899e8` and reproduce the five live P1 findings before changing behavior.
2. Move turn fencing into authoritative transcript/store writes and keep synchronous leases through all final effects.
3. Add renewable terminal capability authority plus owner/admin hook-install authorization.
4. Add the canonical PTY/process-to-private-session binding and restore authorized multiplayer lifecycle events.
5. Implement and conform the retained Convex turn adapter, then producer-signed author provenance.
6. Fix the combined Bun test contamination and complete all four SSE teardown assertions.
7. Only then run real Cloudflare, migration, two-user, and release gates and update the generated deployment guide through its generator.

## Wrong paths to avoid

- Do not merge `codex/single-tenant-multiplayer-ready` wholesale.
- Do not infer session ownership from request query parameters, provider hook payloads, terminal IDs, directories, or tabs.
- Do not repair a missing org/workspace/session/actor/fence with fallback or synthesized data.
- Do not switch auth/authority/product/service adapters by detecting credentials at request time.
- Do not provision WorkGraph/Documents merely because their code is present.
- Do not weaken managed V2/session/event denials to regain compatibility; move producers to the canonical lifecycle.
- Do not call the deployment open until persisted gates and real two-user evidence say it is open.

## Continuity warning

The pushed branch is the durable source. The `worktree_path` is machine-local and may not exist for another agent. The branch is intentionally broad; review it by contract boundary and commit. Re-fetch `origin/dev` before new work because `dev` moved twice during this checkpoint alone.
