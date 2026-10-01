import { publicApiErrorShape } from "@claxedo/helpers/api-error"
import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types"
import { ControlPlaneAuthError, type SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import {
  AUTH_ADAPTERS,
  type ApplicationIdentityResolution,
  type AuthIdentity,
} from "@claxedo/server-core/platform/auth/authentication"
import type {
  ProjectAction,
  ProjectRole,
  ProjectRoleResult,
  WorkspaceAuthority,
} from "@claxedo/server-core/platform/auth/authority"
import type { PrivateSessionRuntimePrincipal } from "@claxedo/server-core/platform/auth/private-session-authority"
import { canonicalRepositoryKey } from "@claxedo/server-core/authority/repository-key"
import { ClaxedoError } from "@claxedo/server-core/platform/errors/base"
import { normalizeStoredDirectory } from "@claxedo/server-core/platform/auth/host-connect-contract"
import { HOST_SERVING_WORKSPACE_SQL } from "./host-access-authority"
import { batchUnder, may, mayGuard, maySql, readProjectRole, roleRank, type AuthorizationPrincipal } from "./authorization"
import { ownerMembershipStatements, requireHuman, requireText, type D1AccessContext } from "./access-context"
import { asOrgId, type OrgId } from "@claxedo/server-core/platform/auth/branded-id"
import { d1BatchAssertionFailed } from "../../../platform/db/d1-constraint"

const KNOWN_HOME_REGIONS = new Set(["apac-south", "apac-east", "eu-west", "us-east", "us-west"])

export const D1_WORKSPACE_AUTHORITY_METHODS = [
  "usersMe",
  "listOrgs",
  "createOrg",
  "resolveOrgId",
  "projectRole",
  "authorizeProject",
  "authorizeWorkspaceOpen",
  "authorizeWorkspaceCreate",
  "openWorkspace",
  "listWorkspaces",
  "registerLocalForSharing",
  "createCloudWorkspace",
  "createRuntimeCloudWorkspace",
  "deleteWorkspace",
  "deleteRuntimeWorkspace",
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
  randomId?: (prefix: "usr" | "act" | "org" | "prj" | "team" | "assert" | "audit") => string
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
}

export type D1LocalWorkspaceRegistrationArgs = {
  workspaceId: string
  displayName: string
  projectId?: string
  repoUrl?: string
  repoName?: string
  gitBranch?: string
  remoteDirectory?: string
  homeRegion?: string
  orgId?: string
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
  kind: "personal" | "shared" | "deployment"
  role: "member" | "admin" | "owner"
}

type WorkspaceAccessRow = {
  workspace_id: string
  org_id: string
  project_id: string
  owner_user_id: string
  backing: "local-worktree" | "cloud-vm"
  display_name: string
  home_region: string | null
  repo_url: string | null
  repo_name: string | null
  git_branch: string | null
  remote_directory: string | null
  host_enrollment_id: string | null
  deleted_at: number | null
}

export type D1WorkspaceAuthorityErrorCode =
  | "invalid_input"
  | "identity_conflict"
  | "organization_policy_denied"
  | "resource_conflict"

/**
 * Carries its HTTP status like every other authority refusal
 * (`D1HostAccessAuthorityError`), so a route that hands the caller a
 * conflict answers 409 rather than reporting a fault it did not have.
 */
export class D1WorkspaceAuthorityError extends ClaxedoError<D1WorkspaceAuthorityErrorCode> {
  constructor(code: D1WorkspaceAuthorityErrorCode, message: string) {
    super({ code, message, ...publicApiErrorShape(code) })
  }
}

/**
 * Worker-safe identity, organization creation, project and workspace authority.
 * Membership, teams and grants live in the modules sharing `accessContext()`,
 * session state in `D1SessionAuthority`; all read the same canonical D1 rows.
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

  /** The context the organization, team and project-member modules resolve their callers through. */
  accessContext(): D1AccessContext {
    return {
      database: this.database,
      deploymentId: this.options.deploymentId,
      now: this.now,
      randomId: this.randomId,
      principal: (auth) => requireHuman(this.database, this.options.deploymentId, auth),
      assertOrganizationAllowed: (orgId) => this.assertOrganizationAllowed(orgId),
    }
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
        ...ownerMembershipStatements(this.accessContext(), {
          owners: {
            sql: `select o.org_id, ai.user_id from auth_identities ai
              join orgs o on o.owner_user_id = ai.user_id and o.kind = 'personal' and o.deleted_at is null
              where ai.adapter = ? and ai.issuer = ? and ai.subject = ? and ai.unlinked_at is null`,
            bind: [identity.adapter, identity.issuer, identity.subject],
          },
          now,
        }),
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
      ...ownerMembershipStatements(this.accessContext(), {
        owners: {
          sql: `select o.org_id, ai.user_id from auth_identities ai
            join orgs o on o.org_id = ? and o.kind = 'deployment' and o.deployment_id = ? and o.deleted_at is null
            where ai.adapter = ? and ai.issuer = ? and ai.subject = ? and ai.unlinked_at is null`,
          bind: [org.id, this.options.deploymentId, identity.adapter, identity.issuer, identity.subject],
        },
        now,
      }),
    ])
    const resolution = await this.identityResolution(identity)
    if (resolution.state !== "active" || !(await may(this.database, resolution, "member", { kind: "org", orgId: org.id }))) {
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
    const existing = await this.identityResolution(identity)
    if (this.options.product.kind !== "user-deployed" || existing.state !== "unavailable") return existing
    const now = this.now()
    const pending = await this.database
      .prepare(`
        select 1 from org_invitations
        where org_id = ? and email = ? and accepted_at is null and revoked_at is null and expires_at > ?
      `)
      .bind(this.options.product.organization.id, verifiedEmail.trim().toLowerCase(), now)
      .first()
    if (!pending) return existing
    const userId = this.randomId("usr")
    await this.database.batch([
      this.insertIdentity(identity, userId, now),
      this.insertMappedUser(identity, userId, now),
      this.insertHumanActor(identity, this.randomId("act"), now),
    ])
    return await this.identityResolution(identity)
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
        ...ownerMembershipStatements(this.accessContext(), {
          owners: {
            sql: `select o.org_id, o.owner_user_id as user_id from orgs o
              where o.org_id = ? and o.deployment_id = ? and o.owner_user_id = ? and o.deleted_at is null`,
            bind: [org.id, deploymentId, userId],
          },
          now,
        }),
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
        select ?, ?, 'shared', u.user_id, null, ?, ? from users u
        where u.user_id = ? and u.state = 'active'
        on conflict (org_id) do nothing
      `,
          )
          .bind(orgId, name, now, now, who.userId),
        ...ownerMembershipStatements(this.accessContext(), {
          owners: {
            sql: `select o.org_id, o.owner_user_id as user_id from orgs o
              where o.org_id = ? and o.owner_user_id = ? and o.deleted_at is null`,
            bind: [orgId, who.userId],
          },
          now,
        }),
        this.database
          .prepare(
            `
        insert into authority_batch_assertions (assertion_id, passed)
        values (?, case when exists (
          select 1 from orgs o join org_memberships m on m.org_id = o.org_id and m.user_id = o.owner_user_id
          where o.org_id = ? and o.owner_user_id = ? and o.name = ? and o.kind = 'shared'
            and o.deleted_at is null and m.role = 'owner' and m.revoked_at is null
        ) then 1 else 0 end)
      `,
          )
          .bind(assertionId, orgId, who.userId, name),
        this.database.prepare(`delete from authority_batch_assertions where assertion_id = ?`).bind(assertionId),
      ],
      "Organization creation conflicted with existing authority state",
    )
    return { org_id: orgId, name, kind: "shared" as const, role: "owner" as const }
  }

  async usersMe(auth: SignedControlPlaneAuth) {
    const who = await this.requirePrincipal(auth)
    const orgs = await this.organizationRows(who.userId)
    return {
      user_id: who.userId,
      actor_id: who.actorId,
      actor_kind: "human" as const,
      ...(orgs.length === 1 ? { org_id: orgs[0].org_id } : {}),
    }
  }

  async listOrgs(auth: SignedControlPlaneAuth) {
    const who = await this.requirePrincipal(auth)
    return await this.organizationRows(who.userId)
  }

  async createOrg(auth: SignedControlPlaneAuth, args: { name: string }) {
    return await this.createHostedOrganization(auth, args)
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
    return asOrgId(orgs[0].org_id)
  }

  async projectRole(
    auth: SignedControlPlaneAuth,
    args: { orgId?: OrgId; projectId: string },
  ): Promise<ProjectRoleResult> {
    const who = await this.requirePrincipal(auth)
    return projectResult(await this.projectAccess(who.userId, args.projectId, args.orgId))
  }

  async authorizeProject(
    auth: SignedControlPlaneAuth,
    args: { orgId?: OrgId; projectId: string; action: ProjectAction },
  ): Promise<ProjectRoleResult> {
    const who = await this.requirePrincipal(auth)
    const project = { kind: "project" as const, projectId: args.projectId, ...(args.orgId ? { orgId: args.orgId } : {}) }
    if (!(await may(this.database, who, args.action, project))) return { ok: false }
    return projectResult(await this.projectAccess(who.userId, args.projectId, args.orgId))
  }

  async authorizeWorkspaceOpen(auth: SignedControlPlaneAuth, args: { workspaceId: string }) {
    const who = await this.requirePrincipal(auth)
    if (!(await may(this.database, who, "open", { kind: "workspace", workspaceId: args.workspaceId }))) throw denied()
  }

  /**
   * The admission `createWorkspace` will apply, answered before the caller's
   * billable work starts. The organization comes from `creationOrgId`, the
   * same resolution creation uses, so a caller who names no organization is
   * admitted against the one their workspace would actually land in — an
   * absent selector resolves a tenant, it does not skip a check. A named
   * organization that is not that one is refused here rather than silently
   * ignored, which is what creation does with it.
   */
  async authorizeWorkspaceCreate(auth: SignedControlPlaneAuth, args: { orgId?: string; projectId?: string }) {
    const who = await this.requirePrincipal(auth)
    const projectId = args.projectId?.trim()
    const orgId = await this.creationOrgId(auth, projectId ? projectId : undefined)
    const selected = args.orgId?.trim()
    if (selected && selected !== orgId) throw denied("Workspace creation authority was denied")
    await this.admitCreationOrganization(who, orgId)
  }

  /**
   * The admission a machine-placed registration will apply — the cold half of
   * a host assignment, and `registerLocalForSharing`.
   *
   * It differs from the cloud create above in ONE thing, and it is the thing
   * the two writes differ in: `localWorkspaceArgs` files into the
   * organization the caller named when they named one, so naming an
   * organization the caller may administer is admitted here rather than
   * refused for disagreeing with their default.
   */
  async authorizeLocalWorkspaceRegistration(auth: SignedControlPlaneAuth, args: { orgId?: string; projectId?: string }) {
    const who = await this.requirePrincipal(auth)
    await this.admitCreationOrganization(who, await this.localRegistrationOrgId(auth, args))
  }

  /** Who may create in an organization: one rule, whatever resolved the organization. */
  private async admitCreationOrganization(who: Principal, orgId: string) {
    this.assertOrganizationAllowed(orgId)
    if (!(await may(this.database, who, "administer", { kind: "org", orgId }))) {
      throw denied("Workspace creation authority was denied")
    }
  }

  /** The organization a machine-placed registration files into. */
  private async localRegistrationOrgId(auth: SignedControlPlaneAuth, args: { orgId?: string; projectId?: string }) {
    const named = args.orgId?.trim()
    if (named) return named
    const projectId = args.projectId?.trim()
    return await this.creationOrgId(auth, projectId ? projectId : undefined)
  }

  async openWorkspace(auth: SignedControlPlaneAuth, args: { workspaceId: string }) {
    const who = await this.requirePrincipal(auth)
    const row = await this.openableWorkspace(who, args.workspaceId)
    if (!row) throw denied()
    return { allowed: true, role: "owner" as const, workspace: workspaceJson(row) }
  }

  async listWorkspaces(auth: SignedControlPlaneAuth) {
    const who = await this.requirePrincipal(auth)
    const rows = await this.openableWorkspaces(who)
    const online = await this.workspacesWithServingHost(
      rows.filter((row) => row.backing === "local-worktree").map((row) => row.workspace_id),
    )
    return rows.map((row) => ({
      ...workspaceJson(row),
      role: "owner" as const,
      // Reachability, not authorization: a shared workspace whose machine is
      // asleep is still listed, and the rail says "host offline" for it rather
      // than dropping the row or waiting for a pane to discover it.
      ...(row.backing === "local-worktree" ? { host_online: online.has(row.workspace_id) } : {}),
    }))
  }

  /** Of these workspaces, the ones a live enrollment currently serves. */
  private async workspacesWithServingHost(workspaceIds: string[]) {
    if (workspaceIds.length === 0) return new Set<string>()
    const result = await this.database
      .prepare(`
      select distinct assignment.workspace_id
      from host_workspace_assignments assignment
      inner join host_enrollments enrollment on enrollment.host_id = assignment.host_id
        and enrollment.owner_actor_id = assignment.owner_actor_id
      where assignment.workspace_id in (${workspaceIds.map(() => "?").join(", ")})
        and ${HOST_SERVING_WORKSPACE_SQL}
    `)
      .bind(...workspaceIds, this.now())
      .all<{ workspace_id: string }>()
    return new Set(result.results.map((row) => row.workspace_id))
  }

  /** Explicit-org creation seam used by new hosted organization routes. */
  async createWorkspace(auth: SignedControlPlaneAuth, input: D1WorkspaceCreateArgs) {
    return await this.createWorkspaceAs(await this.requirePrincipal(auth), input)
  }

  /**
   * The one creation path, for a creator already resolved: the signed
   * caller, or the canonical actor a runtime credential resolved to. Every
   * admission is `who`'s own — organization admin, project admin through
   * `adminProjectOrgId` — so a person who could not create this workspace
   * from the app cannot have it created for them by a credential either.
   */
  private async createWorkspaceAs(who: Principal, input: D1WorkspaceCreateArgs) {
    const creation = await this.workspaceCreation(who, input)
    await this.guardedBatch(creation.statements, "Workspace identity conflicts with existing authority state")
    const workspace = await this.openableWorkspace(who, creation.workspaceId)
    if (!workspace || workspace.org_id !== creation.orgId) {
      throw denied("Workspace creation authority was denied")
    }
    return {
      workspace_doc_id: creation.workspaceId,
      workspace_id: creation.workspaceId,
      project_id: workspace.project_id,
      org_id: creation.orgId,
    }
  }

  /**
   * The statements that create a workspace, and its project when the
   * repository has none, for a caller that composes them into its own batch:
   * the host assignment lands a cold workspace and the assignment together,
   * so a batch its guard refuses leaves no workspace behind. The organization
   * admin check is repeated inside the insert and the batch assertion proves
   * the row landed as described, so nothing here depends on the reads staying
   * true until the batch runs. The directory is recorded normalized, which is
   * the form the scope retirement compares by prefix.
   */
  private async workspaceCreation(who: Principal, input: D1WorkspaceCreateArgs) {
    const workspaceId = requireText(input.workspaceId, "workspaceId")
    const orgId = requireText(input.orgId, "orgId")
    const displayName = requireText(input.displayName, "displayName")
    this.assertOrganizationAllowed(orgId)
    if (!(await may(this.database, who, "administer", { kind: "org", orgId }))) {
      throw denied("Workspace creation authority was denied")
    }
    const homeRegion = validateHomeRegion(input.homeRegion)
    const remoteDirectory = input.remoteDirectory === undefined ? null : normalizeStoredDirectory(input.remoteDirectory)
    const repoKey = canonicalRepositoryKey({
      repoUrl: input.repoUrl,
      remoteDirectory,
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
    const administers = mayGuard(who, "administer", { kind: "org", orgId })

    return {
      who,
      workspaceId,
      orgId,
      statements: [
        this.database
          .prepare(
            `
        insert into projects (project_id, org_id, repo_key, owner_user_id, created_at, updated_at, deleted_at)
        select ?, ?, ?, ?, ?, ?, null where ${administers.sql}
        on conflict do nothing
      `,
          )
          .bind(projectId, orgId, repoKey, who.userId, now, now, ...administers.bind),
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
          workspace_id, org_id, project_id, owner_user_id, backing, display_name,
          home_region, repo_url, repo_name, git_branch, remote_directory, created_at, updated_at, deleted_at
        )
        select ?, ?, p.project_id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null
        from projects p
        where p.org_id = ? and p.repo_key = ? and p.deleted_at is null
          and (? is null or p.project_id = ?)
          and ${administers.sql}
        on conflict (workspace_id) do nothing
      `,
          )
          .bind(
            workspaceId,
            orgId,
            who.userId,
            input.backing,
            displayName,
            homeRegion ?? null,
            input.repoUrl ?? null,
            input.repoName ?? null,
            input.gitBranch ?? null,
            remoteDirectory,
            now,
            now,
            orgId,
            repoKey,
            input.projectId ?? null,
            input.projectId ?? null,
            ...administers.bind,
          ),
        this.database
          .prepare(
            `
        insert into authority_batch_assertions (assertion_id, passed)
        values (?, case when exists (
          select 1 from workspaces w join projects p on p.project_id = w.project_id and p.org_id = w.org_id
          where w.workspace_id = ? and w.org_id = ? and w.owner_user_id = ?
            and w.backing = ? and w.display_name = ?
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
            displayName,
            homeRegion ?? null,
            input.repoUrl ?? null,
            input.repoName ?? null,
            input.gitBranch ?? null,
            remoteDirectory,
            repoKey,
            input.projectId ?? null,
            input.projectId ?? null,
          ),
        this.database.prepare(`delete from authority_batch_assertions where assertion_id = ?`).bind(assertionId),
      ],
    }
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
      remoteDirectory?: string
      homeRegion?: string
    },
  ) {
    return await this.createWorkspace(auth, {
      ...args,
      orgId: await this.creationOrgId(auth, args.projectId),
      backing: "cloud-vm",
    })
  }

  async registerLocalForSharing(auth: SignedControlPlaneAuth, args: D1LocalWorkspaceRegistrationArgs) {
    return await this.createWorkspace(auth, await this.localWorkspaceArgs(auth, args))
  }

  /** `registerLocalForSharing` as statements for the host assignment's batch. */
  async localWorkspaceRegistration(auth: SignedControlPlaneAuth, args: D1LocalWorkspaceRegistrationArgs) {
    const who = await this.requirePrincipal(auth)
    return await this.workspaceCreation(who, await this.localWorkspaceArgs(auth, args))
  }

  /**
   * What admits this caller is not a signature but a resolution the caller
   * made: the principal is the workspace owner's active human actor, resolved
   * from the grant by the control plane, and `orgId`/`projectId` are that
   * owner's. What is checked here is that the actor is that person now, that
   * they may admin the project, and that the project is in the organization
   * named — the same admission `createWorkspace` gives a signed creator.
   */
  async createRuntimeCloudWorkspace(
    principal: PrivateSessionRuntimePrincipal,
    args: {
      workspaceId: string
      orgId: string
      projectId: string
      displayName: string
      repoUrl?: string
      repoName?: string
      gitBranch?: string
      remoteDirectory?: string
      homeRegion?: string
    },
  ) {
    const who = await this.requireRuntimeActor(principal)
    const projectId = requireText(args.projectId, "projectId")
    const orgId = await this.adminProjectOrgId(who.userId, projectId)
    if (orgId !== requireText(args.orgId, "orgId")) throw denied("Project creation authority was denied")
    return await this.createWorkspaceAs(who, { ...args, orgId, projectId, backing: "cloud-vm" })
  }

  private async localWorkspaceArgs(
    auth: SignedControlPlaneAuth,
    args: D1LocalWorkspaceRegistrationArgs,
  ): Promise<D1WorkspaceCreateArgs> {
    return {
      ...args,
      orgId: await this.localRegistrationOrgId(auth, args),
      backing: "local-worktree",
    }
  }

  async deleteWorkspace(auth: SignedControlPlaneAuth, args: { workspaceId: string }) {
    return await this.deleteWorkspaceAs(await this.requirePrincipal(auth), args)
  }

  async deleteRuntimeWorkspace(principal: PrivateSessionRuntimePrincipal, args: { workspaceId: string }) {
    return await this.deleteWorkspaceAs(await this.requireRuntimeActor(principal), args)
  }

  private async deleteWorkspaceAs(who: Principal, args: { workspaceId: string }) {
    const workspaceId = requireText(args.workspaceId, "workspaceId")
    if (!(await may(this.database, who, "administer", { kind: "workspace", workspaceId }))) throw denied()
    const assertionId = this.randomId("assert")
    const now = this.now()
    await batchUnder(
      this.database,
      mayGuard(who, "administer", { kind: "workspace", workspaceId }),
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
      (statements) => this.guardedBatch(statements, "Workspace deletion changed concurrently"),
    )
    return { deleted: true }
  }

  private async guardedBatch(statements: D1PreparedStatement[], message: string) {
    try {
      return await this.database.batch(statements)
    } catch (error) {
      if (d1BatchAssertionFailed(error)) {
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

  private requirePrincipal(auth: SignedControlPlaneAuth): Promise<Principal> {
    return requireHuman(this.database, this.options.deploymentId, auth)
  }

  /**
   * A user principal only. The plane's own service actor reaches the session
   * authority as itself, but a workspace it created would belong to nobody a
   * person can open, so a service principal is refused here rather than
   * given an owner.
   */
  private async requireRuntimeActor(principal: PrivateSessionRuntimePrincipal): Promise<Principal> {
    if (principal.principalKind !== "user" || principal.actorKind !== "human") {
      throw denied("Canonical human actor is required")
    }
    const row = await this.database
      .prepare(
        `
      select a.actor_id, a.user_id from actors a
      join users u on u.user_id = a.user_id and u.state = 'active'
      where a.actor_id = ? and a.kind = 'human' and a.state = 'active'
    `,
      )
      .bind(requireText(principal.actorId, "actorId"))
      .first<{ actor_id: string; user_id: string }>()
    if (!row) throw denied("Canonical active actor is required")
    return { userId: row.user_id, actorId: row.actor_id }
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

  private async projectAccess(userId: string, projectId: string, orgId?: string) {
    return await readProjectRole(this.database, userId, { kind: "project", projectId, ...(orgId ? { orgId } : {}) })
  }

  private async openableWorkspace(who: AuthorizationPrincipal, workspaceId: string) {
    const query = openableWorkspacesSql(who, "w.workspace_id = ?")
    return await this.database.prepare(query.sql).bind(...query.bind, workspaceId).first<WorkspaceAccessRow>()
  }

  private async openableWorkspaces(who: AuthorizationPrincipal) {
    const query = openableWorkspacesSql(who, "1 = 1")
    return (await this.database.prepare(query.sql).bind(...query.bind).all<WorkspaceAccessRow>()).results
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
    if (projectId) return await this.adminProjectOrgId((await this.requirePrincipal(auth)).userId, projectId)
    return await this.resolveOrgId(auth)
  }

  private async adminProjectOrgId(userId: string, projectId: string) {
    const row = await this.projectAccess(userId, projectId)
    if (!row || roleRank(row.role) < roleRank("admin")) throw denied("Project creation authority was denied")
    return row.orgId
  }
}

/** The workspaces `who` may open matching `predicate` over `w`, with the machine each is placed on; `predicate`'s own values bind last. */
function openableWorkspacesSql(who: AuthorizationPrincipal, predicate: string) {
  const opens = maySql(who, "open", { kind: "workspace", alias: "w" })
  return {
    sql: `
      select w.*, assignment_enrollment.enrollment_id as host_enrollment_id
      from workspaces w
      left join host_workspace_assignments assignment
        on assignment.workspace_id = w.workspace_id
      left join host_enrollments assignment_enrollment
        on assignment_enrollment.host_id = assignment.host_id
        and assignment_enrollment.owner_actor_id = assignment.owner_actor_id
      where ${opens.sql} and ${predicate}
      order by w.created_at, w.workspace_id
    `,
    bind: opens.bind,
  }
}

function workspaceJson(row: WorkspaceAccessRow) {
  return {
    workspace_id: row.workspace_id,
    org_id: row.org_id,
    project_id: row.project_id,
    backing: row.backing,
    placement: {
      ...(row.host_enrollment_id ? { host_enrollment_id: row.host_enrollment_id } : {}),
      ...(row.remote_directory ? { directory: row.remote_directory } : {}),
    },
    display_name: row.display_name,
    ...(row.home_region ? { home_region: row.home_region } : {}),
    ...(row.repo_url ? { repo_url: row.repo_url } : {}),
    ...(row.repo_name ? { repo_name: row.repo_name } : {}),
    ...(row.git_branch ? { git_branch: row.git_branch } : {}),
    ...(row.remote_directory ? { remote_directory: row.remote_directory } : {}),
  }
}

function projectResult(row: { orgId: string; role: ProjectRole } | undefined): ProjectRoleResult {
  return row ? { ok: true, orgId: asOrgId(row.orgId), role: row.role } : { ok: false }
}

function requireActor(row: IdentityRow) {
  if (!row.actor_id || row.actor_state !== "active") {
    throw new D1WorkspaceAuthorityError("identity_conflict", "Canonical human actor is unavailable")
  }
  return row.actor_id
}

function validateIdentity(identity: AuthIdentity) {
  if (!AUTH_ADAPTERS.includes(identity.adapter)) {
    throw new D1WorkspaceAuthorityError("invalid_input", "Unknown authentication adapter")
  }
  requireText(identity.issuer, "identity.issuer")
  requireText(identity.subject, "identity.subject")
}

function sameIdentity(a: AuthIdentity, b: AuthIdentity) {
  return a.adapter === b.adapter && a.issuer === b.issuer && a.subject === b.subject
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

function denied(message = "Workspace authority denied access") {
  return new ControlPlaneAuthError(403, "workspace_authorization_denied", message)
}

function randomId(prefix: "usr" | "act" | "org" | "prj" | "team" | "assert" | "audit") {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return `${prefix}_${Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")}`
}
