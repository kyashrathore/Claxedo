# Deferred turn grant: remote wake and recovered-prompt admission (P-92 / P-93)

Status: executing 2026-09-22. Tracker rows P-92 and P-93 in
`docs/security-audit-revalidation-2026-09-20.md`; `packages/wakes/README.md` item 10.

## Problem

On a remote-authority composition (hosted D1 control plane, or a `claxedo connect`
host against any control plane) a child-completion wake or a recovered queued
prompt reaches `admitHostTurn` (`packages/workspace-runtime/src/routes/session.ts`)
with a persisted origin (`session_subagent.origin_*`, `runtime_delivery.*`) but no
credential and no lease. `remoteWorkspaceSessionAccessPolicy`
(`packages/workspace-runtime/src/remote-session-authority.ts`, the guard at the top
of `request`) refuses `turn_acquire` without a credential or lease, so the turn
never acquires its durable lease and the wake stays `pending` forever. The
embedded self-hosted policy re-authorizes the stored origin in process and works.
Persisted actor strings are not proof and must never be sent as identity. Steer
submissions take the same persist→dispatch path and are refused the same way.

## Design: deferred turn grant

A signed, single-use, expiring proof minted by the control plane at the moment a
live request credential already proves `agent_turn` on the parent, and redeemed
later by the background turn in place of the credential it no longer has.

### Signer and shape

A new mint/verify pair on the Ed25519 key the stream and turn leases already use
(`CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM`), audience
`workspace-runtime-deferred-turn`, issuer `claxedo-control-plane`. Not a runtime
access token claim: RATs are relay credentials with a 15–60 minute TTL clamp, an
`iat` floor and channel-provenance semantics; a grant that outlives the RAT and
must never reach the relay cannot share that shape. The owner grant, SBT, document
session token, stream lease and turn lease already follow "same key, own audience,
own verifier"; the grant joins that family.

Claims (JWT, EdDSA):

| claim | value |
| --- | --- |
| `iss` / `aud` | `claxedo-control-plane` / `workspace-runtime-deferred-turn` |
| `jti` | grant row id |
| `principal_kind`, `actor_id`, `actor_kind` | the verified minting principal |
| `org_id`, `workspace_id`, `session_id` | the target (parent) session |
| `intent` | `child_completion` or `queued_prompt` |
| `subject_session_id` | child session id (`child_completion` only) |
| `turn_id` | exact turn id (`queued_prompt`: the `messageID` fixed at queue time) |
| `turn_id_prefix` | `msg_wake_<child>_` (`child_completion`; matches `wakeMessageId`) |
| `iat`, `exp` | mint time; `exp` equals the row's `expires_at` |

The runtime stores and presents it as an opaque string.

### Durable row and port

`SessionTurnAuthority` (`packages/claxedo-server-core/src/platform/auth/session-turn-authority.ts`)
gains, with the exact-inventory type forcing both adapters and
`selfHostedTurnAuthority` to change together:

- `grantSessionTurn(principal & { sessionId, workspaceId, intent, subjectSessionId?, registrationOperationId?, turnId?, ttlMs? })`
  requires `agent_turn` on `sessionId` now; for `child_completion` also requires
  the registration row `(operation_id, session_id = child, parent_session_id = sessionId, creator_actor_id = actor)`.
  Inserts `session_turn_grants`.
- `acquireSessionTurn(input & { grantId? })`: with a grant, the same statement or
  batch that inserts the lease requires the grant row to match
  `(actor_id, session_id, workspace_id)`, `expires_at > now`, `revoked_at IS NULL`,
  and either `redeemed_at IS NULL` or `redeemed_turn_id = turnId`, and the turn id
  to match `turn_id` or `turn_id_prefix`; it sets `redeemed_at, redeemed_turn_id`
  in the same batch. Parent share state is rechecked by the same
  `agent_turn` predicate request-driven turns use.
- `revokeSessionTurnGrants({ sessionId?, subjectSessionId?, reason })` sets `revoked_at`.

Table `session_turn_grants` (D1 migration `0040_session_turn_grants.sql`; SQLite in
`workspace-authority-store.ts` beside `session_turn_leases`):
`grant_id PK, session_id, workspace_id, org_id, project_id (D1), actor_id, intent, subject_session_id NULL, turn_id NULL, turn_id_prefix NULL, issued_at, expires_at, redeemed_at NULL, redeemed_turn_id NULL, revoked_at NULL, revoke_reason NULL`.
The producer row is already written by the lease insert, so actor-attributed
transcripts need nothing new.

### HTTP

`packages/claxedo-server/src/routes/runtime-session-authority.ts`:

- New action `turn_grant`: body `{ sessionId, intent, subjectSessionId?, registrationOperationId?, turnId? }`,
  proof = today's `verifySessionProof` (live RHT chain or owner grant). Mints the
  JWT with `jti = grantId`, answers `{ allowed: true, grant, expiresAt }`.
