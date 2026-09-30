import type { D1Database } from "@cloudflare/workers-types"
import { ControlPlaneAuthError, type SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { ClaxedoError } from "@claxedo/server-core/platform/errors/base"
import type {
  ChannelMachineIdentity,
  ProjectAction,
  ProjectRole,
  WorkspaceAuthority,
} from "@claxedo/server-core/platform/auth/authority"
import { asOrgId } from "@claxedo/server-core/platform/auth/branded-id"
import { CURRENT_CHANNEL_IDENTITY_VERSION } from "@claxedo/workspace-relay-protocol"
import { may, maySql, readProjectRole, roleRank, type AuthorizationPrincipal } from "./authorization"
import { requireHuman } from "./access-context"

const CONTROL_PLANE_SERVICE_ACTOR_ID = "control-plane"

export const D1_CHANNEL_RUNTIME_AUTHORITY_METHODS = [
  "resolveRuntimeMachineAccess",
  "resolveChannelMachineAccess",
  "resolveWorkspaceOwner",
  "recordChannelRuntimeAccessToken",
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
          actor_id, bound_by_actor_id, created_at, revoked_at, identity_version
        ) values (?, ?, ?, ?, ?, ?, ?, ?, null, ?)
      `).bind(
        bindingId,
        this.options.deploymentId,
        channel,
        externalUserId,
        who.userId,
        who.actorId,
        who.actorId,
        this.now(),
        CURRENT_CHANNEL_IDENTITY_VERSION,
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
        and identity_version = ?
    `).bind(
      this.now(),
      this.options.deploymentId,
      channel,
      externalUserId,
      who.userId,
      who.actorId,
      CURRENT_CHANNEL_IDENTITY_VERSION,
    ).run()
    if (changes(result) === 1) return { revoked: true }

    // The route writes canonical state before deleting its local allow/binding
    // projection. Report the already-achieved state to the same actor so an
    // exact retry can repair a projection failure, but never let an old owner
    // clear a newer actor's local projection.
    const active = await this.binding(channel, externalUserId, false)
    if (active) return { revoked: false }
    // A pre-boundary row is not a binding this actor holds, so there is
    // nothing here for them to have revoked. Answering otherwise would let the
    // route delete a local projection on the strength of a row that stopped
    // authorizing at the migration.
    const latest = await this.database.prepare(`
      select user_id, actor_id from channel_identity_bindings
      where deployment_id = ? and channel = ? and external_user_id = ?
        and identity_version = ?
      order by rowid desc limit 1
    `).bind(
      this.options.deploymentId,
      channel,
      externalUserId,
      CURRENT_CHANNEL_IDENTITY_VERSION,
    ).first<{ user_id: string; actor_id: string }>()
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
    const project = { kind: "project" as const, projectId: requireText(args.projectId, "projectId") }
    const row = await readProjectRole(this.database, binding.userId, project)
    if (!row || !(await may(this.database, binding, args.action, project))) return { ok: false as const }
    return {
      ok: true as const,
      orgId: asOrgId(row.orgId),
      role: row.role,
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
    if (!(await this.operableWorkspace(binding, requireText(args.workspaceId, "workspaceId")))) throw denied()
    return { actorId: binding.actorId, actorKind: binding.actorKind }
  }

  private async requireActor(actorId: string): Promise<Principal> {
    const actor = await this.database.prepare(`select a.actor_id, a.user_id from actors a join users u on u.user_id = a.user_id where a.actor_id = ? and a.kind = 'human' and a.state = 'active' and u.state = 'active'`).bind(requireText(actorId, "actorId")).first<{ actor_id: string; user_id: string }>()
    if (!actor) throw denied("Canonical active machine actor is required")
    return { actorId: actor.actor_id, userId: actor.user_id, actorKind: "human" }
  }

  async resolveRuntimeMachineAccess(actorId: string, workspaceId: string) {
    const who = await this.requireActor(actorId)
    const access = await this.operableWorkspace(who, requireText(workspaceId, "workspaceId"))
    if (!access) throw denied()
    return { actorId: who.actorId, actorKind: who.actorKind, orgId: access.org_id, role: "owner" as const, userId: who.userId }
  }

  /**
   * Who a control-plane-minted credential naming this workspace acts as.
   *
   * The owner column alone would be an assertion about a row; the access read
   * beside it is the recheck, so a workspace whose owner lost the project, the
   * organization, or their account stops answering for any credential that
   * names it.
   */
  async resolveWorkspaceOwner(workspaceId: string) {
    const row = await this.database.prepare(`
      select workspace.owner_user_id, workspace.project_id, actor.actor_id
      from workspaces workspace
      join users owner on owner.user_id = workspace.owner_user_id and owner.state = 'active'
      join actors actor on actor.user_id = owner.user_id and actor.kind = 'human' and actor.state = 'active'
      where workspace.workspace_id = ? and workspace.deleted_at is null
    `).bind(requireText(workspaceId, "workspaceId")).first<{ owner_user_id: string; project_id: string; actor_id: string }>()
    if (!row?.owner_user_id || !row.project_id || !row.actor_id) return undefined
    const access = await this.operableWorkspace({ userId: row.owner_user_id, actorId: row.actor_id }, workspaceId)
    if (!access) return undefined
    return { userId: row.owner_user_id, actorId: row.actor_id, orgId: access.org_id, projectId: row.project_id }
  }

  async resolveChannelMachineAccess(identity: ChannelMachineIdentity, workspaceId: string) {
    const who = await this.requireBinding(identity)
    const access = await this.operableWorkspace(who, requireText(workspaceId, "workspaceId"))
    if (!access) throw denied()
    return {
      actorId: who.actorId,
      actorKind: who.actorKind,
      orgId: access.org_id,
      role: "owner" as const,
      identityVersion: CURRENT_CHANNEL_IDENTITY_VERSION,
      userId: who.userId,
    }
  }

  async recordChannelRuntimeAccessToken(identity: ChannelMachineIdentity, args: Parameters<WorkspaceAuthority["recordRuntimeAccessToken"]>[1]) {
    const who = await this.requireBinding(identity)
    if (args.actorId !== who.actorId || args.actorKind !== who.actorKind) throw denied("Runtime token actor does not match channel binding")
    return this.recordUserRuntimeToken(who, args)
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
    const holder = { userId: row.minted_for_user_id, actorId: row.actor_id }
    if (!(await may(this.database, holder, "operate", { kind: "workspace", workspaceId: row.workspace_id }))) {
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
    if (!(await may(this.database, who, "operate", { kind: "workspace", workspaceId }))) throw denied()
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
    if (!(await may(this.database, who, "operate", { kind: "workspace", workspaceId }))) throw denied()
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
    if (!(await may(this.database, who, "operate", { kind: "workspace", workspaceId: values.workspaceId }))) {
      throw denied("Runtime access to this workspace is its owner's")
    }
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
        and binding.revoked_at is null and binding.identity_version = ?
        ${requireActiveActor ? "and user.state = 'active' and actor.state = 'active' and actor.kind = 'human'" : ""}
    `).bind(
      this.options.deploymentId,
      channel,
      externalUserId,
      CURRENT_CHANNEL_IDENTITY_VERSION,
    ).first<{
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

  private requirePrincipal(auth: SignedControlPlaneAuth): Promise<Principal> {
    return requireHuman(this.database, this.options.deploymentId, auth)
  }

  /** The workspace's organization, when `who` may act on the machine serving it. */
  private async operableWorkspace(who: AuthorizationPrincipal, workspaceId: string) {
    const operates = maySql(who, "operate", { kind: "workspace", alias: "w" })
    return await this.database
      .prepare(`select w.org_id from workspaces w where w.workspace_id = ? and ${operates.sql}`)
      .bind(workspaceId, ...operates.bind)
      .first<{ org_id: string }>()
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
  return result.meta?.changes ?? 0
}

function isUniqueFailure(error: unknown) {
  return String(error).toLowerCase().includes("unique constraint failed")
}
