import type { D1Database } from "@cloudflare/workers-types"
import { ControlPlaneAuthError, type SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { ClaxedoError } from "@claxedo/server-core/platform/errors/base"
import type {
  ProjectAction,
  ProjectRole,
  WorkspaceAuthority,
} from "@claxedo/server-core/platform/auth/authority"

const CONTROL_PLANE_SERVICE_ACTOR_ID = "control-plane"

export const D1_CHANNEL_RUNTIME_AUTHORITY_METHODS = [
  "authorizeChannelProject",
  "authorizeChannelWorkspace",
  "bindChannelIdentity",
  "revokeChannelIdentity",
  "recordRuntimeAccessToken",
  "recordRuntimeAccessTokenForService",
  "runtimeAccessTokenActive",
  "revokeRuntimeAccessToken",
  "revokeRuntimeAccessTokensForWorkspaceUser",
] as const satisfies readonly (keyof WorkspaceAuthority)[]

export type D1ChannelRuntimeAuthorityPort = Pick<
  WorkspaceAuthority,
  (typeof D1_CHANNEL_RUNTIME_AUTHORITY_METHODS)[number]
>

export type D1ChannelRuntimeAuthorityOptions = {
  deploymentId: string
  now?: () => number
  randomId?: () => string
}

export class D1ChannelRuntimeAuthorityError extends ClaxedoError {
  constructor(code: "invalid_input" | "resource_conflict", message: string) {
    super({ code, message, status: code === "invalid_input" ? 400 : 409 })
  }
}

type Principal = { userId: string; actorId: string; actorKind: "human" }
type Binding = Principal & { bindingId: string }
type AccessRow = { org_id: string; role_rank: number }
type RuntimeTokenRow = {
  deployment_id: string
  workspace_id: string
  host_id: string
  principal_kind: "user" | "service"
  actor_id: string
  actor_kind: "human" | "agent"
  role: ProjectRole
  minted_for_user_id: string | null
  expires_at: number
  revoked_at: number | null
}

export class D1ChannelRuntimeAuthority implements D1ChannelRuntimeAuthorityPort {
  private readonly now: () => number
  private readonly randomId: () => string

  constructor(
    private readonly database: D1Database,
    private readonly options: D1ChannelRuntimeAuthorityOptions,
  ) {
    requireText(options.deploymentId, "deploymentId")
    this.now = options.now ?? Date.now
    this.randomId = options.randomId ?? (() => `chn_${crypto.randomUUID()}`)
  }

  async bindChannelIdentity(
    auth: SignedControlPlaneAuth,
    args: { channel: string; externalUserId: string },
  ) {
    const who = await this.requirePrincipal(auth)
    const channel = requireText(args.channel, "channel", 64)
    const externalUserId = requireText(args.externalUserId, "externalUserId", 512)
    const existing = await this.binding(channel, externalUserId, false)
    if (existing) {
      if (existing.actorId !== who.actorId || existing.userId !== who.userId) {
        throw denied("Channel identity is already bound to another actor")
      }
      return { bindingId: existing.bindingId, created: false, userId: who.userId, actorId: who.actorId, actorKind: who.actorKind }
    }
    const bindingId = requireText(this.randomId(), "bindingId")
    try {
      await this.database.prepare(`
        insert into channel_identity_bindings (
          binding_id, deployment_id, channel, external_user_id, user_id,
          actor_id, bound_by_actor_id, created_at, revoked_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, null)
      `).bind(
        bindingId,
        this.options.deploymentId,
        channel,
        externalUserId,
        who.userId,
        who.actorId,
        who.actorId,
        this.now(),
      ).run()
      return { bindingId, created: true, userId: who.userId, actorId: who.actorId, actorKind: who.actorKind }
    } catch (error) {
      if (!isUniqueFailure(error)) throw error
      const raced = await this.binding(channel, externalUserId, false)
      if (raced?.actorId === who.actorId && raced.userId === who.userId) {
        return { bindingId: raced.bindingId, created: false, userId: who.userId, actorId: who.actorId, actorKind: who.actorKind }
      }
      throw denied("Channel identity is already bound to another actor")
    }
  }

  async revokeChannelIdentity(
    auth: SignedControlPlaneAuth,
    args: { channel: string; externalUserId: string },
  ) {
    const who = await this.requirePrincipal(auth)
    const channel = requireText(args.channel, "channel", 64)
    const externalUserId = requireText(args.externalUserId, "externalUserId", 512)
    const result = await this.database.prepare(`
      update channel_identity_bindings set revoked_at = ?
      where deployment_id = ? and channel = ? and external_user_id = ?
        and user_id = ? and actor_id = ? and revoked_at is null
    `).bind(this.now(), this.options.deploymentId, channel, externalUserId, who.userId, who.actorId).run()
    if (changes(result) === 1) return { revoked: true }

    // The route writes canonical state before deleting its local allow/binding
    // projection. Report the already-achieved state to the same actor so an
    // exact retry can repair a projection failure, but never let an old owner
    // clear a newer actor's local projection.
    const active = await this.binding(channel, externalUserId, false)
    if (active) return { revoked: false }
    const latest = await this.database.prepare(`
      select user_id, actor_id from channel_identity_bindings
      where deployment_id = ? and channel = ? and external_user_id = ?
      order by rowid desc limit 1
    `).bind(this.options.deploymentId, channel, externalUserId).first<{ user_id: string; actor_id: string }>()
    return { revoked: latest?.user_id === who.userId && latest.actor_id === who.actorId }
  }

  async authorizeChannelProject(args: {
    channel: string
    externalUserId: string
    threadKey: string
    projectId: string
    action: ProjectAction
  }) {
    const binding = await this.requireBinding(args)
    const projectId = requireText(args.projectId, "projectId")
    const row = await this.projectAccess(binding.userId, projectId)
    if (!row || row.role_rank < actionRank(args.action)) return { ok: false as const }
    return {
      ok: true as const,
      orgId: row.org_id as never,
      role: rankRole(row.role_rank),
      actorId: binding.actorId,
      actorKind: binding.actorKind,
    }
  }

  async authorizeChannelWorkspace(args: {
    channel: string
    externalUserId: string
    threadKey: string
    workspaceId: string
    action: ProjectAction
  }) {
    const binding = await this.requireBinding(args)
    const workspaceId = requireText(args.workspaceId, "workspaceId")
    const access = await this.workspaceAccess(binding.userId, workspaceId)
    if (!access || access.role_rank < actionRank(args.action)) throw denied()
    return { actorId: binding.actorId, actorKind: binding.actorKind }
  }

  async recordRuntimeAccessToken(
    auth: SignedControlPlaneAuth,
    args: {
      jti: string
      workspaceId: string
      hostId: string
      actorId: string
      actorKind: "human" | "agent"
      role: ProjectRole
      expiresAt: number
    },
  ) {
    const who = await this.requirePrincipal(auth)
    if (args.actorId !== who.actorId || args.actorKind !== who.actorKind) {
      throw denied("Runtime token actor does not match the authenticated actor")
    }
    return await this.recordUserRuntimeToken(who, args)
  }

  async recordRuntimeAccessTokenForService(args: {
    jti: string
    workspaceId: string
    hostId: string
    actorId: string
    actorKind: "human" | "agent"
    principalKind: "user" | "service"
    role: ProjectRole
    expiresAt: number
  }) {
    if (
      args.principalKind !== "service"
      || args.actorKind !== "agent"
      || args.actorId !== CONTROL_PLANE_SERVICE_ACTOR_ID
      || args.role !== "owner"
    ) {
      throw denied("Only the configured control-plane service actor may mint service runtime tokens")
    }
    const values = this.tokenValues(args)
    try {
      const result = await this.database.prepare(`
        insert into runtime_access_tokens (
          jti, deployment_id, workspace_id, org_id, project_id, host_id,
          principal_kind, actor_id, actor_kind, role, minted_for_user_id,
          expires_at, revoked_at, created_at
        )
        select ?, ?, workspace_id, org_id, project_id, ?, 'service', ?, 'agent', 'owner', null, ?, null, ?
        from workspaces
        where workspace_id = ? and deleted_at is null
      `).bind(
        values.jti,
        this.options.deploymentId,
        values.hostId,
        CONTROL_PLANE_SERVICE_ACTOR_ID,
        values.expiresAt,
        this.now(),
        values.workspaceId,
      ).run()
      if (changes(result) !== 1) throw denied("Runtime token workspace is unavailable")
      return { ok: true }
    } catch (error) {
      if (isUniqueFailure(error)) throw conflict("Runtime Access Token JTI is already recorded")
      throw error
    }
  }

  async runtimeAccessTokenActive(args: {
    jti: string
    workspaceId: string
    hostId: string
    minimumRole?: "viewer" | "editor" | "admin" | "owner"
  }) {
    const jti = requireText(args.jti, "jti")
    const workspaceId = requireText(args.workspaceId, "workspaceId")
    const hostId = requireText(args.hostId, "hostId")
    const row = await this.database.prepare(`select * from runtime_access_tokens where jti = ?`)
      .bind(jti).first<RuntimeTokenRow>()
    if (!row) return inactive("runtime_access_token_unknown", "Runtime Access Token has not been recorded")
    if (row.deployment_id !== this.options.deploymentId) {
      return inactive("runtime_access_token_mismatch", "Runtime Access Token belongs to another deployment")
    }
    if (row.revoked_at !== null) return inactive("runtime_access_token_revoked", "Runtime Access Token has been revoked")
    if (row.workspace_id !== workspaceId || row.host_id !== hostId) {
      return inactive("runtime_access_token_mismatch", "Runtime Access Token does not match workspace or host")
    }
    if (row.expires_at <= this.now()) return inactive("runtime_access_token_expired", "Runtime Access Token has expired")
    if (row.principal_kind === "service") {
      if (
        row.actor_id !== CONTROL_PLANE_SERVICE_ACTOR_ID
        || row.actor_kind !== "agent"
        || row.role !== "owner"
        || row.minted_for_user_id !== null
        || !await this.workspaceExists(row.workspace_id)
        || (args.minimumRole && roleRank(row.role) < roleRank(args.minimumRole))
      ) return inactive("runtime_access_token_revoked", "Runtime Access Token service authority has been revoked")
      return { active: true }
    }
    if (!row.minted_for_user_id || row.actor_kind !== "human") {
      return inactive("runtime_access_token_revoked", "Runtime Access Token actor is invalid")
    }
    const actor = await this.database.prepare(`
      select 1 from actors actor join users user on user.user_id = actor.user_id
      where actor.actor_id = ? and actor.user_id = ? and actor.kind = 'human'
        and actor.state = 'active' and user.state = 'active'
    `).bind(row.actor_id, row.minted_for_user_id).first()
    const access = actor ? await this.workspaceAccess(row.minted_for_user_id, row.workspace_id) : null
    if (!access || access.role_rank < roleRank(row.role) || (args.minimumRole && access.role_rank < roleRank(args.minimumRole))) {
      return inactive("runtime_access_token_revoked", "Runtime Access Token authority has been revoked")
    }
    return { active: true }
  }

  async revokeRuntimeAccessToken(
    auth: SignedControlPlaneAuth,
    args: { jti: string; workspaceId: string },
  ) {
    const who = await this.requirePrincipal(auth)
    const workspaceId = requireText(args.workspaceId, "workspaceId")
    if (!await this.workspaceAccess(who.userId, workspaceId)) throw denied()
    await this.database.prepare(`
      update runtime_access_tokens set revoked_at = ?
      where deployment_id = ? and jti = ? and workspace_id = ? and revoked_at is null
    `).bind(this.now(), this.options.deploymentId, requireText(args.jti, "jti"), workspaceId).run()
    return { ok: true }
  }

  async revokeRuntimeAccessTokensForWorkspaceUser(
    auth: SignedControlPlaneAuth,
    args: { workspaceId: string },
  ) {
    const who = await this.requirePrincipal(auth)
    const workspaceId = requireText(args.workspaceId, "workspaceId")
    if (!await this.workspaceAccess(who.userId, workspaceId)) throw denied()
    const result = await this.database.prepare(`
      update runtime_access_tokens set revoked_at = ?
      where deployment_id = ? and workspace_id = ? and minted_for_user_id = ? and revoked_at is null
    `).bind(this.now(), this.options.deploymentId, workspaceId, who.userId).run()
    return { revoked: changes(result) }
  }

  private async recordUserRuntimeToken(
    who: Principal,
    args: { jti: string; workspaceId: string; hostId: string; role: ProjectRole; expiresAt: number },
  ) {
    const values = this.tokenValues(args)
    const access = await this.workspaceAccess(who.userId, values.workspaceId)
    if (!access || access.role_rank < roleRank(args.role)) throw denied("Requested runtime role exceeds current authority")
    try {
      const result = await this.database.prepare(`
        insert into runtime_access_tokens (
          jti, deployment_id, workspace_id, org_id, project_id, host_id,
          principal_kind, actor_id, actor_kind, role, minted_for_user_id,
          expires_at, revoked_at, created_at
        )
        select ?, ?, workspace_id, org_id, project_id, ?, 'user', ?, 'human', ?, ?, ?, null, ?
        from workspaces where workspace_id = ? and deleted_at is null
      `).bind(
        values.jti,
        this.options.deploymentId,
        values.hostId,
        who.actorId,
        args.role,
        who.userId,
        values.expiresAt,
        this.now(),
        values.workspaceId,
      ).run()
      // The workspace can be deleted after the authorization read but before
      // the guarded INSERT ... SELECT. A zero-row insert is a denial, never a
      // successfully recorded credential.
      if (changes(result) !== 1) throw denied("Runtime token workspace is unavailable")
      return { ok: true }
    } catch (error) {
      if (isUniqueFailure(error)) throw conflict("Runtime Access Token JTI is already recorded")
      throw error
    }
  }

  private tokenValues(args: { jti: string; workspaceId: string; hostId: string; expiresAt: number }) {
    const expiresAt = args.expiresAt
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= this.now()) {
      throw conflict("Runtime Access Token expiry must be a future safe-integer timestamp")
    }
    return {
      jti: requireText(args.jti, "jti"),
      workspaceId: requireText(args.workspaceId, "workspaceId"),
      hostId: requireText(args.hostId, "hostId"),
      expiresAt,
    }
  }

  private async requireBinding(args: { channel: string; externalUserId: string; threadKey: string }) {
    requireText(args.threadKey, "threadKey", 1_024)
    const binding = await this.binding(
      requireText(args.channel, "channel", 64),
      requireText(args.externalUserId, "externalUserId", 512),
      true,
    )
    if (!binding) throw denied("Authenticated channel identity binding is required")
    return binding
  }

  private async binding(channel: string, externalUserId: string, requireActiveActor: boolean) {
    return await this.database.prepare(`
      select binding.binding_id, binding.user_id, binding.actor_id, actor.kind as actor_kind
      from channel_identity_bindings binding
      join users user on user.user_id = binding.user_id
      join actors actor on actor.actor_id = binding.actor_id and actor.user_id = binding.user_id
      where binding.deployment_id = ? and binding.channel = ? and binding.external_user_id = ?
        and binding.revoked_at is null
        ${requireActiveActor ? "and user.state = 'active' and actor.state = 'active' and actor.kind = 'human'" : ""}
    `).bind(this.options.deploymentId, channel, externalUserId).first<{
      binding_id: string
      user_id: string
      actor_id: string
      actor_kind: "human"
    }>().then((row) => row ? {
      bindingId: row.binding_id,
      userId: row.user_id,
      actorId: row.actor_id,
      actorKind: row.actor_kind,
    } satisfies Binding : null)
  }

  private async requirePrincipal(auth: SignedControlPlaneAuth): Promise<Principal> {
    const principal = auth.principal
    if (!principal) throw new ControlPlaneAuthError(503, "identity_provisioning", "Canonical application identity is required")
    if (
      principal.deploymentId !== this.options.deploymentId
      || principal.actorKind !== "human"
    ) throw new ControlPlaneAuthError(401, "invalid_bearer_token", "Application principal belongs to another authority domain")
    const row = await this.database.prepare(`
      select identity.user_id, user.state as user_state, actor.actor_id, actor.kind as actor_kind,
        actor.state as actor_state, identity.unlinked_at
      from auth_identities identity
      join users user on user.user_id = identity.user_id
      join actors actor on actor.actor_id = ? and actor.user_id = user.user_id
      where identity.adapter = ? and identity.issuer = ? and identity.subject = ?
    `).bind(
      principal.actorId,
      principal.identity.adapter,
      principal.identity.issuer,
      principal.identity.subject,
    ).first<{
      user_id: string
      user_state: string
      actor_id: string
      actor_kind: string
      actor_state: string
      unlinked_at: number | null
    }>()
    if (
      !row || row.unlinked_at !== null || row.user_id !== principal.userId
      || row.actor_id !== principal.actorId || row.actor_kind !== "human"
    ) throw new ControlPlaneAuthError(401, "invalid_bearer_token", "Application principal is stale or unlinked")
    if (row.user_state !== "active" || row.actor_state !== "active") throw denied("Application actor is inactive")
    return { userId: row.user_id, actorId: row.actor_id, actorKind: "human" }
  }

  private async projectAccess(userId: string, projectId: string) {
    return await this.database.prepare(projectAccessSql).bind(
      userId, userId, userId, userId, projectId, userId,
    ).first<AccessRow>()
  }

  private async workspaceAccess(userId: string, workspaceId: string) {
    const row = await this.database.prepare(workspaceAccessSql).bind(
      userId, userId, userId, userId, userId, workspaceId, userId,
    ).first<AccessRow>()
    return row && row.role_rank >= 1 ? row : null
  }

  private async workspaceExists(workspaceId: string) {
    return !!await this.database.prepare(`
      select 1 from workspaces workspace
      join projects project on project.project_id = workspace.project_id and project.deleted_at is null
      join orgs org on org.org_id = workspace.org_id and org.deleted_at is null
      where workspace.workspace_id = ? and workspace.deleted_at is null
    `).bind(workspaceId).first()
  }
}

