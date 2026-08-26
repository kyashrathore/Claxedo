# Single-Tenant to Multiplayer-Ready Branch Status

Status: **NOT READY TO MERGE**

Last updated: 2026-08-27

Branch: `codex/single-tenant-multiplayer-ready`

Implementation commit: `c97d1fe3cefed0f6aeb9da1e0f38bc6b4b308924`

Base: `codex/claxedo-platform-release-hardening` at `866feaabe2fa1f80f51aa05d7788626ae7a3bf5b`

Diff: 209 files, 12,392 insertions, 891 deletions

## Executive summary

This branch converts Claxedo's single-user session assumptions into a tenant-aware, multiplayer-ready model. It adds explicit organization, project, workspace, and actor identity; private-session authority; participant management; atomic prompt admission; message attribution; and identity-aware live and replay delivery. It preserves OpenCode as the external compatibility boundary.

The implementation has the intended foundation, but the validated review found 15 P1 and 3 P2 defects. The branch must not merge or deploy until the tenant/event leaks, session lifecycle gaps, long-lived stream authorization, backend identity drift, and migration gate are resolved.

## Documents

| Document | Purpose |
|----------|---------|
| [status.json](status.json) | Machine-readable branch state and artifact manifest |
| [product-requirements.md](product-requirements.md) | Product requirements, constraints, acceptance criteria, and metrics |
| [architecture.md](architecture.md) | Current and target architecture, authoritative owners, data flows, and invariants |
| [user-journeys.md](user-journeys.md) | Human, collaborator, administrator, and failure/recovery journeys |
| [decisions.md](decisions.md) | Settled product and technical decisions plus unresolved design gates |
| [change-inventory.md](change-inventory.md) | Package-level map of the 209 changed files and their responsibilities |
| [review-findings.md](review-findings.md) | Complete validated findings, rejected candidates, residual risks, and fix order |
| [verification-and-rollout.md](verification-and-rollout.md) | Pre-merge tests, schema rollout, deployment, observability, and rollback |

## Capability scorecard

| Capability | State | Blocking findings |
|------------|-------|-------------------|
| Explicit tenant and actor identity | Partial | #2, #6, #16 |
| Atomic prompt admission | Partial | #23 |
| Message attribution | Partial | #28 |
| Private-session HTTP authorization | Partial | #3, #12, #13, #14, #24 |
| Live, replay, and reconnect authorization | Partial | #5, #8, #9, #10, #11, #15 |
| Long-lived PTY authorization | Broken after about 60 seconds | #21 |
| Schema and deployment migration | Not release-gated | #16, #18 |
| OpenCode compatibility | Present, with outage-status regression | #11 |
| Two-user proof | Focused tests exist; deployed proof missing | #18 and rollout gaps |

## Required order of work

1. Close tenant and transcript leaks: #5, #12, #3.
2. Make session create and fork atomic: #13, #14.
3. Define one renewable, bounded stream authorization model: #8, #9, #10, #11, #15, #21.
4. Stabilize canonical identity and backend parity: #2, #6, #16, #24, #28.
5. Make turn admission durable: #23.
6. Add the deployment migration and verification gate: #18.
7. Run the complete two-user, revocation, reconnect, and rollback matrix.

## Source documents retained in the branch

- `docs/plans/2026-08-01-002-refactor-single-tenant-today-multiplayer-ready-plan.md`
- `docs/tech-docs/access-model.md`
- `docs/tech-docs/tenant-identity-schema-rollout.md`

These `.branch_status` files summarize the live branch and its review. The original plan and technical documents remain the historical design record.

## Update protocol

When a finding is fixed:

1. Keep its stable number from `review-findings.md`.
2. Add the fixing commit and verification evidence to that row.
3. Update `status.json` counts and status.
4. Update the capability scorecard if the fix changes readiness.
5. Do not mark the branch ready until all P1 findings and the release gate are closed.
