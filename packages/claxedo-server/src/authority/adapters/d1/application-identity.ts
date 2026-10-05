import type { D1Database } from "@cloudflare/workers-types"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { ApplicationIdentityResolution, AuthIdentity } from "@claxedo/server-core/platform/auth/authentication"
import { activeGuard, batchUnder, may, type BoundSql } from "./authorization"
import { ownerMembershipStatements, type D1AccessContext } from "./access-context"
import { prepareInvitationAdmission } from "./org-invitation-authority"
import { guardedBatch, D1WorkspaceAuthorityError } from "./workspace-authority-error"
import { requireBootstrapClaim, sameIdentity, userDeployedOwnerBootstrapClaimHash, userDeployedOwnerIdentityHash, validateIdentity } from "./owner-identity"
import type { D1AuthorityProductPolicy } from "./workspace-authority"

export const D1_APPLICATION_IDENTITY_METHODS = [
  "ensureApplicationIdentity",
  "admitInvitedIdentity",
  "claimUserDeployedOwner",
  "linkApplicationIdentity",
] as const satisfies readonly (keyof D1ApplicationIdentityAuthority)[]

type IdentityRow = {
  user_id: string
  user_state: "active" | "suspended" | "deleted"
  actor_id: string | null
  actor_state: "active" | "suspended" | "revoked" | null
  unlinked_at: number | null
}

/** Maps verified sign-in identities to this deployment's canonical users and human actors under the product's admission policy. */
export class D1ApplicationIdentityAuthority {
  constructor(
    private readonly context: D1AccessContext,
    private readonly product: D1AuthorityProductPolicy,
  ) {}

  /** Adapter-neutral resolver wired into the selected auth adapter. */
  async ensureApplicationIdentity(identity: AuthIdentity): Promise<ApplicationIdentityResolution> {
    validateIdentity(identity)
    const { database, deploymentId } = this.context
    const candidate = {
      userId: this.context.randomId("usr"),
      actorId: this.context.randomId("act"),
      orgId: this.context.randomId("org"),
    }
    const now = this.context.now()

    if (this.product.kind === "claxedo-hosted") {
      await database.batch([
        insertIdentity(database, identity, candidate.userId, now),
        insertMappedUser(database, identity, candidate.userId, now),
        insertHumanActor(database, identity, candidate.actorId, now),
        database
          .prepare(
            `
          insert into orgs (org_id, name, kind, owner_user_id, deployment_id, created_at, updated_at)
          select ?, 'Personal', 'personal', ai.user_id, null, ?, ?
          from auth_identities ai join users u on u.user_id = ai.user_id and u.state = 'active'
          where ai.adapter = ? and ai.issuer = ? and ai.subject = ? and ai.unlinked_at is null
            and not exists (
              select 1 from orgs o
              left join org_memberships m
                on m.org_id = o.org_id and m.user_id = ai.user_id and m.revoked_at is null
              where o.deleted_at is null and (o.owner_user_id = ai.user_id or m.user_id is not null)
            )
          on conflict do nothing
        `,
          )
          .bind(candidate.orgId, now, now, identity.adapter, identity.issuer, identity.subject),
        ...ownerMembershipStatements(this.context, {
          owners: {
            sql: `select o.org_id, ai.user_id from auth_identities ai
              join orgs o on o.owner_user_id = ai.user_id and o.kind = 'personal' and o.deleted_at is null
              where ai.adapter = ? and ai.issuer = ? and ai.subject = ? and ai.unlinked_at is null`,
            bind: [identity.adapter, identity.issuer, identity.subject],
          },
          now,
        }),
      ])
      return await identityResolution(database, identity)
    }

    const existing = await identityResolution(database, identity)
    if (!this.product.ownerIdentity) return existing
    if (!sameIdentity(identity, this.product.ownerIdentity)) {
      if (existing.state !== "unavailable") return existing
      return { state: "provisioning", retryAfterMs: 5_000 }
    }
    if (existing.state === "suspended" || existing.state === "deleted") return existing

    const org = this.product.organization
    if (existing.state === "active" && await may(database, existing, "member", { kind: "org", orgId: org.id })) return existing
    await database.batch([
      insertIdentity(database, identity, candidate.userId, now),
      insertMappedUser(database, identity, candidate.userId, now),
      insertHumanActor(database, identity, candidate.actorId, now),
      database
        .prepare(
          `
        insert into orgs (org_id, name, kind, owner_user_id, deployment_id, created_at, updated_at)
        select ?, ?, 'deployment', ai.user_id, ?, ?, ?
        from auth_identities ai
        where ai.adapter = ? and ai.issuer = ? and ai.subject = ? and ai.unlinked_at is null
        on conflict do nothing
      `,
        )
        .bind(
          org.id,
          org.name,
          deploymentId,
          now,
          now,
          identity.adapter,
          identity.issuer,
          identity.subject,
        ),
      ...ownerMembershipStatements(this.context, {
        owners: {
          sql: `select o.org_id, ai.user_id from auth_identities ai
            join orgs o on o.org_id = ? and o.kind = 'deployment' and o.deployment_id = ? and o.deleted_at is null
            where ai.adapter = ? and ai.issuer = ? and ai.subject = ? and ai.unlinked_at is null`,
          bind: [org.id, deploymentId, identity.adapter, identity.issuer, identity.subject],
        },
        now,
      }),
    ])
    const resolution = await identityResolution(database, identity)
    if (resolution.state !== "active" || !(await may(database, resolution, "member", { kind: "org", orgId: org.id }))) {
      return { state: "unavailable" }
    }
    return resolution
  }