const projectAccessSql = `
  select project.org_id,
    max(
      case when project.owner_user_id = ? then 4 else 0 end,
      coalesce(case project_member.role when 'viewer' then 1 when 'editor' then 2 when 'admin' then 3 when 'owner' then 4 end, 0),
      case when org.owner_user_id = ? then 3
        when org_member.role in ('owner', 'admin') then 3
        when org_member.role = 'member' then 1 else 0 end
    ) as role_rank
  from projects project
  join orgs org on org.org_id = project.org_id and org.deleted_at is null
  left join project_memberships project_member
    on project_member.project_id = project.project_id and project_member.user_id = ? and project_member.revoked_at is null
  left join org_memberships org_member
    on org_member.org_id = project.org_id and org_member.user_id = ? and org_member.revoked_at is null
  where project.project_id = ? and project.deleted_at is null
    and (org.owner_user_id = ? or org_member.user_id is not null)
`

const workspaceAccessSql = `
  select workspace.org_id,
    max(
      case when workspace.owner_user_id = ? then 4 else 0 end,
      coalesce(case direct.role when 'viewer' then 1 when 'editor' then 2 when 'admin' then 3 when 'owner' then 4 end, 0),
      coalesce(case project_member.role when 'viewer' then 1 when 'editor' then 2 when 'admin' then 3 when 'owner' then 4 end, 0),
      case when org.owner_user_id = ? then 3
        when org_member.role in ('owner', 'admin') then 3
        when org_member.role = 'member' then 1 else 0 end
    ) as role_rank
  from workspaces workspace
  join projects project on project.project_id = workspace.project_id and project.deleted_at is null
  join orgs org on org.org_id = workspace.org_id and org.deleted_at is null
  left join workspace_memberships direct
    on direct.workspace_id = workspace.workspace_id and direct.user_id = ? and direct.revoked_at is null
  left join project_memberships project_member
    on project_member.project_id = workspace.project_id and project_member.user_id = ? and project_member.revoked_at is null
  left join org_memberships org_member
    on org_member.org_id = workspace.org_id and org_member.user_id = ? and org_member.revoked_at is null
  where workspace.workspace_id = ? and workspace.deleted_at is null
    and (org.owner_user_id = ? or org_member.user_id is not null)
`

function actionRank(action: ProjectAction) {
  return action === "read" ? 1 : action === "write" ? 2 : action === "admin" ? 3 : 4
}

function roleRank(role: ProjectRole) {
  return role === "viewer" ? 1 : role === "editor" ? 2 : role === "admin" ? 3 : 4
}

function rankRole(rank: number): ProjectRole {
  return rank >= 4 ? "owner" : rank === 3 ? "admin" : rank === 2 ? "editor" : "viewer"
}

function requireText(value: unknown, name: string, max = 512) {
  if (typeof value !== "string") throw conflict(`${name} must be a string`)
  const normalized = value.trim()
  if (!normalized || normalized.length > max) throw conflict(`${name} is invalid`)
  return normalized
}

function denied(message = "Authority denied") {
  return new ControlPlaneAuthError(403, "workspace_authorization_denied", message)
}

function conflict(message: string) {
  return new D1ChannelRuntimeAuthorityError("resource_conflict", message)
}

function inactive(code: string, reason: string) {
  return { active: false, code, reason }
}

function changes(result: { meta?: { changes?: number } }) {
  return Number(result.meta?.changes ?? 0)
}

function isUniqueFailure(error: unknown) {
  return String(error).toLowerCase().includes("unique constraint failed")
}
