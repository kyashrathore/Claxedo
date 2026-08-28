---
artifact_contract: "ce-handoff/v1"
created_at: "2026-08-28T06:01:00Z"
title: "Cloudflare multiplayer migration implementation handoff"
summary: "Rebased, pushed implementation state for provider-neutral Better Auth/D1 plus retained Clerk/Convex, one-org self-deploy multiplayer, optional services, and the remaining release blockers."
keywords: ["cloudflare", "better-auth", "d1", "convex", "multiplayer", "private-sessions", "handoff"]
cwd: "/private/tmp/claxedo-boundary-base/.worktrees/codex/cloudflare-multiplayer-migration"
resume_focus: "Close the remaining multiplayer privacy, durable coordination, real-entry migration, and release gates without backward-compatibility fallbacks."
repository: "Claxedo"
repo_root_sha: "728cedf2a29e2f9da901c8c36620ce5efc09e6b2"
branch: "codex/cloudflare-multiplayer-migration"
head: "d8dd5b0aea287299c47bc8619a9f1b8b5a629891"
worktree_path: "/private/tmp/claxedo-boundary-base/.worktrees/codex/cloudflare-multiplayer-migration"
---

# Cloudflare multiplayer migration handoff

## User intent and fixed decisions

The user asked for an end-to-end, code-grounded migration—not a plan-only exercise—and then requested this pause, report, and push for another agent to review and continue.

The following decisions came directly from the user and should be treated as requirements:

- Better Auth and D1 become peer adapters; Clerk and Convex remain supported adapters. Do not remove them.
- No backward-compatibility fallbacks or synthesized authority data.
- Claxedo-hosted is multi-organization, multiplayer, and Polar-billed.
- A user-deployed instance uses the same tenant-safe multiplayer implementation but permits exactly one organization owned by the deploying administrator and contains no Claxedo billing.
- Self-deployers bring their own authentication/OAuth credentials for now.
- WorkGraph and Documents are included in the migration but are independent, pluggable services. When disabled, core provisioning must create no resources for them.
- `codex/single-tenant-multiplayer-ready` is review/reference input, not a branch to merge blindly.
- `codex/cloudflare-multiplayer-migration` had to be rebased on current `dev` before continuing.

## Base and branch state

- A fresh fetch established that `origin/dev` is `834307041e8b01eef532833b8deb3703f03dc647`.
- `git merge-base HEAD origin/dev` matched that exact commit; the requested `git rebase origin/dev` completed as an up-to-date no-op.
- The large grounded migration checkpoint is `029176f36b`.
- The runtime/privacy hardening implementation is `d8dd5b0aea`.
- Before this report commit, the branch was 0 behind and 9 commits ahead of `origin/dev`.

Do not merge the old multiplayer branch wholesale. Re-audit any useful code against the current contracts and tests.

## Authoritative design and scope

- `docs/plans/2026-08-27-147-refactor-cloudflare-d1-better-auth-cutover-plan.md` is the detailed migration and acceptance plan. Its release gates are intentionally stricter than the current implementation.
- `packages/claxedo-server/src/deployments/hosted-shared/deployment-profile.ts` owns the static product/adapter/sandbox axes and the certified product posture.
- `packages/claxedo-server/src/authority/provider-neutral-hosted-services.ts` and `packages/claxedo-server/src/authority/adapters/worker/better-auth-d1-compose.ts` are the provider-neutral composition boundaries.
- `packages/claxedo-server-core/src/platform/auth/authentication.ts`, `private-session-authority.ts`, and `runtime-actor.ts` are the provider-neutral auth/session contracts.
- `packages/workspace-runtime/src/session-access-policy.ts` and `remote-session-authority.ts` are the runtime authorization boundary.
- `packages/workspace-runtime/src/session-route-inventory.guard.test.ts` is now the source-derived drift gate for sensitive runtime routes.

## Implemented and verified

### Auth and control-plane adapters

- Better Auth request authentication, browser cookie flow, native OAuth clients, and D1 foundation are implemented under `packages/claxedo-server/src/platform/auth/`.
- Browser builds select Better Auth or Clerk statically; unselected provider code is guarded out of the selected closure under `packages/claxedo-app/src/platform/auth/` and `vite.browser-auth.ts`.
- D1 implementations cover core workspace/identity, private sessions, host access, runtime channels, extensions, audit, and relay target concerns under `packages/claxedo-server/src/authority/adapters/d1/`.
- The retained Clerk/Convex composition remains present and now supplies the same private/runtime session contracts.
- SQLite has the canonical private-session implementation and conformance tests; the obsolete duplicate inline session implementation was removed.

### Product posture and optional services

