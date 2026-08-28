# Validated Review Findings

## Review scope

Reviewed implementation commit: `593dd1f94f047c9269a56b2afea75cce2cb6419e`

Implementation tree: `6c42070016448f272ce8008fd9b8db98e80c9d21`

Base: `dev` at `834307041e8b01eef532833b8deb3703f03dc647`

Review coverage: correctness, project standards, testing, maintainability, agent-native behavior, security, performance, API compatibility, data migrations, reliability, adversarial analysis, and deployment verification.

Verdict: **ALL 18 VALIDATED FINDINGS CLOSED**

The primary closure is `fc2c5fc51a` (`fix(multiplayer): close tenant authority review gaps`). The follow-up hardening and parity closure is `593dd1f94f` (`fix(multiplayer): harden tenant authority contracts`). No validated security finding remains open.

## Closure matrix

| ID | Priority | Status | Implemented response | Focused evidence |
|----|----------|--------|----------------------|------------------|
| #2 | P1 | Closed | Stable users no longer drift between human and agent kinds; runtime actor id/kind is a paired contract and live token checks reject kind drift. | `convex/actor-kind.policy.test.ts`, `convex/runtime-access-tokens.policy.test.ts`, runtime actor tests |
| #3 | P1 | Closed | Creator/admin participant management now requires current workspace authority in Convex and SQLite; revocation also invalidates runtime tokens. | Convex session policy, SQLite authority policy/parity, project-membership revocation tests |
| #5 | P1 | Closed | Signed sessionless events use canonical subject/org visibility and unknown signed frames default-deny. | local-server compatibility event tests and two-user event acceptance |
| #6 | P1 | Closed | Convex and SQLite share the dependency-light canonical repository key implementation and parity corpus. | `convex/repository-key.policy.test.ts`, SQLite repository-key tests |
| #8 | P1 | Closed | Event authorization is decided once per scoped enqueue/lease path; the writer no longer repeats the same per-frame decision. | workspace-runtime event-delivery tests |
| #9 | P1 | Closed | Per-scope authorization queues are bounded; overflow disconnects for replay recovery instead of accumulating closures. | high-volume/stalled-authority event-delivery tests |
| #10 | P1 | Closed | Reconnect replay uses bounded concurrency, ordered results, cached scope decisions, and a fixed startup deadline. | replay deadline, ordering, and retained-window tests |
| #11 | P1 | Closed | Runtime authority preserves 401 invalid proof, 403 denial, and retryable 503 unavailability semantics. | remote-session-authority and compatibility error tests |
| #12 | P1 | Closed | Process-log and PTY aliases resolve through the session access policy before transcript-bearing data is returned. | workspace-runtime process-route alias tests |
| #13 | P1 | Closed | Fork registration uses the ordinary authority/projection path and compensates by deleting the child on failure. | session-core fork registration/cleanup tests |
| #14 | P1 | Closed | V1 and V2 create compensate failed registration, retain cleanup errors, and permit retry with the same id. | session-core creation failure/retry tests |
| #15 | P1 | Closed | Proxy SSE uses renewable bounded session grants and terminates on renewal denial/unavailability instead of calling authority for every delta. | workspace-runtime proxy and lease-renewal tests |
| #16 | P1 | Closed | Session project must equal the canonical workspace project; missing/conflicting authority fails closed in live writes and migrations. | Convex session policy/migration tests and hosted session-pull conflict tests |
| #18 | P1 | Closed in code | Staging and production workflow gates now run ordered tenant backfills, verification migrations, ledger assertions, and legacy-session smoke before runtime/relay enforcement. | `.github/workflows/deploy-control-plane.yml`, deployment-workflow and migration-discipline tests |
| #21 | P1 | Closed | Long-lived PTY/SSE connections renew a revocable parent-linked session lease; expiry of the establishment proof no longer disconnects an authorized client. | PTY >60-second, revocation, and renewal tests |
| #23 | P2 | Closed | Durable store lease methods are required and `AgentRuntime` is the single admission owner; runtime admission now invokes host activity only after winning the lease. | two-runtime reconstruction, collision, admission, and 492-test runtime suite |
| #24 | P2 | Closed | SQLite and Convex both honor the durable organization owner when membership rows are absent. | SQLite/Convex authority parity tests |
| #28 | P2 | Closed | Transcript sync accepts only producer-backed canonical author ids, preserves known authors, and leaves unknown history unattributed; caller identity is never substituted. | SQLite authority and Convex session attribution tests |

## Follow-up hardening completed after closure

`593dd1f94f` also closes secondary issues found while validating the original findings:

- Runtime access tokens distinguish user and service principals, record the signed role, and revalidate the user, actor kind, workspace existence, and current role in Convex and SQLite.
- Workspace shares require exactly one authoritative target, are idempotent per canonical target, revoke aliases and duplicate grants together, and use compound indexes for exact lookups.
- Service-user projection reconciles subject and token identities and fails on conflicts.
- Session pulls reject local-versus-authority org/project disagreement and require session write authority before transcript projection.
- Checkpoint and agent-config runtime requests use the authority workspace org and the caller's actual role.
- Public participant, share, and runtime-authority mutation bodies are capped at 16 KiB.
- Reconnect scopes remember replay-authorized sessions so later revocation closes the stream.
- The runtime permission mode is applied by the admitted harness turn only; the duplicate pre-session ACP write was removed.

## Rejected or reclassified candidates

| Candidate | Disposition | Reason |
|-----------|-------------|--------|
| #1 migration-generated opaque ids | Rejected | The migration is the canonical producer when tenant provenance is unambiguous |
| #4 split the session module | Rejected | File size alone did not prove a defect |
| #7 separate WorkGraph service actor | Rejected | Owner-initiated work is intentionally attributed to the owner |
| #17 revoke tokens on org deletion | Reclassified | Pre-existing risk outside the original feature diff; live workspace/role validation now covers active RAT use |
| #19 support concurrent old SQLite writers | Rejected | Supported rollout is a stopped-service hard cut |
| #20 fetch bridge lacks authority URL | Rejected after hardening | Every runtime fetch now requires an explicit principal and authoritative org/role |

## Verification summary

- `@claxedo/server`: 3,068 passed, 14 skipped.
- Convex policy suite: 397 passed.
- `@claxedo/server-core`: 484 passed.
- `@claxedo/local-server`: 227 passed.
- `@claxedo/agent-sdk-runtime`: 492 passed.
- `@claxedo/workspace-runtime`: 893 unit, 37 relay, and 59 real PTY/storage tests passed.
- Affected-package typechecks and agent runtime build passed.
- Root lint passed with 17,185 warnings and zero errors.
- Signed two-user product, runtime-transport, and relay acceptance paths passed.

The remaining real-harness E2E failures are tracked in `verification-and-rollout.md`; they are not open findings in this review matrix.