  /**
   * A user-deployed instance admits anyone but its owner only while an
   * invitation to their verified email is pending, so a stranger who signs in
   * stays unavailable. Membership still waits for the accept.
   */
  async admitInvitedIdentity(identity: AuthIdentity, verifiedEmail: string): Promise<ApplicationIdentityResolution> {
    validateIdentity(identity)
    const { database } = this.context
    const existing = await identityResolution(database, identity)
    if (this.product.kind !== "user-deployed" || existing.state !== "unavailable") return existing
    const now = this.context.now()
    const admission = await prepareInvitationAdmission(this.context, {
      orgId: this.product.organization.id,
      email: verifiedEmail,
      now,
    })
    if (!admission) return existing
    const userId = this.context.randomId("usr")
    await database.batch([
      insertIdentity(database, identity, userId, now, admission.guard),
      insertMappedUser(database, identity, userId, now),
      insertHumanActor(database, identity, this.context.randomId("act"), now),
      admission.recordUser(userId),
    ])
    return await identityResolution(database, identity)
  }

  /**
   * Atomically consumes one deployment-bound claim while creating the only
   * bootstrap owner, canonical actor, deployment organization, and membership.
   * A failed/expired/replayed claim aborts the entire D1 batch.
   */
  async claimUserDeployedOwner(identity: AuthIdentity, claim: string): Promise<ApplicationIdentityResolution> {
    if (this.product.kind !== "user-deployed" || this.product.ownerBootstrap !== "one-use-claim") {
      throw new D1WorkspaceAuthorityError("organization_policy_denied", "Bootstrap owner claims are disabled")
    }
    validateIdentity(identity)
    const { database, deploymentId } = this.context
    const normalizedClaim = requireBootstrapClaim(claim)
    const claimHash = await userDeployedOwnerBootstrapClaimHash(normalizedClaim)
    const identityHash = await userDeployedOwnerIdentityHash(identity)
    const existing = await identityResolution(database, identity)
    if (existing.state !== "unavailable") return existing

    const now = this.context.now()
    const userId = this.context.randomId("usr")
    const actorId = this.context.randomId("act")
    const assertionId = this.context.randomId("assert")
    const org = this.product.organization
    const claimGuard = `exists (
      select 1 from user_deployed_owner_bootstrap_claims claim
      where claim.deployment_id = ? and claim.claim_hash = ? and claim.admitted_identity_hash = ?
        and claim.consumed_at is null and claim.expires_at > ?
    )`

    await guardedBatch(
      database,
      [
        database
          .prepare(
            `
        insert into auth_identities (adapter, issuer, subject, user_id, linked_at, unlinked_at)
        select ?, ?, ?, ?, ?, null
        where ${claimGuard}
          and not exists (select 1 from orgs where deployment_id = ? and deleted_at is null)
        on conflict (adapter, issuer, subject) do nothing
      `,
          )
          .bind(
            identity.adapter,
            identity.issuer,
            identity.subject,
            userId,
            now,
            deploymentId,
            claimHash,
            identityHash,
            now,
            deploymentId,
          ),
        insertMappedUser(database, identity, userId, now),
        insertHumanActor(database, identity, actorId, now),
        database
          .prepare(
            `
        insert into orgs (org_id, name, kind, owner_user_id, deployment_id, created_at, updated_at, deleted_at)
        select ?, ?, 'deployment', ai.user_id, ?, ?, ?, null
        from auth_identities ai
        where ai.adapter = ? and ai.issuer = ? and ai.subject = ? and ai.user_id = ? and ai.unlinked_at is null
          and ${claimGuard}
        on conflict do nothing
      `,
          )
          .bind(
            org.id,
            org.name,
            deploymentId,
            now,
            now,
            identity.adapter,
            identity.issuer,
            identity.subject,
            userId,
            deploymentId,
            claimHash,
            identityHash,
            now,
          ),
        ...ownerMembershipStatements(this.context, {
          owners: {
            sql: `select o.org_id, o.owner_user_id as user_id from orgs o
              where o.org_id = ? and o.deployment_id = ? and o.owner_user_id = ? and o.deleted_at is null`,
            bind: [org.id, deploymentId, userId],
          },
          now,
        }),
        database
          .prepare(
            `
        update user_deployed_owner_bootstrap_claims
        set consumed_at = ?, consumed_adapter = ?, consumed_issuer = ?, consumed_subject = ?
        where deployment_id = ? and claim_hash = ? and admitted_identity_hash = ?
          and consumed_at is null and expires_at > ?
          and exists (
            select 1 from auth_identities ai
            join orgs o on o.owner_user_id = ai.user_id and o.deployment_id = ? and o.deleted_at is null
            join org_memberships membership
              on membership.org_id = o.org_id and membership.user_id = ai.user_id
              and membership.role = 'owner' and membership.revoked_at is null
            where ai.adapter = ? and ai.issuer = ? and ai.subject = ? and ai.user_id = ? and ai.unlinked_at is null
          )
      `,
          )
          .bind(
            now,
            identity.adapter,
            identity.issuer,
            identity.subject,
            deploymentId,
            claimHash,
            identityHash,
            now,
            deploymentId,
            identity.adapter,
            identity.issuer,
            identity.subject,
            userId,
          ),
        database
          .prepare(
            `
        insert into authority_batch_assertions (assertion_id, passed)
        values (?, case when exists (
          select 1 from user_deployed_owner_bootstrap_claims claim
          join auth_identities ai
            on ai.adapter = claim.consumed_adapter and ai.issuer = claim.consumed_issuer
            and ai.subject = claim.consumed_subject and ai.unlinked_at is null
          join orgs o on o.owner_user_id = ai.user_id and o.deployment_id = claim.deployment_id and o.deleted_at is null
          join org_memberships membership
            on membership.org_id = o.org_id and membership.user_id = ai.user_id
            and membership.role = 'owner' and membership.revoked_at is null
          where claim.deployment_id = ? and claim.claim_hash = ? and claim.admitted_identity_hash = ?
            and claim.consumed_at = ?
            and claim.consumed_adapter = ? and claim.consumed_issuer = ? and claim.consumed_subject = ?
            and ai.user_id = ? and o.org_id = ?
        ) then 1 else 0 end)
      `,
          )
          .bind(
            assertionId,
            deploymentId,
            claimHash,
            identityHash,
            now,
            identity.adapter,
            identity.issuer,
            identity.subject,
            userId,
            org.id,
          ),
        database.prepare(`delete from authority_batch_assertions where assertion_id = ?`).bind(assertionId),
      ],
      "Bootstrap owner claim is invalid, expired, consumed, or conflicts with deployment authority",
    )

    return await identityResolution(database, identity)
  }

