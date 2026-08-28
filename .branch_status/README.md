# Single-Tenant to Multiplayer-Ready Branch Status

Status: **REVIEW FINDINGS CLOSED — E2E FOLLOW-UP REQUIRED**

Last updated: 2026-08-28

Branch: `codex/single-tenant-multiplayer-ready`

Implementation commit: `593dd1f94f047c9269a56b2afea75cce2cb6419e`

Base: `dev` at `834307041e8b01eef532833b8deb3703f03dc647`

Diff: 265 files, 17,875 insertions, 1,302 deletions

## Executive summary

All 18 validated review findings are closed in `fc2c5fc51a` and `593dd1f94f`. The branch now has canonical tenant and actor identity, current-role runtime-token validation, private-session participant authority, bounded renewable event authorization, durable prompt admission, backend parity, and an enforced deployment migration gate.

The security and authority review is clear, and all affected package suites pass. The branch is not marked fully merge-ready because the complete real-provider browser lane still exposes two product/harness lifecycle failures outside the reviewed authority changes:

- Pi receives the correct canonical model from both session metadata and control-plane config, but the app picker hydrates with an empty model.
- Codex ACP reaches the scripted tool and enters `Working`, but its external child lifecycle never reaches `Completed` within the 90-second acceptance window.

The Claude ACP failure discovered during verification was fixed by removing a duplicate pre-turn permission-mode write; Claude ACP now passes. Live-provider, packaged desktop, and public-web lanes remain environment-blocked as recorded in `verification-and-rollout.md`.

## Documents

| Document | Purpose |
|----------|---------|
| [status.json](status.json) | Machine-readable branch state and artifact manifest |
| [product-requirements.md](product-requirements.md) | Product requirements, constraints, acceptance criteria, and metrics |
| [architecture.md](architecture.md) | Architecture, authoritative owners, data flows, and invariants |
| [user-journeys.md](user-journeys.md) | Human, collaborator, administrator, and failure/recovery journeys |
| [decisions.md](decisions.md) | Settled product and technical decisions |
| [change-inventory.md](change-inventory.md) | Package-level change map |
| [review-findings.md](review-findings.md) | Stable finding ids, closure commits, and verification evidence |
| [verification-and-rollout.md](verification-and-rollout.md) | Verification results, remaining E2E gaps, rollout, and rollback |

## Capability scorecard

| Capability | State | Evidence |
|------------|-------|----------|
| Explicit tenant and actor identity | Closed | #2, #6, #16, #28 |
| Atomic prompt admission | Closed | #23 plus two-runtime tests |
| Private-session HTTP authorization | Closed | #3, #12, #13, #14, #24 |
| Live, replay, reconnect authorization | Closed | #5, #8-#11, #15 |
| Long-lived PTY authorization | Closed | #21 renewable lease and revocation tests |
| Runtime-token role and principal integrity | Closed | live Convex/SQLite role validation and user/service discrimination |
| Schema and deployment migration | Closed in code | #18 workflow gate and migration-policy tests |
| OpenCode compatibility | Closed for reviewed behavior | 503 semantics and browser matrix |
| Two-user proof | Closed locally | signed transport, runtime transport, and product acceptance tests |
| Complete real-provider browser lane | Follow-up required | Pi hydration and Codex ACP completion lifecycle |

## Readiness rule

The original review is complete: no P1 or P2 finding remains open. Merge should wait for an owner decision on the two real-provider failures, or for those failures to be fixed and the full real-harness lane rerun. Deployment additionally requires the credentialed staging migration rehearsal and legacy-session smoke described in `verification-and-rollout.md`.