- User-deployed core is one-org multiplayer and statically excludes billing/Polar.
- Claxedo-hosted retains multi-org and billing composition.
- WorkGraph and Documents have separate packages, migrations, manifests, Workers, renderers, and deployment workflows:
  - `packages/claxedo-workgraph-service/`
  - `packages/claxedo-documents-service/`
  - `.github/workflows/deploy-workgraph-service.yml`
  - `.github/workflows/deploy-documents-service.yml`
- Core’s empty optional-service selection has no WorkGraph/Documents binding, DO, R2, migration, cron, or implementation edge.
- `packages/claxedo-server/src/platform/services/` now contains durable D1 installation state, a deployment-wide fenced lock, exact step receipts, Cloudflare resource ownership, and lifecycle coordination. Disabled services remain zero-resource; enabled services use independent provision/migrate/dark-deploy/bind/drain/revoke/retire stages.
- The production lifecycle driver deliberately requires the canonical service owner to provide real drain/revoke and management RPCs; it does not invent “zero in-flight” results.

### One-time user-deployed owner

- D1 migration `packages/claxedo-server/migrations/control-plane/0008_user_deployed_owner_bootstrap.sql` stores only claim/identity hashes and consumption state.
- `packages/claxedo-server/scripts/deploy/provision-user-deployed-owner-claim.ts` generates or reads an exact 256-bit mode-0600 claim, pins the verified provider subject, provisions or CAS-rotates the remote D1 row, and verifies it.
- D1 consumes claim + user + actor + deployment org + owner membership in one guarded transaction.
- `POST /api/claxedo/auth/bootstrap-owner` is mounted only for the user-deployed product. Authentication verifies the principal; the selected authority consumes the claim.
- `packages/claxedo-app/src/app/routes/bootstrap-owner.tsx` is the explicit browser-only operator surface. It displays the verified provider user ID and keeps claim/journey/operation secrets out of URLs and storage.

### Private-session create/fork lifecycle

- Managed create/fork uses preassigned session IDs, one operation ID, reserve-before-runtime, exact registration, ambiguity marking, and definitive-denial compensation.
- OpenCode and ACP adapter contracts accept the preassigned fork child ID.
- App create/fork calls use `packages/claxedo-app/src/platform/runtime/private-session-reservation.ts`.
- Hosted core mounts reservation and runtime-authority routes and requires both ports at boot.
- SDK generation includes create/fork IDs.

### Runtime multiplayer privacy hardening

The adversarial route audit found multiple release-blocking bypasses. Commit `d8dd5b0aea` closes these coherent slices:

- Removed the raw `/session/status` handler that shadowed the filtered canonical route.
- Added `packages/workspace-runtime/src/routes/session-v2-proxy.ts`: every V2 session path authorizes or filters through the private policy; managed V2 create/fork is denied before mutation because that protocol cannot yet compensate safely.
- Added `session-event-privacy.ts`: managed `/event`, `/global/event`, `/api/wr/events`, and `/api/wr/runtime-events` require verified session scope and filter replay/live frames.
- PTYs bind the verified creator actor in canonical runtime state. Editors cannot list/read/update/delete/connect to another editor’s PTY; admins/owners retain workspace administration.
- Raw `pty_id`/`terminal_id` process logs enforce that PTY owner; canonical managed process IDs/names remain workspace-owned.
- Viewer relay tokens can no longer mutate shell/files, Git sources, or checkpoints.
- Remote host-capability routes fail closed when the authorization policy is unavailable; local/no-relay behavior remains unchanged.

## Verification completed

Passing checks on the final implementation state before this report:

- `packages/claxedo-app`: full `bun run typecheck` passed, including 268 architecture tests, TypeScript build, E2E typecheck, and performance tests.
- App owner bootstrap tests: 2/2 passed.
- `packages/claxedo-server`: full `bun run typecheck` passed.
- Hosted auth-profile/core tests: 15/15 passed.
- `packages/workspace-runtime`: typecheck passed.
- Combined new runtime privacy/capability suites: 81/81 passed.
- Earlier focused suites passed for D1/Convex/SQLite private sessions, hosted composition, Better Auth/D1 release tooling, owner claim provisioning, optional-service lifecycle, WorkGraph, Documents, app session reservation, OpenCode fork IDs, and SDK generation.
- `git diff --check` passed before commits.

Known verification caveats:

