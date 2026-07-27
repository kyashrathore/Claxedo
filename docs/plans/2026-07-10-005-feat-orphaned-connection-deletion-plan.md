# Orphaned Personal Connection Deletion

Status: Phase 1 landed; integration seam pending a member-removal path
Last updated: 2026-07-10
Prereq reading: this task originates from a finding in the (now-retired)
connection-scoping plan's adversarial review — a personal connection whose
owner subject is removed becomes undeletable, since owner-mismatch 404s
every caller and loopback callers are pinned to the team partition, so no
principal can ever match the row again.

## Problem

Connection scoping made personal connections owner-matched: management
routes 404 when `row.owner !== caller-owner`
(`packages/claxedo-connections/src/routes.ts` `visibleConnection`), and
loopback callers are pinned to the team partition
(`connections-host.ts`). When an owner subject is removed — org member
kicked, Better Auth user row deleted, Clerk user deleted from the
dashboard — its personal rows can never be matched again by ANY caller,
including the operator. The row plus its backing credential
(`integration:{connectionId}`) persist forever, and the third-party OAuth
token stays live at the provider.

## Decisions (settled 2026-07-10)

1. **Owner cascade primitive.** Deletion happens by owner, invoked when a
   subject is removed — not by a new blanket delete authority. Chosen over
   an operator escape hatch (which would widen the loopback DELETE route's
   power and rests on a deployment-topology assumption) and over an
   authority-reconciliation prune (which needs every authority backend to
   answer "is this subject active", differing sqlite vs Convex). The
   cascade grants no caller any new power over another user's row; it only
   reaps rows whose owner is gone.
2. **No provider-side revocation in v1 (accepted-risk).** `removeOwner`
   deletes the local row + credential only. The third-party token is not
   revoked; it remains valid until it expires or the user revokes it in the
   provider. This matches the existing `remove()` behavior and is written
   down here so it is a decision, not an oversight. A future `revoke?()` on
   `IntegrationImpl` can add best-effort provider revocation without
   changing this contract.

## Mechanism

`ConnectionsService.removeOwner(owner: string): Promise<number>` (kit,
`service.ts`): lists `list({ owner })`, and for each row deletes the
backing credential (`credentials.deleteByProvider(connectionProviderId(id))`)
then the row (`connections.delete(id)`), returning the count removed.

Invariants (enforced + tested):
- A string owner filter never matches team rows (`owner` absent), so the
  cascade can never touch shared connections. A defensive `row.owner !==
  owner` guard skips any row a store might over-return.
- Empty-string owner is a no-op — never a wildcard that reaps everything.
- Idempotent: a second call for the same owner removes nothing.

Reuses existing store-port primitives only (`list`, `delete`,
`deleteByProvider`); no `ConnectionStorePort` change, so the memory store
and the sqlite adapter both work unchanged.

## Integration seam (the wiring)

`removeOwner` is exposed on the connections host as
`connectionsHost.service.removeOwner(subject)`. There is **no
member/user-removal code path in the control plane today** (verified: no
`removeMember` / `deleteUser` / membership-delete anywhere in
`packages/claxedo-server/src`). So the seam is defined and ready; wiring it
is gated on such a path existing. The contract for whoever adds one:

- **Self-host (embedded Better Auth):** when a user/org member is removed,
  call `connectionsHost.service.removeOwner(subject)` with the SAME owner
  string connect-time stores — `controlPlaneAuthContext(...).user.subject`
  (the canonical owner derivation; see scoping-plan appendix finding 5).
- **Hosted (Clerk):** the `user.deleted` / `organizationMembership.deleted`
  webhook handler calls the same, mapping the Clerk subject identically.

Because the fail-safe direction for a MISSED cascade is "an orphan lingers"
(mild, reclaimable once wired) and never "a live user loses their
connection", shipping the primitive ahead of the wiring is safe.

## Phases

### Phase 1 — kit cascade primitive (LANDED)

- [x] `ConnectionsService.removeOwner(owner)` deletes an owner's rows +
      credentials; team/other-owner rows spared; empty-owner no-op;
      idempotent.
      Progress: implemented in `packages/claxedo-connections/src/service.ts`;
      test `removeOwner cascades one owner's personal rows and spares team
      + other owners` in `service.test.ts`. `bun test src/` → 41 pass;
      kit + claxedo-server `tsc --noEmit` green.

### Phase 2 — control-plane integration seam (BLOCKED on a removal path)

- [ ] When a member/user-removal path is introduced, call
      `connectionsHost.service.removeOwner(subject)` from it, using the
      canonical `controlPlaneAuthContext` subject; add an integration test
      that removing a subject reaps exactly that subject's personal
      connections and leaves team + other owners intact.
      Progress: seam exposed; no removal path exists to wire yet.
- [ ] Optional operator reconciliation (self-host only): a maintenance
      command that lists personal rows whose owner is absent from the
      sqlite `users` table and cascades them — for orphans created by
      out-of-band provider-side deletions the server never observed.
      Progress: deferred; needs authority "known subjects" enumeration.

### Phase 3 — docs

- [ ] Scoping-plan appendix finding 8b updated: primitive landed, wiring
      tracked here, provider-revocation accepted-risk recorded.
      Progress: done in this change.

## Definition of Done

- [x] `removeOwner` cannot touch team or foreign-owner rows (tested).
- [x] Kit + claxedo-server typecheck green; kit suite green.
- [ ] A member/user-removal path (when it exists) invokes the cascade with
      the canonical subject, covered by an integration test.
- [x] Provider-side non-revocation recorded as a deliberate v1 decision.

## Execution: parallelize with agents & workflows

Small surface — Phase 1 is a single-file kit change (done). Phase 2 lands
with whatever introduces member removal and should be co-owned by that
change's agent (disjoint files: the removal handler + one integration
test), not a separate parallel stream. No fan-out warranted beyond a single
verification agent re-running the kit suite + the new integration test.
