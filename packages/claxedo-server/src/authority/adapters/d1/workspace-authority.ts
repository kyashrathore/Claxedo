import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types"
import { ControlPlaneAuthError, type SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { ApplicationIdentityResolution, AuthIdentity } from "@claxedo/server-core/platform/auth/authentication"
import type {
  OrgId,
  ProjectAction,
  ProjectRole,
  ProjectRoleResult,
  WorkspaceAuthority,
} from "@claxedo/server-core/platform/auth/authority"
import { canonicalRepositoryKey } from "@claxedo/server-core/authority/repository-key"

const KNOWN_HOME_REGIONS = new Set(["apac-south", "apac-east", "eu-west", "us-east", "us-west"])

export const D1_WORKSPACE_AUTHORITY_METHODS = [
  "usersMe",
  "listOrgs",
  "resolveOrgId",
  "projectRole",
  "authorizeProject",
  "authorizeWorkspaceOpen",
  "openWorkspace",
  "listWorkspaces",
  "registerLocalForSharing",
  "createCloudWorkspace",
  "deleteWorkspace",
] as const satisfies readonly (keyof WorkspaceAuthority)[]

export type D1WorkspaceAuthorityCore = Pick<WorkspaceAuthority, (typeof D1_WORKSPACE_AUTHORITY_METHODS)[number]>

export type D1AuthorityProductPolicy =
  | { kind: "claxedo-hosted" }
  | {
      kind: "user-deployed"
      organization: { id: string; name: string }
      ownerIdentity: AuthIdentity
      ownerBootstrap?: never
    }
  | {
      kind: "user-deployed"
      organization: { id: string; name: string }
      ownerIdentity?: never
      ownerBootstrap: "one-use-claim"
    }

export const USER_DEPLOYED_OWNER_CLAIM_HEADER = "x-claxedo-bootstrap-owner-claim"

export type D1WorkspaceAuthorityOptions = {
  deploymentId: string
  product: D1AuthorityProductPolicy
  now?: () => number
  randomId?: (prefix: "usr" | "act" | "org" | "prj" | "assert") => string
}

export type D1WorkspaceCreateArgs = {
  workspaceId: string
  orgId: string
  projectId?: string
  displayName: string
  repoUrl?: string
  repoName?: string
  gitBranch?: string
  remoteDirectory?: string
  homeRegion?: string
  backing: "local-worktree" | "cloud-vm"
  access: "user-hosted" | "cloud"
}

type Principal = {
  userId: string
  actorId: string
}

type IdentityRow = {
  user_id: string
  user_state: "active" | "suspended" | "deleted"
  actor_id: string | null
  actor_state: "active" | "suspended" | "revoked" | null
  unlinked_at: number | null
}

type OrgRow = {
  org_id: string
  name: string
  kind: "personal" | "team" | "deployment"
  role: "member" | "admin" | "owner"
}

type ProjectAccessRow = {
  org_id: string
  role_rank: number
}

type WorkspaceAccessRow = {
  workspace_id: string
  org_id: string
  project_id: string
  owner_user_id: string
  backing: "local-worktree" | "cloud-vm"
  access: "user-hosted" | "cloud"
  display_name: string
  home_region: string | null
  repo_url: string | null
  repo_name: string | null
  git_branch: string | null
  remote_directory: string | null
  deleted_at: number | null
  role_rank: number
}

export class D1WorkspaceAuthorityError extends Error {
  constructor(
    public readonly code: "invalid_input" | "identity_conflict" | "organization_policy_denied" | "resource_conflict",
    message: string,
  ) {
    super(message)
    this.name = "D1WorkspaceAuthorityError"
  }
}

/**
 * Worker-safe first D1 authority slice.
 *
 * It intentionally implements only the identity/org/project/workspace portion
 * of `WorkspaceAuthority`. Later D1 capability modules can be spread beside
 * this one, matching the existing Convex adapter composition, without putting
 * placeholder implementations behind the full port.
 */
export class D1WorkspaceAuthority implements D1WorkspaceAuthorityCore {
  private readonly now: () => number
  private readonly randomId: NonNullable<D1WorkspaceAuthorityOptions["randomId"]>

  constructor(
    private readonly database: D1Database,
    private readonly options: D1WorkspaceAuthorityOptions,
  ) {
    requireText(options.deploymentId, "deploymentId")
    if (options.product.kind === "user-deployed") {
      requireText(options.product.organization.id, "organization.id")
      requireText(options.product.organization.name, "organization.name")
      if (options.product.ownerIdentity) validateIdentity(options.product.ownerIdentity)
      else if (options.product.ownerBootstrap !== "one-use-claim") {
        throw new D1WorkspaceAuthorityError("invalid_input", "User-deployed owner policy is not configured")
      }
    }
    this.now = options.now ?? Date.now
    this.randomId = options.randomId ?? randomId
  }

  /** Adapter-neutral resolver wired into the selected auth adapter. */
  async ensureApplicationIdentity(identity: AuthIdentity): Promise<ApplicationIdentityResolution> {
    validateIdentity(identity)
    const candidate = {
      userId: this.randomId("usr"),
      actorId: this.randomId("act"),
      orgId: this.randomId("org"),
    }
    const now = this.now()

    if (this.options.product.kind === "claxedo-hosted") {
      await this.database.batch([
        this.insertIdentity(identity, candidate.userId, now),
        this.insertMappedUser(identity, candidate.userId, now),
        this.insertHumanActor(identity, candidate.actorId, now),
        this.database
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
        this.database
          .prepare(
            `
          insert into org_memberships (org_id, user_id, role, created_at, updated_at, revoked_at)
          select o.org_id, ai.user_id, 'owner', ?, ?, null
          from auth_identities ai
          join orgs o on o.owner_user_id = ai.user_id and o.kind = 'personal' and o.deleted_at is null
          where ai.adapter = ? and ai.issuer = ? and ai.subject = ? and ai.unlinked_at is null
          on conflict (org_id, user_id) do nothing
        `,
          )
          .bind(now, now, identity.adapter, identity.issuer, identity.subject),
      ])
      return await this.identityResolution(identity)
    }

    const existing = await this.identityResolution(identity)
    if (!this.options.product.ownerIdentity) return existing
    if (!sameIdentity(identity, this.options.product.ownerIdentity)) {
      if (existing.state !== "unavailable") return existing
      return { state: "provisioning", retryAfterMs: 5_000 }
    }
    if (existing.state === "suspended" || existing.state === "deleted") return existing

    const org = this.options.product.organization
    await this.database.batch([
      this.insertIdentity(identity, candidate.userId, now),
      this.insertMappedUser(identity, candidate.userId, now),
      this.insertHumanActor(identity, candidate.actorId, now),
      this.database
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
          this.options.deploymentId,
          now,
          now,
          identity.adapter,
          identity.issuer,
          identity.subject,
        ),
      this.database
        .prepare(
          `
        insert into org_memberships (org_id, user_id, role, created_at, updated_at, revoked_at)
        select o.org_id, ai.user_id, 'owner', ?, ?, null
        from auth_identities ai
        join orgs o on o.org_id = ? and o.kind = 'deployment' and o.deployment_id = ? and o.deleted_at is null
        where ai.adapter = ? and ai.issuer = ? and ai.subject = ? and ai.unlinked_at is null
        on conflict (org_id, user_id) do nothing
      `,
        )
        .bind(now, now, org.id, this.options.deploymentId, identity.adapter, identity.issuer, identity.subject),
    ])
    const resolution = await this.identityResolution(identity)
    if (resolution.state !== "active" || !(await this.activeOrgMembership(resolution.userId, org.id))) {
      return { state: "unavailable" }
    }
    return resolution
  }

  /**
   * Atomically consumes one deployment-bound claim while creating the only
   * bootstrap owner, canonical actor, deployment organization, and membership.
   * A failed/expired/replayed claim aborts the entire D1 batch.
   */
  async claimUserDeployedOwner(identity: AuthIdentity, claim: string): Promise<ApplicationIdentityResolution> {
    if (this.options.product.kind !== "user-deployed" || this.options.product.ownerBootstrap !== "one-use-claim") {
      throw new D1WorkspaceAuthorityError("organization_policy_denied", "Bootstrap owner claims are disabled")
    }
    validateIdentity(identity)
    const normalizedClaim = requireBootstrapClaim(claim)
    const claimHash = await userDeployedOwnerBootstrapClaimHash(normalizedClaim)
    const identityHash = await userDeployedOwnerIdentityHash(identity)
    const existing = await this.identityResolution(identity)
    if (existing.state !== "unavailable") return existing

    const now = this.now()
    const userId = this.randomId("usr")
    const actorId = this.randomId("act")
    const assertionId = this.randomId("assert")
    const deploymentId = this.options.deploymentId
    const org = this.options.product.organization
    const claimGuard = `exists (
      select 1 from user_deployed_owner_bootstrap_claims claim
      where claim.deployment_id = ? and claim.claim_hash = ? and claim.admitted_identity_hash = ?
        and claim.consumed_at is null and claim.expires_at > ?
    )`

    await this.guardedBatch(
      [
        this.database
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
        this.insertMappedUser(identity, userId, now),
        this.insertHumanActor(identity, actorId, now),
        this.database
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
        this.database
          .prepare(
            `
        insert into org_memberships (org_id, user_id, role, created_at, updated_at, revoked_at)
        select o.org_id, o.owner_user_id, 'owner', ?, ?, null
        from orgs o where o.org_id = ? and o.deployment_id = ? and o.owner_user_id = ? and o.deleted_at is null
        on conflict (org_id, user_id) do nothing
      `,
          )
          .bind(now, now, org.id, deploymentId, userId),
        this.database
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
        this.database
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
        this.database.prepare(`delete from authority_batch_assertions where assertion_id = ?`).bind(assertionId),
      ],
      "Bootstrap owner claim is invalid, expired, consumed, or conflicts with deployment authority",
    )

    return await this.identityResolution(identity)
  }

  /**
   * Link another verified provider identity to an existing canonical user.
   * An identity can never be moved between users, including after unlink.
   */
  async linkApplicationIdentity(auth: SignedControlPlaneAuth, input: { identity: AuthIdentity }) {
    validateIdentity(input.identity)
    const who = await this.requirePrincipal(auth)
    const now = this.now()
    await this.database
      .prepare(
        `
      insert into auth_identities (adapter, issuer, subject, user_id, linked_at, unlinked_at)
      select ?, ?, ?, u.user_id, ?, null from users u
      where u.user_id = ? and u.state = 'active'
      on conflict (adapter, issuer, subject) do nothing
    `,
      )
      .bind(input.identity.adapter, input.identity.issuer, input.identity.subject, now, who.userId)
      .run()
    const row = await this.identityRow(input.identity)
    if (!row || row.unlinked_at !== null || row.user_id !== who.userId) {
      throw new D1WorkspaceAuthorityError(
        "identity_conflict",
        "Authentication identity is already linked or the target user is unavailable",
      )
    }
    return { userId: row.user_id, actorId: requireActor(row) }
  }

  /**
   * Direct-add path for a verified user in the one-organization product.
   * This is a trusted application lifecycle operation, not a public auth hook.
   */
  async admitUserDeployedIdentity(
    auth: SignedControlPlaneAuth,
    input: { identity: AuthIdentity; role: "member" | "admin" },
  ) {
    if (this.options.product.kind !== "user-deployed") {
      throw new D1WorkspaceAuthorityError(
        "organization_policy_denied",
        "Direct deployment admission is unavailable in the hosted product",
      )
    }
    validateIdentity(input.identity)
    const administrator = await this.requirePrincipal(auth)
    const orgId = this.options.product.organization.id
    if (!(await this.canAdminOrganization(administrator.userId, orgId))) {
      throw denied("Organization administrator authority was denied")
    }
    const now = this.now()
    const candidateUserId = this.randomId("usr")
    const candidateActorId = this.randomId("act")
    const adminGuard = `
      exists (
        select 1 from orgs o
        left join org_memberships m
          on m.org_id = o.org_id and m.user_id = ? and m.revoked_at is null
        where o.org_id = ? and o.kind = 'deployment' and o.deployment_id = ? and o.deleted_at is null
          and (o.owner_user_id = ? or m.role in ('owner', 'admin'))
      )
    `

    await this.database.batch([
      this.database
        .prepare(
          `
        insert into auth_identities (adapter, issuer, subject, user_id, linked_at, unlinked_at)
        select ?, ?, ?, ?, ?, null where ${adminGuard}
        on conflict (adapter, issuer, subject) do nothing
      `,
        )
        .bind(
          input.identity.adapter,
          input.identity.issuer,
          input.identity.subject,
          candidateUserId,
          now,
          administrator.userId,
          orgId,
          this.options.deploymentId,
          administrator.userId,
        ),
      this.database
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
        .bind(
          candidateUserId,
          now,
          now,
          input.identity.adapter,
          input.identity.issuer,
          input.identity.subject,
          candidateUserId,
        ),
      this.insertHumanActor(input.identity, candidateActorId, now),
      this.database
        .prepare(
          `
        insert into org_memberships (org_id, user_id, role, created_at, updated_at, revoked_at)
        select ?, ai.user_id, ?, ?, ?, null
        from auth_identities ai join users u on u.user_id = ai.user_id and u.state = 'active'
        where ai.adapter = ? and ai.issuer = ? and ai.subject = ? and ai.unlinked_at is null
          and ${adminGuard}
        on conflict (org_id, user_id) do update set
          role = excluded.role,
          updated_at = excluded.updated_at,
          revoked_at = null
      `,
        )
        .bind(
          orgId,
          input.role,
          now,
          now,
          input.identity.adapter,
          input.identity.issuer,
          input.identity.subject,
          administrator.userId,
          orgId,
          this.options.deploymentId,
          administrator.userId,
        ),
    ])

    const resolution = await this.identityResolution(input.identity)
    if (resolution.state !== "active" || !(await this.activeOrgMembership(resolution.userId, orgId))) {
      throw denied("Organization administrator authority was denied")
    }
    return resolution
  }

  async createHostedOrganization(auth: SignedControlPlaneAuth, input: { name: string; orgId?: string }) {
    if (this.options.product.kind !== "claxedo-hosted") {
      throw new D1WorkspaceAuthorityError(
        "organization_policy_denied",
        "Additional organizations are disabled for user-deployed products",
      )
    }
    const who = await this.requirePrincipal(auth)
    const name = requireText(input.name, "name")
    const orgId = input.orgId ? requireText(input.orgId, "orgId") : this.randomId("org")
    const assertionId = this.randomId("assert")
    const now = this.now()
    await this.guardedBatch(
      [
        this.database
          .prepare(
            `
        insert into orgs (org_id, name, kind, owner_user_id, deployment_id, created_at, updated_at)
        select ?, ?, 'team', u.user_id, null, ?, ? from users u
        where u.user_id = ? and u.state = 'active'
        on conflict (org_id) do nothing
      `,
          )
          .bind(orgId, name, now, now, who.userId),
        this.database
          .prepare(
            `
        insert into org_memberships (org_id, user_id, role, created_at, updated_at, revoked_at)
        select o.org_id, o.owner_user_id, 'owner', ?, ?, null from orgs o
        where o.org_id = ? and o.owner_user_id = ? and o.deleted_at is null
        on conflict (org_id, user_id) do nothing
      `,
          )
          .bind(now, now, orgId, who.userId),
        this.database
          .prepare(
            `
        insert into authority_batch_assertions (assertion_id, passed)
        values (?, case when exists (
          select 1 from orgs o join org_memberships m on m.org_id = o.org_id and m.user_id = o.owner_user_id
          where o.org_id = ? and o.owner_user_id = ? and o.name = ? and o.kind = 'team'
            and o.deleted_at is null and m.role = 'owner' and m.revoked_at is null
        ) then 1 else 0 end)
      `,
          )
          .bind(assertionId, orgId, who.userId, name),
        this.database.prepare(`delete from authority_batch_assertions where assertion_id = ?`).bind(assertionId),
      ],
      "Organization creation conflicted with existing authority state",
    )
    return { org_id: orgId, name, kind: "team" as const, role: "owner" as const }
  }

  async addOrganizationMember(
    auth: SignedControlPlaneAuth,
    input: { orgId: string; userId: string; role: "member" | "admin" },
  ) {
    const administrator = await this.requirePrincipal(auth)
    const orgId = requireText(input.orgId, "orgId")
    const userId = requireText(input.userId, "userId")
    this.assertOrganizationAllowed(orgId)
    if (!(await this.canAdminOrganization(administrator.userId, orgId))) {
      throw denied("Organization administrator authority was denied")
    }
    const assertionId = this.randomId("assert")
    const now = this.now()
    await this.guardedBatch(
      [
        this.database
          .prepare(
            `
        insert into org_memberships (org_id, user_id, role, created_at, updated_at, revoked_at)
        select o.org_id, u.user_id, ?, ?, ?, null
        from orgs o join users u on u.user_id = ? and u.state = 'active'
        left join org_memberships caller
          on caller.org_id = o.org_id and caller.user_id = ? and caller.revoked_at is null
        where o.org_id = ? and o.deleted_at is null
          and (o.owner_user_id = ? or caller.role in ('owner', 'admin'))
        on conflict (org_id, user_id) do update set
          role = excluded.role,
          updated_at = excluded.updated_at,
          revoked_at = null
      `,
          )
          .bind(input.role, now, now, userId, administrator.userId, orgId, administrator.userId),
        this.database
          .prepare(
            `
        insert into authority_batch_assertions (assertion_id, passed)
        values (?, case when exists (
          select 1 from org_memberships
          where org_id = ? and user_id = ? and role = ? and revoked_at is null
        ) then 1 else 0 end)
      `,
          )
          .bind(assertionId, orgId, userId, input.role),
        this.database.prepare(`delete from authority_batch_assertions where assertion_id = ?`).bind(assertionId),
      ],
      "Organization membership changed concurrently",
    )
    return { org_id: orgId, user_id: userId, role: input.role }
  }

  async usersMe(auth: SignedControlPlaneAuth) {
    const who = await this.requirePrincipal(auth)
    const orgs = await this.organizationRows(who.userId)
    return {
      user_id: who.userId,
      actor_id: who.actorId,
      actor_kind: "human" as const,
      ...(orgs.length === 1 ? { org_id: orgs[0]!.org_id } : {}),
    }
  }

  async listOrgs(auth: SignedControlPlaneAuth) {
    const who = await this.requirePrincipal(auth)
    return await this.organizationRows(who.userId)
  }

  async resolveOrgId(auth: SignedControlPlaneAuth) {
    const who = await this.requirePrincipal(auth)
    const orgs = await this.organizationRows(who.userId)
    if (orgs.length !== 1) {
      throw denied(
        orgs.length === 0
          ? "User has no active organization membership"
          : "An explicit application organization selection is required",
      )
    }
    return orgs[0]!.org_id as OrgId
  }

  async projectRole(
    auth: SignedControlPlaneAuth,
    args: { orgId?: OrgId; projectId: string },
  ): Promise<ProjectRoleResult> {
    const who = await this.requirePrincipal(auth)
    const row = await this.projectAccess(who.userId, args.projectId, args.orgId)
    return projectResult(row)
  }

  async authorizeProject(
    auth: SignedControlPlaneAuth,
    args: { orgId?: OrgId; projectId: string; action: ProjectAction },
  ): Promise<ProjectRoleResult> {
    const who = await this.requirePrincipal(auth)
    const row = await this.projectAccess(who.userId, args.projectId, args.orgId)
    if (!row || row.role_rank < actionRank(args.action)) return { ok: false }
    return projectResult(row)
  }

  async authorizeWorkspaceOpen(auth: SignedControlPlaneAuth, args: { workspaceId: string }) {
    const who = await this.requirePrincipal(auth)
    if (!(await this.workspaceAccess(who.userId, args.workspaceId))) throw denied()
  }

  async openWorkspace(auth: SignedControlPlaneAuth, args: { workspaceId: string }) {
    const who = await this.requirePrincipal(auth)
    const row = await this.workspaceAccess(who.userId, args.workspaceId)
    if (!row) throw denied()
    return { allowed: true, role: rankRole(row.role_rank), workspace: workspaceJson(row) }
  }

  async listWorkspaces(auth: SignedControlPlaneAuth) {
    const who = await this.requirePrincipal(auth)
    const result = await this.database
      .prepare(workspaceAccessSql("w.deleted_at is null"))
      .bind(who.userId, who.userId, who.userId, who.userId, who.userId, who.userId)
      .all<WorkspaceAccessRow>()
    return result.results
      .filter((row) => row.role_rank >= 1)
      .map((row) => ({ ...workspaceJson(row), role: rankRole(row.role_rank) }))
  }

  /** Explicit-org creation seam used by new hosted organization routes. */
  async createWorkspace(auth: SignedControlPlaneAuth, input: D1WorkspaceCreateArgs) {
    const who = await this.requirePrincipal(auth)
    const workspaceId = requireText(input.workspaceId, "workspaceId")
    const orgId = requireText(input.orgId, "orgId")
    const displayName = requireText(input.displayName, "displayName")
    this.assertOrganizationAllowed(orgId)
    if (!(await this.canAdminOrganization(who.userId, orgId))) {
      throw denied("Workspace creation authority was denied")
    }
    validateWorkspacePlacement(input.backing, input.access)
    const homeRegion = validateHomeRegion(input.homeRegion)
    const repoKey = canonicalRepositoryKey({
      repoUrl: input.repoUrl,
      remoteDirectory: input.remoteDirectory,
      workspaceId,
    })
    const existingProject = await this.database
      .prepare(
        `
      select project_id from projects
      where org_id = ? and repo_key = ? and deleted_at is null
    `,
      )
      .bind(orgId, repoKey)
      .first<{ project_id: string }>()
    if (input.projectId && existingProject && existingProject.project_id !== input.projectId) {
      throw new D1WorkspaceAuthorityError("resource_conflict", "Repository is already assigned to a different project")
    }
    const projectId = input.projectId
      ? requireText(input.projectId, "projectId")
      : (existingProject?.project_id ?? this.randomId("prj"))
    const assertionId = this.randomId("assert")
    const now = this.now()
    const adminGuard = organizationAdminSql("?", "?")

    await this.guardedBatch(
      [
        this.database
          .prepare(
            `
        insert into projects (project_id, org_id, repo_key, owner_user_id, created_at, updated_at, deleted_at)
        select ?, ?, ?, ?, ?, ?, null where ${adminGuard}
        on conflict do nothing
      `,
          )
          .bind(projectId, orgId, repoKey, who.userId, now, now, who.userId, orgId, who.userId),
        this.database
          .prepare(
            `
        insert into project_memberships (project_id, user_id, role, created_at, updated_at, revoked_at)
        select p.project_id, p.owner_user_id, 'owner', ?, ?, null from projects p
        where p.org_id = ? and p.repo_key = ? and p.owner_user_id = ? and p.deleted_at is null
        on conflict (project_id, user_id) do nothing
      `,
          )
          .bind(now, now, orgId, repoKey, who.userId),
        this.database
          .prepare(
            `
        insert into workspaces (
          workspace_id, org_id, project_id, owner_user_id, backing, access, display_name,
          home_region, repo_url, repo_name, git_branch, remote_directory, created_at, updated_at, deleted_at
        )
        select ?, ?, p.project_id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null
        from projects p
        where p.org_id = ? and p.repo_key = ? and p.deleted_at is null
          and (? is null or p.project_id = ?)
          and ${adminGuard}
        on conflict (workspace_id) do nothing
      `,
          )
          .bind(
            workspaceId,
            orgId,
            who.userId,
            input.backing,
            input.access,
            displayName,
            homeRegion ?? null,
            input.repoUrl ?? null,
            input.repoName ?? null,
            input.gitBranch ?? null,
            input.remoteDirectory ?? null,
            now,
            now,
            orgId,
            repoKey,
            input.projectId ?? null,
            input.projectId ?? null,
            who.userId,
            orgId,
            who.userId,
          ),
        this.database
          .prepare(
            `
        insert into authority_batch_assertions (assertion_id, passed)
        values (?, case when exists (
          select 1 from workspaces w join projects p on p.project_id = w.project_id and p.org_id = w.org_id
          where w.workspace_id = ? and w.org_id = ? and w.owner_user_id = ?
            and w.backing = ? and w.access = ? and w.display_name = ?
            and w.home_region is ? and w.repo_url is ? and w.repo_name is ?
            and w.git_branch is ? and w.remote_directory is ? and w.deleted_at is null
            and p.repo_key = ? and (? is null or p.project_id = ?)
        ) then 1 else 0 end)
      `,
          )
          .bind(
            assertionId,
            workspaceId,
            orgId,
            who.userId,
            input.backing,
            input.access,
            displayName,
            homeRegion ?? null,
            input.repoUrl ?? null,
            input.repoName ?? null,
            input.gitBranch ?? null,
            input.remoteDirectory ?? null,
            repoKey,
            input.projectId ?? null,
            input.projectId ?? null,
          ),
        this.database.prepare(`delete from authority_batch_assertions where assertion_id = ?`).bind(assertionId),
      ],
      "Workspace identity conflicts with existing authority state",
    )

    const workspace = await this.workspaceAccess(who.userId, workspaceId)
    if (!workspace || workspace.org_id !== orgId || workspace.role_rank < 3) {
      throw denied("Workspace creation authority was denied")
    }
    return { workspace_doc_id: workspaceId, workspace_id: workspaceId, project_id: workspace.project_id, org_id: orgId }
  }

  async createCloudWorkspace(
    auth: SignedControlPlaneAuth,
    args: {
      workspaceId: string
      projectId?: string
      displayName: string
      repoUrl?: string
      repoName?: string
      gitBranch?: string
      homeRegion?: string
    },
  ) {
    return await this.createWorkspace(auth, {
      ...args,
      orgId: await this.creationOrgId(auth, args.projectId),
      backing: "cloud-vm",
      access: "cloud",
    })
  }

  async registerLocalForSharing(
    auth: SignedControlPlaneAuth,
    args: {
      workspaceId: string
      displayName: string
      projectId?: string
      repoUrl?: string
      repoName?: string
      gitBranch?: string
      remoteDirectory?: string
      homeRegion?: string
    },
  ) {
    return await this.createWorkspace(auth, {
      ...args,
      orgId: await this.creationOrgId(auth, args.projectId),
      backing: "local-worktree",
      access: "user-hosted",
    })
  }

  async deleteWorkspace(auth: SignedControlPlaneAuth, args: { workspaceId: string }) {
    const who = await this.requirePrincipal(auth)
    const workspaceId = requireText(args.workspaceId, "workspaceId")
    const row = await this.workspaceAccess(who.userId, workspaceId)
    if (!row || row.role_rank < 4) throw denied()
    const assertionId = this.randomId("assert")
    const now = this.now()
    await this.guardedBatch(
      [
        this.database
          .prepare(
            `
        update workspaces set deleted_at = ?, updated_at = ?
        where workspace_id = ? and deleted_at is null and owner_user_id = ?
      `,
          )
          .bind(now, now, workspaceId, who.userId),
        this.database
          .prepare(
            `
        insert into authority_batch_assertions (assertion_id, passed)
        values (?, case when exists (
          select 1 from workspaces where workspace_id = ? and owner_user_id = ? and deleted_at = ?
        ) then 1 else 0 end)
      `,
          )
          .bind(assertionId, workspaceId, who.userId, now),
        this.database.prepare(`delete from authority_batch_assertions where assertion_id = ?`).bind(assertionId),
      ],
      "Workspace deletion changed concurrently",
    )
    return { deleted: true }
  }

  private async guardedBatch(statements: D1PreparedStatement[], message: string) {
    try {
      return await this.database.batch(statements)
    } catch (error) {
      if (batchAssertionFailed(error)) {
        throw new D1WorkspaceAuthorityError("resource_conflict", message)
      }
      throw error
    }
  }

  private insertIdentity(identity: AuthIdentity, userId: string, now: number) {
    return this.database
      .prepare(
        `
      insert into auth_identities (adapter, issuer, subject, user_id, linked_at, unlinked_at)
      values (?, ?, ?, ?, ?, null)
      on conflict (adapter, issuer, subject) do nothing
    `,
      )
      .bind(identity.adapter, identity.issuer, identity.subject, userId, now)
  }

  private insertMappedUser(identity: AuthIdentity, userId: string, now: number) {
    return this.database
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

  private insertHumanActor(identity: AuthIdentity, actorId: string, now: number) {
    return this.database
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

  private async identityRow(identity: AuthIdentity) {
    return await this.database
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

  private async identityResolution(identity: AuthIdentity): Promise<ApplicationIdentityResolution> {
    const row = await this.identityRow(identity)
    if (!row || row.unlinked_at !== null || !row.actor_id || !row.actor_state) return { state: "unavailable" }
    if (row.user_state === "deleted") return { state: "deleted" }
    if (row.user_state === "suspended" || row.actor_state !== "active") return { state: "suspended" }
    return { state: "active", userId: row.user_id, actorId: row.actor_id }
  }

  private async requirePrincipal(auth: SignedControlPlaneAuth): Promise<Principal> {
    const principal = auth.principal
    if (!principal) {
      throw new ControlPlaneAuthError(503, "identity_provisioning", "Canonical application identity is required")
    }
    if (principal.deploymentId !== this.options.deploymentId || principal.actorKind !== "human") {
      throw new ControlPlaneAuthError(
        401,
        "invalid_bearer_token",
        "Application principal belongs to another authority domain",
      )
    }
    const row = await this.identityRow(principal.identity)
    if (!row || row.unlinked_at !== null || row.user_id !== principal.userId || row.actor_id !== principal.actorId) {
      throw new ControlPlaneAuthError(401, "invalid_bearer_token", "Application principal is stale or unlinked")
    }
    if (row.user_state === "deleted")
      throw new ControlPlaneAuthError(403, "account_deleted", "Application account is deleted")
    if (row.user_state !== "active" || row.actor_state !== "active") {
      throw new ControlPlaneAuthError(403, "account_suspended", "Application account is suspended")
    }
    return { userId: principal.userId, actorId: principal.actorId }
  }

  private async organizationRows(userId: string) {
    const result = await this.database
      .prepare(
        `
      select o.org_id, o.name, o.kind,
        case when o.owner_user_id = ? then 'owner' else m.role end as role
      from orgs o
      left join org_memberships m
        on m.org_id = o.org_id and m.user_id = ? and m.revoked_at is null
      where o.deleted_at is null and (o.owner_user_id = ? or m.user_id is not null)
      order by o.created_at, o.org_id
    `,
      )
      .bind(userId, userId, userId)
      .all<OrgRow>()
    return result.results
  }

  private async activeOrgMembership(userId: string, orgId: string) {
    return !!(await this.database
      .prepare(
        `
      select 1 from orgs o
      left join org_memberships m
        on m.org_id = o.org_id and m.user_id = ? and m.revoked_at is null
      where o.org_id = ? and o.deleted_at is null and (o.owner_user_id = ? or m.user_id is not null)
    `,
      )
      .bind(userId, orgId, userId)
      .first())
  }

  private async canAdminOrganization(userId: string, orgId: string) {
    return !!(await this.database
      .prepare(
        `
      select 1 from orgs o
      left join org_memberships m
        on m.org_id = o.org_id and m.user_id = ? and m.revoked_at is null
      where o.org_id = ? and o.deleted_at is null
        and (o.owner_user_id = ? or m.role in ('owner', 'admin'))
    `,
      )
      .bind(userId, orgId, userId)
      .first())
  }

  private async projectAccess(userId: string, projectId: string, orgId?: string) {
    return await this.database
      .prepare(
        `
      select p.org_id,
        max(
          case when p.owner_user_id = ? then 4 else 0 end,
          coalesce(case pm.role when 'viewer' then 1 when 'editor' then 2 when 'admin' then 3 when 'owner' then 4 end, 0),
          case when o.owner_user_id = ? then 3
            when om.role in ('owner', 'admin') then 3
            when om.role = 'member' then 1 else 0 end
        ) as role_rank
      from projects p
      join orgs o on o.org_id = p.org_id and o.deleted_at is null
      left join project_memberships pm
        on pm.project_id = p.project_id and pm.user_id = ? and pm.revoked_at is null
      left join org_memberships om
        on om.org_id = p.org_id and om.user_id = ? and om.revoked_at is null
      where p.project_id = ? and p.deleted_at is null and (? is null or p.org_id = ?)
        and (o.owner_user_id = ? or om.user_id is not null)
    `,
      )
      .bind(userId, userId, userId, userId, projectId, orgId ?? null, orgId ?? null, userId)
      .first<ProjectAccessRow>()
  }

  private async workspaceAccess(userId: string, workspaceId: string) {
    const row = await this.database
      .prepare(workspaceAccessSql("w.workspace_id = ? and w.deleted_at is null"))
      .bind(userId, userId, userId, userId, userId, workspaceId, userId)
      .first<WorkspaceAccessRow>()
    return row && row.role_rank >= 1 ? row : null
  }

  private assertOrganizationAllowed(orgId: string) {
    if (this.options.product.kind === "user-deployed" && orgId !== this.options.product.organization.id) {
      throw new D1WorkspaceAuthorityError(
        "organization_policy_denied",
        "User-deployed products cannot address another organization",
      )
    }
  }

  private async creationOrgId(auth: SignedControlPlaneAuth, projectId?: string) {
    if (projectId) {
      const result = await this.authorizeProject(auth, { projectId, action: "admin" })
      if (result.ok) return result.orgId
      throw denied("Project creation authority was denied")
    }
    return await this.resolveOrgId(auth)
  }
}

function workspaceAccessSql(predicate: string) {
  return `
    select w.*,
      max(
        case when w.owner_user_id = ? then 4 else 0 end,
        coalesce(case wm.role when 'viewer' then 1 when 'editor' then 2 when 'admin' then 3 when 'owner' then 4 end, 0),
        coalesce(case pm.role when 'viewer' then 1 when 'editor' then 2 when 'admin' then 3 when 'owner' then 4 end, 0),
        case when o.owner_user_id = ? then 3
          when om.role in ('owner', 'admin') then 3
          when om.role = 'member' then 1 else 0 end
      ) as role_rank
    from workspaces w
    join projects p on p.project_id = w.project_id and p.org_id = w.org_id and p.deleted_at is null
    join orgs o on o.org_id = w.org_id and o.deleted_at is null
    left join workspace_memberships wm
      on wm.workspace_id = w.workspace_id and wm.user_id = ? and wm.revoked_at is null
    left join project_memberships pm
      on pm.project_id = w.project_id and pm.user_id = ? and pm.revoked_at is null
    left join org_memberships om
      on om.org_id = w.org_id and om.user_id = ? and om.revoked_at is null
    where ${predicate}
      and (o.owner_user_id = ? or om.user_id is not null)
    order by w.created_at, w.workspace_id
  `
}

function organizationAdminSql(orgExpression: string, userExpression: string) {
  return `exists (
    select 1 from orgs o
    left join org_memberships m
      on m.org_id = o.org_id and m.user_id = ${userExpression} and m.revoked_at is null
    where o.org_id = ${orgExpression} and o.deleted_at is null
      and (o.owner_user_id = ${userExpression} or m.role in ('owner', 'admin'))
  )`
}

function workspaceJson(row: WorkspaceAccessRow) {
  return {
    workspace_id: row.workspace_id,
    org_id: row.org_id,
    project_id: row.project_id,
    backing: row.backing,
    access: row.access,
    display_name: row.display_name,
    ...(row.home_region ? { home_region: row.home_region } : {}),
    ...(row.repo_url ? { repo_url: row.repo_url } : {}),
    ...(row.repo_name ? { repo_name: row.repo_name } : {}),
    ...(row.git_branch ? { git_branch: row.git_branch } : {}),
    ...(row.remote_directory ? { remote_directory: row.remote_directory } : {}),
  }
}

function projectResult(row: ProjectAccessRow | null): ProjectRoleResult {
  if (!row || row.role_rank < 1) return { ok: false }
  return { ok: true, orgId: row.org_id as OrgId, role: rankRole(row.role_rank) }
}

function actionRank(action: ProjectAction) {
  return action === "read" ? 1 : action === "write" ? 2 : action === "admin" ? 3 : 4
}

function rankRole(rank: number): ProjectRole {
  return rank >= 4 ? "owner" : rank >= 3 ? "admin" : rank >= 2 ? "editor" : "viewer"
}

function requireActor(row: IdentityRow) {
  if (!row.actor_id || row.actor_state !== "active") {
    throw new D1WorkspaceAuthorityError("identity_conflict", "Canonical human actor is unavailable")
  }
  return row.actor_id
}

function validateIdentity(identity: AuthIdentity) {
  if (identity.adapter !== "better-auth" && identity.adapter !== "clerk") {
    throw new D1WorkspaceAuthorityError("invalid_input", "Unknown authentication adapter")
  }
  requireText(identity.issuer, "identity.issuer")
  requireText(identity.subject, "identity.subject")
}

function sameIdentity(a: AuthIdentity, b: AuthIdentity) {
  return a.adapter === b.adapter && a.issuer === b.issuer && a.subject === b.subject
}

function requireText(value: string, name: string) {
  const result = value.trim()
  if (!result || result.length > 512) {
    throw new D1WorkspaceAuthorityError("invalid_input", `${name} must be a non-empty string of at most 512 characters`)
  }
  return result
}

function requireBootstrapClaim(value: string) {
  if (value.trim() !== value || !/^[A-Za-z0-9_-]{43,128}$/.test(value)) {
    throw new D1WorkspaceAuthorityError(
      "invalid_input",
      "Bootstrap owner claim must be a canonical 256-bit-or-stronger base64url value",
    )
  }
  return value
}

export async function userDeployedOwnerBootstrapClaimHash(claim: string) {
  const canonical = requireBootstrapClaim(claim)
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)))
  return `sha256:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`
}