  /**
   * Link another verified provider identity to an existing canonical user.
   * An identity can never be moved between users, including after unlink.
   */
  async linkApplicationIdentity(auth: SignedControlPlaneAuth, input: { identity: AuthIdentity }) {
    validateIdentity(input.identity)
    const { database } = this.context
    const who = await this.context.principal(auth)
    await batchUnder(database, activeGuard(who), [insertIdentity(database, input.identity, who.userId, this.context.now())])
    const row = await identityRow(database, input.identity)
    if (!row || row.unlinked_at !== null || row.user_id !== who.userId) {
      throw new D1WorkspaceAuthorityError(
        "identity_conflict",
        "Authentication identity is already linked or the target user is unavailable",
      )
    }
    return { userId: row.user_id, actorId: requireActor(row) }
  }
}

function insertIdentity(database: D1Database, identity: AuthIdentity, userId: string, now: number, guard?: BoundSql) {
  return database
    .prepare(
      `
      insert into auth_identities (adapter, issuer, subject, user_id, linked_at, unlinked_at)
      select ?, ?, ?, ?, ?, null${guard ? ` where ${guard.sql}` : ""}
      on conflict (adapter, issuer, subject) do nothing
    `,
    )
    .bind(identity.adapter, identity.issuer, identity.subject, userId, now, ...(guard?.bind ?? []))
}