- `turn_acquire` accepts body `grant` as the proof when no bearer or lease is
  present: verify signature, audience, expiry, `session_id === request.sessionId`;
  binding `{ transport: "deferred-grant", grantId }`; `applyTurnAction` passes
  `grantId` to `acquireSessionTurn`. The minted turn lease carries
  `transport: "deferred-grant"` and `turnLeaseVerifier` accepts it so renew and
  release behave as for request-driven turns. A revoked share ends a running turn
  at the next renewal through the adapters' existing `agent_turn` recheck.

The self-hosted node and the hosted D1 worker both get it by composition; the
embedded policy mints and redeems in process for parity.

### Runtime

- `session-access-policy.ts`: relay-replayed `SessionTurnOrigin` gains `grant?: string`;
  `SessionAccessPolicy` gains `grantTurn?(…)`; `acquireTurn` input gains `grant?`.
- `remote-session-authority.ts`: the guard admits `grant`; `acquireTurn` forwards it
  in the body; `grantTurn` is the `turn_grant` action with the live credential.
- `store.ts`: `session_subagent.wake_grant TEXT` and `runtime_delivery.turn_grant TEXT`,
  written under the existing write-once origin guard, read back by
  `subagentOrigin`/`storedTurnOrigin` and `queuedPrompt`, and stripped from every
  public projection (`GET /session/:id/subagents`, `GET /session/:id/queue`).
- `session-core.ts`: mint before `admitCreated` (child id and operation id are
  known) and pass it inside `origin`; the prompt route mints `queued_prompt` with
  `turnId = body.messageID` before `queue()` or `steer()`. A mint denial on a
  remote composition fails the create with 503 and rolls the child back.
- `session.ts` `admitHostTurn`: `access.grant = relayed.grant`. A relayed origin
  without a grant stays fail-closed on remote.

Rulings applied: default TTL 24 h, env-bounded to 5 min–7 d; failed mint fails
the child create; embedded parity; share recheck at renewal is the running-turn
revocation; steer is in scope; legacy rows without a grant stay fail-closed.

## Slices (each commit green on its own)

1. **Port, adapters, conformance** — `session-turn-authority.ts` types, errors
   (`session_turn_grant_expired|redeemed|revoked|mismatch|invalid`), three methods;
   `session-turn-authority.conformance.ts` gains `exerciseSessionTurnGrantConformance`
   (grant under `send` share; redeem → lease + producer; same-turn retry → same
   lease; after release refused; other turn id refused; prefix mismatch refused;
   wrong actor refused; past expiry refused; share downgraded before redemption →
   refused with no lease and no producer; revoked before redemption → refused;
   visible to a reconstructed adapter). SQLite adapter + DDL; D1 adapter +
   migration 0040 + one D1 race test that downgrades the share inside the redeem
   batch. DoD: both conformance runs green; nothing calls the methods yet.
2. **Signed grant and HTTP** — `packages/claxedo-server/src/session/deferred-turn-grant.ts`
   (mint/verify), `turn_grant` action, `grant` on `turn_acquire`, `deferred-grant`
   transport on lease claims, embedded in-process parity. DoD: route tests for mint
   over RHT and owner grant, acquire with grant and no bearer, wrong key/audience/
   session/prefix/expiry refused, renew and release, replay after release refused,
   stream leases unaffected.
3. **Runtime store, origin shape, remote policy** — types, `remote-session-authority.ts`
   (+ test: acquire with grant and no credential sends `grant` and no
   `authorization`), `store.ts` columns and projection stripping (+ test:
   reopen round-trips the grant; subagent and queue listings never expose it),
   `delivery-owner.ts`. DoD: all additions optional; no caller sets a grant yet.
4. **Mint at creation and queue, redeem at host turn** — `session-core.ts`,
   `session.ts`. DoD: create mints and the recorded origin carries it; mint denial
   → 503 and rollback; loopback-direct never mints; wake and recovery present the
   grant; relayed origin without grant on a remote policy declines.
5. **End-to-end and docs** — `remote-child-wake-grant.test.ts` beside
   `embedded-child-wake-authority.test.ts`: real SQLite authority +
   `RuntimeSessionAuthorityRoutes` in a Hono app + a host composed with
   `remoteWorkspaceSessionAccessPolicy({ url, fetch: app.request })`; child created
   over an RHT-shaped proof → grant persisted; store closed and reopened; restarted
   host delivers the wake as the original actor with the producer row; share
   revoked before delivery → nothing delivered, still pending; expired grant
   refused; re-offer after the wake column is reset → refused as redeemed; legacy
   row without grant → refused, never the owner. Then wakes README item 10 and the
   tracker rows.
6. Optional: automatic `revokeSessionTurnGrants` on child compensation and session
   delete; UI surfacing of an expired or revoked pending wake.

## Risks

- Every `transport` switch in `runtime-session-authority.ts` must admit
  `deferred-grant`; the union type catches omissions in `verifyTurnLease` but not
  in string comparisons.
- Redemption must be in the same D1 batch as the lease insert; a read-then-update
  reopens the race P-92's D1 fix closed.
- The runtime store holds a scoped, single-use bearer capability; it must never
  appear in a session projection.
- Migration `0040` is the next number as of this plan; another lane may take it.
