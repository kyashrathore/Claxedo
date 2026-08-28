# Single-Tenant to Multiplayer-Ready Branch Status

Status: **REVIEW FINDINGS CLOSED — REAL HARNESS PASSED; 2 COMPOSER UNIT FAILURES REMAIN**

Last updated: 2026-08-28

Branch: `codex/single-tenant-multiplayer-ready`

Authority closure head: `2adbe6ca4c22cf24252581e498e037782c9fcec5`

Post-review implementation: `430fa0bc1dfd7cfb0db39f742e786c2c880a7ca9`

Browser-test follow-up: `9bf5849c418597ba10f222e3ce990dd39c508445`

Base: `dev` at `834307041e8b01eef532833b8deb3703f03dc647`

Implementation diff through `9bf5849c41`: 300 files, 19,038 insertions, 1,469 deletions

## Executive summary

All 18 validated review findings are closed in `fc2c5fc51a`,
`593dd1f94f`, and the final authority audit `2adbe6ca4c`. The branch has
canonical tenant and actor identity, current-role runtime-token validation,
private-session participant authority, bounded renewable event authorization,
durable prompt admission, backend parity, and an enforced deployment migration
gate.

The two real-provider failures found after that review are also fixed through
the authoritative runtime-to-UI path in `430fa0bc1d`:

- central session placement and cache authority now remain explicit through
  direct routing and hydration, and the composer waits for the saved Pi model;
- terminal subagent lifecycle is retained for replay, snapshot/live message
  merge preserves task parts, and Codex ACP task cards render the canonical
  child completion.

The complete local real-harness lane now passes: 14 passed, 1 recording-only
test skipped. The complete two-mode core browser matrix had one strict-locator
failure after every product assertion passed; `9bf5849c41` makes the locator
unambiguous and the exact failed journey passes in both auth modes.

The branch is still not marked merge-ready because the full app unit command
has two existing composer contract failures, unchanged by this follow-up:
runtime-to-UI follow-up:

- persisted harness variant is replaced by the generic provider/model on an
  existing-session follow-up;
- unchanged existing-session config sends a second PATCH instead of hitting the
  dedupe.

Live-provider, packaged desktop, public-web, and credentialed deployment lanes
remain environment-limited as recorded in `verification-and-rollout.md`.

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
| [verification-and-rollout.md](verification-and-rollout.md) | Verification results, remaining unit gates, rollout, and rollback |
| [continuation.md](continuation.md) | Pointer-first handoff for a fresh agent, including exact remaining failures and next checks |

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
| Complete real-provider browser lane | Passed locally | 14 passed, 1 recording-only skip |
| Runtime-to-UI central continuity | Closed | `430fa0bc1d` and focused unit/real-harness evidence |
| Full app unit command | Follow-up required | 5,695 passed, 2 composer contract failures |

## Readiness rule

The original review is complete: no P1 or P2 finding remains open, and the
real-provider follow-up is green. Merge should wait for the two composer unit
contracts to be fixed or explicitly waived and for `bun run test` in
`packages/claxedo-app` to pass. Deployment additionally requires the
credentialed staging migration rehearsal and legacy-session smoke described in
`verification-and-rollout.md`.