function insertMappedUser(database: D1Database, identity: AuthIdentity, userId: string, now: number) {
  return database
    .prepare(
      `
      insert into users (user_id, state, created_at, updated_at, suspended_at, deleted_at)
      select ?, 'active', ?, ?, null, null
      where exists (
        select 1 from auth_identities
        where adapter = ? and issuer = ? and subject = ? and user_id = ? and unlinked_at is null
      )
      on conflict (user_id) do nothing
    `,
    )
    .bind(userId, now, now, identity.adapter, identity.issuer, identity.subject, userId)
}

function insertHumanActor(database: D1Database, identity: AuthIdentity, actorId: string, now: number) {
  return database
    .prepare(
      `
      insert into actors (actor_id, user_id, kind, state, created_at, updated_at, revoked_at)
      select ?, ai.user_id, 'human', 'active', ?, ?, null
      from auth_identities ai join users u on u.user_id = ai.user_id and u.state = 'active'
      where ai.adapter = ? and ai.issuer = ? and ai.subject = ? and ai.unlinked_at is null
      on conflict do nothing
    `,
    )
    .bind(actorId, now, now, identity.adapter, identity.issuer, identity.subject)
}

async function identityRow(database: D1Database, identity: AuthIdentity) {
  return await database
    .prepare(
      `
      select ai.user_id, u.state as user_state, a.actor_id, a.state as actor_state, ai.unlinked_at
      from auth_identities ai
      join users u on u.user_id = ai.user_id
      left join actors a on a.user_id = u.user_id and a.kind = 'human'
      where ai.adapter = ? and ai.issuer = ? and ai.subject = ?
    `,
    )
    .bind(identity.adapter, identity.issuer, identity.subject)
    .first<IdentityRow>()
}

async function identityResolution(database: D1Database, identity: AuthIdentity): Promise<ApplicationIdentityResolution> {
  const row = await identityRow(database, identity)
  if (!row || row.unlinked_at !== null || !row.actor_id || !row.actor_state) return { state: "unavailable" }
  if (row.user_state === "deleted") return { state: "deleted" }
  if (row.user_state === "suspended" || row.actor_state !== "active") return { state: "suspended" }
  return { state: "active", userId: row.user_id, actorId: row.actor_id }
}

function requireActor(row: IdentityRow) {
  if (!row.actor_id || row.actor_state !== "active") {
    throw new D1WorkspaceAuthorityError("identity_conflict", "Canonical human actor is unavailable")
  }
  return row.actor_id
}
