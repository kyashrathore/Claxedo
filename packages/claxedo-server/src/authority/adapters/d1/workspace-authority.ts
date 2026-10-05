import type { D1Database } from "@cloudflare/workers-types"
import { workspaceJson, type WorkspaceAccessRow } from "./workspace-row-json"
import { ControlPlaneAuthError, type SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { AuthIdentity } from "@claxedo/server-core/platform/auth/authentication"
import type {
  ProjectAction,
  ProjectRole,
  ProjectRoleResult,
  WorkspaceAuthority,
} from "@claxedo/server-core/platform/auth/authority"
import type { PrivateSessionRuntimePrincipal } from "@claxedo/server-core/platform/auth/private-session-authority"
import type { CloudWorkspaceCreateArgs, RuntimeCloudWorkspaceCreateArgs } from "@claxedo/server-core/platform/auth/cloud-workspace-create"
import { canonicalRepositoryKey } from "@claxedo/server-core/authority/repository-key"
import { normalizeStoredDirectory } from "@claxedo/server-core/platform/auth/host-connect-contract"
import { HOST_SERVING_WORKSPACE_SQL } from "./host-access-authority"
import { activeGuard, batchUnder, may, mayGuard, maySql, orgMemberSql, readProjectRole, type AuthorizationPrincipal } from "./authorization"
import { ownerMembershipStatements, requireHuman, requireText, type D1AccessContext } from "./access-context"
import { asOrgId, type OrgId } from "@claxedo/server-core/platform/auth/branded-id"
import { D1WorkspaceAuthorityError, guardedBatch } from "./workspace-authority-error"
import { workspaceCreationStatements } from "./workspace-creation"
import { workspaceDeletedBy, workspaceDeletionStatements } from "./workspace-deletion"
import { validateIdentity } from "./owner-identity"

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

/** The display identity a signed caller's sign-in provider holds for them. */
export type D1ActorProfile = (identity: AuthIdentity | undefined) => Promise<{ name?: string; image?: string } | undefined>

export type D1WorkspaceAuthorityOptions = {
  deploymentId: string
  product: D1AuthorityProductPolicy
  actorProfile?: D1ActorProfile
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
  repoConnectionId?: string
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

type OrgRow = {
  org_id: string
  name: string
  kind: "personal" | "shared" | "deployment"
  role: "member" | "admin" | "owner"
}

/**
 * Worker-safe organization creation, project and workspace authority.
 * Identity admission, membership, teams and grants live in the modules sharing
 * `accessContext()`, session state in `D1SessionAuthority`; all read the same
 * canonical D1 rows.
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
    await batchUnder(
      this.database,
      activeGuard(who),
      [
        this.database
          .prepare(
            `
        insert into orgs (org_id, name, kind, owner_user_id, deployment_id, created_at, updated_at)
        values (?, ?, 'shared', ?, null, ?, ?)
        on conflict (org_id) do nothing
      `,
          )
          .bind(orgId, name, who.userId, now, now),
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
      (statements) => guardedBatch(this.database, statements, "Organization creation conflicted with existing authority state"),
    )
    return { org_id: orgId, name, kind: "shared" as const, role: "owner" as const }
  }

  async usersMe(auth: SignedControlPlaneAuth) {
    const who = await this.requirePrincipal(auth)
    const [orgs, profile] = await Promise.all([this.organizationRows(who.userId), this.options.actorProfile?.(auth.principal?.identity)])
    return {
      user_id: who.userId,
      actor_id: who.actorId,
      actor_kind: "human" as const,
      actor_public_id: who.userId,
      actor_name: profile?.name ?? "User",
      ...(profile?.image ? { actor_avatar_url: profile.image } : {}),
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
   * a host assignment.
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
    await guardedBatch(this.database, creation.statements, "Workspace identity conflicts with existing authority state")
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
   * A creation's admission and project, and its statements for a caller that
   * composes them into its own batch: the host assignment lands a cold
   * workspace and the assignment together, so a batch its guard refuses leaves
   * no workspace behind. The organization admin check is repeated inside the
   * insert, so nothing here depends on the reads staying true until the batch
   * runs. The directory is recorded normalized, which is the form the scope
   * retirement compares by prefix.
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
    const statements = workspaceCreationStatements(this.database, {
      administers: mayGuard(who, "administer", { kind: "org", orgId }),
      assertionId: this.randomId("assert"),
      now: this.now(),
      ownerUserId: who.userId,
      workspaceId,
      orgId,
      projectId,
      requestedProjectId: input.projectId,
      repoKey,
      displayName,
      homeRegion,
      remoteDirectory,
      backing: input.backing,
      repoUrl: input.repoUrl,
      repoName: input.repoName,
      gitBranch: input.gitBranch,
      repoConnectionId: input.repoConnectionId,
    })
    return { who, workspaceId, orgId, statements }
  }

  async createCloudWorkspace(auth: SignedControlPlaneAuth, args: CloudWorkspaceCreateArgs) {
    return await this.createWorkspace(auth, {
      ...args,
      orgId: await this.creationOrgId(auth, args.projectId),
      backing: "cloud-vm",
    })
  }

  /** A machine-placed workspace's creation, as statements for the host assignment's batch. */
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
  async createRuntimeCloudWorkspace(principal: PrivateSessionRuntimePrincipal, args: RuntimeCloudWorkspaceCreateArgs) {
    const who = await this.requireRuntimeActor(principal)
    const projectId = requireText(args.projectId, "projectId")
    const orgId = await this.adminProjectOrgId(who, projectId)
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
    if (!(await may(this.database, who, "administer", { kind: "workspace", workspaceId }))) {
      if (await workspaceDeletedBy(this.database, { ownerUserId: who.userId, workspaceId })) return { deleted: true }
      throw denied()
    }
    await batchUnder(
      this.database,
      mayGuard(who, "administer", { kind: "workspace", workspaceId }),
      workspaceDeletionStatements(this.database, { ownerUserId: who.userId, workspaceId, assertionId: this.randomId("assert"), now: this.now() }),
      (statements) => guardedBatch(this.database, statements, "Workspace deletion changed concurrently"),
    )
    return { deleted: true }
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
      where ${orgMemberSql("o.org_id", "?")}
      order by o.created_at, o.org_id
    `,
      )
      .bind(userId, userId, userId, userId)
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
    if (projectId) return await this.adminProjectOrgId(await this.requirePrincipal(auth), projectId)
    return await this.resolveOrgId(auth)
  }

  private async adminProjectOrgId(who: Principal, projectId: string) {
    const row = await this.projectAccess(who.userId, projectId)
    if (!row || !(await may(this.database, who, "admin", { kind: "project", projectId }))) throw denied("Project creation authority was denied")
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

function projectResult(row: { orgId: string; role: ProjectRole } | undefined): ProjectRoleResult {
  return row ? { ok: true, orgId: asOrgId(row.orgId), role: row.role } : { ok: false }
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