- `packages/workspace-runtime/src/workspace/runtime.test.ts` currently has 89 passes and one fixture failure: the workspace-isolation test’s cast adapter omits `getSession`, while the canonical create route now reads a caller-supplied session ID before mutation. Treat this as an unfinished test/contract decision, not a release pass.
- Running the SQLite authority suite directly under Bun 1.3.14 crashes in `better-sqlite3` N-API initialization. The same 20-test suite passed through Node Vitest. Keep the Node lane unless the Bun/native dependency is repaired.
- No real Cloudflare account deployment, custom-domain browser flow, live provider callback, D1 restore rehearsal, or two-human production relay run was performed in this session.

## Release blockers and unfinished work

These are not optional polish; they are why the implementation goal remains incomplete.

### P0: client/runtime integration

1. The managed app must append `sessionID` to its real `/global/event` and `/api/wr/events` connections. The server now correctly returns 400 to unscoped managed streams; the current client URLs have not caught up.
2. PTY/process events are suppressed in managed streams until their event producers carry canonical session ownership. Do not infer ownership from a caller parameter.
3. Managed Session V2 create/fork is intentionally denied. WorkGraph or any remaining V2 producer must switch to the canonical reservation lifecycle or the V2 protocol must gain reserve/register/compensating-delete semantics.
4. Agent-hook lifecycle writes and terminal metadata reads still need actor/session authorization. GET must not remain state-mutating.
5. Worktree list/get/create needs session policy. WorkGraph tool contribution binding must prove the caller owns the session it binds.

### P0: durable multiplayer semantics

6. Turn admission is still process-local. Implement a durable reconstructed-session lease and prove exactly one concurrent prompt across isolates/restarts.
7. Verified author provenance is computed but is not yet consumed by all prompt/message producers and sync events.
8. Long-lived SSE/WebSocket grants do not reverify after establishment. Implement renewable authorization, close streams/PTY on revocation, and prove the >60-second/reconnect cases.
9. Finish private participant lifecycle through real browser/CLI/desktop entrypoints, including add/remove, invisibility before grant, replay filtering, reconnect denial, and fork ownership.

### P0: deployment and migration evidence

10. The generated public guide in `public-docs/user-deployed-cloudflare.md` honestly stops at a locked Worker. A canary-capable browser artifact, real owner journey, provider-sync, multiplayer-validation harness, and open transition are not complete.
11. Update the guide generator—not the generated Markdown by hand—when the owner bootstrap/canary flow is fully wired, then run `docs:user-cloudflare:write` and `docs:user-cloudflare:check`.
12. Run a real Better Auth social sign-in using operator-owned GitHub-only and Google-only configurations; email-password must fail closed without a sender.
13. Complete source export/conservation/transform/verify for real Clerk/Convex production cardinality, paired D1 recovery, provider callback drain/replay, and retained-adapter neutralization. No request-time fallback is allowed.
14. Prove the retained Convex deployment’s core-only closure or produce the approved archive/deactivation evidence for old WorkGraph/wakes data/functions.
15. Execute the optional-service drivers against a real Cloudflare account, including crash retry, fence loss, drain/revoke, guarded retirement, and zero resources in a fresh disabled core deploy.

### Required final gates

16. Run the two-user, wrong-org, privacy, concurrency, outage/recovery, browser, CLI, desktop, Worker, relay, runtime, migration, billing/no-billing, and release workflow gates listed in the plan.
17. Re-fetch/rebase `origin/dev` again before final integration if dev moves after this handoff.

## Recommended review order

1. Review `d8dd5b0aea` first because it changes security boundaries and intentionally turns previous permissive behavior into managed-mode denials.
2. Review the provider-neutral contracts and composition, then each D1/Convex/SQLite implementation against their conformance tests.
3. Review generated deployment closure and optional-service zero-resource assertions before reviewing workflow ergonomics.
4. Fix the real managed event URLs and run one production-shaped two-user harness before expanding to the remaining durable coordination work.
5. Keep the locked guide honest until every irreversible phase has executable evidence.

## Wrong paths to avoid

- Do not merge `codex/single-tenant-multiplayer-ready` wholesale.
- Do not repair a missing canonical org/workspace/session/actor value with a default, fallback, synthesized event, or caller claim.
- Do not make user-deployed “single tenant” by removing org IDs or tenant predicates.
- Do not select adapters/products/services by discovering credentials at runtime.
- Do not provision WorkGraph/Documents resources merely because their code exists.
- Do not make the guide say “open” because a Worker deployed successfully; the persisted release gates and real two-user evidence decide that.
- Do not weaken managed V2/session/event denials to regain compatibility. Move the caller to the canonical lifecycle.

## Continuity warning

The branch is intentionally large: the checkpoint spans auth, authority, deployment tooling, product closure, optional services, clients, runtime, and generated docs. Review by contract boundary and commit, not as one undifferentiated diff. The pushed branch is the durable source; the worktree path in frontmatter is machine-local and may not exist for the next agent.