/** Stable hash recorded by the release admission and bootstrap claim rows. */
export async function userDeployedOwnerIdentityHash(identity: AuthIdentity) {
  validateIdentity(identity)
  const canonical = JSON.stringify([
    "claxedo:user-deployed-owner:v1",
    identity.adapter,
    identity.issuer,
    identity.subject,
  ])
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)))
  return `sha256:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`
}

function validateHomeRegion(value?: string) {
  if (value === undefined) return undefined
  if (!KNOWN_HOME_REGIONS.has(value)) {
    throw new D1WorkspaceAuthorityError("invalid_input", `${value} is not a known Claxedo region`)
  }
  return value
}

function validateWorkspacePlacement(backing: string, access: string) {
  if ((backing === "cloud-vm" && access !== "cloud") || (backing === "local-worktree" && access !== "user-hosted")) {
    throw new D1WorkspaceAuthorityError("invalid_input", "Workspace backing and access mode conflict")
  }
}

function denied(message = "Workspace authority denied access") {
  return new ControlPlaneAuthError(403, "workspace_authorization_denied", message)
}

function batchAssertionFailed(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.message.includes("passed = 1")) return true
  return batchAssertionFailed(error.cause)
}

function randomId(prefix: "usr" | "act" | "org" | "prj" | "assert") {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return `${prefix}_${Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")}`
}
