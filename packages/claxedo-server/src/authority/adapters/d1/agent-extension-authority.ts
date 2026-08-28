import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types"
import { ControlPlaneAuthError, type SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"

export const D1_AGENT_EXTENSION_AUTHORITY_METHODS = [
  "listWorkspaceAgentExtensions",
  "listWorkspaceAgentExtensionsForRuntime",
  "authorizeWorkspaceAgentExtensionsAdmin",
  "upsertWorkspaceAgentExtension",
  "setWorkspaceAgentExtensionEnabled",
  "deleteWorkspaceAgentExtension",
  "listAgentExtensionPolicyOverrides",
  "listAgentExtensionPolicyOverridesForRuntime",
  "setAgentExtensionPolicyOverride",
  "deleteAgentExtensionPolicyOverride",
] as const satisfies readonly (keyof WorkspaceAuthority)[]

export type D1AgentExtensionAuthorityPort = Pick<
  WorkspaceAuthority,
  (typeof D1_AGENT_EXTENSION_AUTHORITY_METHODS)[number]
>

export type D1AgentExtensionAuthorityOptions = {
  deploymentId: string
  now?: () => number
  randomId?: () => string
}

type Principal = { userId: string; actorId: string }
type PrincipalRow = {
  user_id: string
  user_state: "active" | "suspended" | "deleted"
  actor_id: string
  actor_kind: "human" | "agent"
  actor_state: "active" | "suspended" | "revoked"
  unlinked_at: number | null
}
type WorkspaceRow = { workspace_id: string; org_id: string; project_id: string; role_rank: number }
type InstallRow = {
  deployment_id: string
  workspace_id: string
  extension_id: string
  package_name: string
  source_json: string
  desired_json: string
  lock_json: string | null
  enabled: number
  updated_at: number
  revision: number
  deleted_at: number | null
}
type PolicyScope = "org" | "user" | "workspace"
type PolicyRow = {
  scope: PolicyScope
  extension_id: string
  enabled: number
  reason: string | null
}

const HARNESS_TARGETS = new Set(["opencode", "claude", "codex", "cursor"])
const MAX_DESIRED_BYTES = 65_536
const MAX_LOCK_BYTES = 262_144
const MAX_SOURCE_BYTES = 16_384
const MAX_JSON_DEPTH = 24
const MAX_JSON_NODES = 20_000

export class D1AgentExtensionAuthorityError extends Error {
  constructor(
    public readonly code: "invalid_input" | "resource_conflict" | "storage_limit_exceeded",
    message: string,
  ) {
    super(message)
    this.name = "D1AgentExtensionAuthorityError"
  }
}

/** Worker-safe Agent Extension desired-state and policy authority. */
export class D1AgentExtensionAuthority implements D1AgentExtensionAuthorityPort {
  private readonly now: () => number
  private readonly randomId: () => string

  constructor(
    private readonly database: D1Database,
    private readonly options: D1AgentExtensionAuthorityOptions,
  ) {
    boundedText(options.deploymentId, "deploymentId", 200)
    this.now = options.now ?? Date.now
    this.randomId = options.randomId ?? (() => `assert_${crypto.randomUUID()}`)
  }

  async listWorkspaceAgentExtensions(auth: SignedControlPlaneAuth, args: { workspaceId: string }) {
    const who = await this.requirePrincipal(auth)
    const workspaceId = boundedText(args.workspaceId, "workspaceId", 300)
    if (!await this.workspaceAccess(who, workspaceId, "read")) return []
    return await this.installRows(workspaceId)
  }

  async listWorkspaceAgentExtensionsForRuntime(args: { workspaceId: string }) {
    return await this.installRows(boundedText(args.workspaceId, "workspaceId", 300))
  }

  async authorizeWorkspaceAgentExtensionsAdmin(auth: SignedControlPlaneAuth, args: { workspaceId: string }) {
    const who = await this.requirePrincipal(auth)
    await this.requireWorkspaceAccess(who, boundedText(args.workspaceId, "workspaceId", 300), "admin")
  }

  async upsertWorkspaceAgentExtension(auth: SignedControlPlaneAuth, args: {
    workspaceId: string
    extensionId: string
    packageName: string
    desired: unknown
    lock: unknown
  }) {
    const who = await this.requirePrincipal(auth)
    const workspaceId = boundedText(args.workspaceId, "workspaceId", 300)
    const extensionId = boundedText(args.extensionId, "extensionId", 300)
    const packageName = boundedText(args.packageName, "packageName", 300)
    const desired = desiredJson(args.desired, { extensionId, packageName })
    const source = canonicalJson(desired.value.source, "desired.source", MAX_SOURCE_BYTES)
    const lock = lockJson(args.lock)
    if (lock) {
      if (canonicalJson(lock.value.source, "lock.source", MAX_SOURCE_BYTES).text !== source.text) {
        invalid("lock.source must match desired.source")
      }
      if (JSON.stringify(lock.value.targets) !== JSON.stringify(desired.value.targets)) {
        invalid("lock.targets must match desired.targets")
      }
    }
    const now = this.now()

    await this.guardedAdminBatch(who, workspaceId, false, [this.database.prepare(`
      insert into agent_extension_installs (
        deployment_id, workspace_id, org_id, project_id, extension_id, package_name,
        source_json, desired_json, lock_json, enabled,
        created_by_user_id, created_by_actor_id, updated_by_user_id, updated_by_actor_id,
        created_at, updated_at, revision, deleted_at
      )
      select ?, workspace.workspace_id, workspace.org_id, workspace.project_id, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, 1, null
      from workspaces workspace
      where workspace.workspace_id = ? and workspace.deleted_at is null
      on conflict (deployment_id, workspace_id, extension_id) do update set
        package_name = excluded.package_name,
        source_json = excluded.source_json,
        desired_json = excluded.desired_json,
        lock_json = excluded.lock_json,
        enabled = excluded.enabled,
        updated_by_user_id = excluded.updated_by_user_id,
        updated_by_actor_id = excluded.updated_by_actor_id,
        updated_at = excluded.updated_at,
        revision = agent_extension_installs.revision + 1,
        deleted_at = null
      where (agent_extension_installs.deleted_at is not null
          or agent_extension_installs.source_json = excluded.source_json)
        and (agent_extension_installs.deleted_at is not null
          or agent_extension_installs.package_name != excluded.package_name
          or agent_extension_installs.desired_json != excluded.desired_json
          or agent_extension_installs.lock_json is not excluded.lock_json
          or agent_extension_installs.enabled != excluded.enabled)
    `).bind(
      this.options.deploymentId,
      extensionId,
      packageName,
      source.text,
      desired.text,
      lock?.text ?? null,
      desired.value.enabled ? 1 : 0,
      who.userId,
      who.actorId,
      who.userId,
      who.actorId,
      now,
      now,
      workspaceId,
    )])

    const stored = await this.installRow(workspaceId, extensionId)
    if (!stored) throw denied()
    if (stored.source_json !== source.text) {
      throw new D1AgentExtensionAuthorityError(
        "resource_conflict",
        "Agent Extension is already installed from a different source",
      )
    }
    if (
      stored.package_name !== packageName || stored.desired_json !== desired.text
      || stored.lock_json !== (lock?.text ?? null) || stored.enabled !== (desired.value.enabled ? 1 : 0)
      || stored.deleted_at !== null
    ) {
      throw new D1AgentExtensionAuthorityError("resource_conflict", "Agent Extension update conflicted with current state")
    }
    return { extension_id: extensionId }
  }

  async setWorkspaceAgentExtensionEnabled(auth: SignedControlPlaneAuth, args: {
    workspaceId: string
    extensionId: string
    enabled: boolean
  }) {
    const who = await this.requirePrincipal(auth)
    const workspaceId = boundedText(args.workspaceId, "workspaceId", 300)
    const extensionId = boundedText(args.extensionId, "extensionId", 300)
    if (typeof args.enabled !== "boolean") invalid("enabled must be a boolean")

    for (let attempt = 0; attempt < 4; attempt++) {
      await this.requireWorkspaceAccess(who, workspaceId, "admin")
      const existing = await this.installRow(workspaceId, extensionId)
      if (!existing || existing.deleted_at !== null) {
        throw new D1AgentExtensionAuthorityError("resource_conflict", "Agent Extension not found")
      }
      if (existing.enabled === (args.enabled ? 1 : 0)) return { extension_id: extensionId, enabled: args.enabled }
      const parsed = parseObjectJson(existing.desired_json, "stored Agent Extension desired state")
      const now = this.now()
      const desired = desiredJson({ ...parsed, enabled: args.enabled, updated_at: now }, {
        extensionId,
        packageName: existing.package_name,
      })
      const [updated] = await this.guardedAdminBatch(who, workspaceId, false, [this.database.prepare(`
        update agent_extension_installs set
          desired_json = ?, enabled = ?, updated_by_user_id = ?, updated_by_actor_id = ?, updated_at = ?,
          revision = revision + 1
        where deployment_id = ? and workspace_id = ? and extension_id = ?
          and deleted_at is null and revision = ?
      `).bind(
        desired.text,
        args.enabled ? 1 : 0,
        who.userId,
        who.actorId,
        now,
        this.options.deploymentId,
        workspaceId,
        extensionId,
        existing.revision,
      )])
      if (changes(updated) === 1) return { extension_id: extensionId, enabled: args.enabled }
    }
    throw new D1AgentExtensionAuthorityError("resource_conflict", "Agent Extension changed concurrently")
  }

  async deleteWorkspaceAgentExtension(auth: SignedControlPlaneAuth, args: {
    workspaceId: string
    extensionId: string
  }) {
    const who = await this.requirePrincipal(auth)
    const workspaceId = boundedText(args.workspaceId, "workspaceId", 300)
    const extensionId = boundedText(args.extensionId, "extensionId", 300)
    const now = this.now()
    await this.guardedAdminBatch(who, workspaceId, false, [this.database.prepare(`
      update agent_extension_installs set
        deleted_at = ?, updated_at = ?, updated_by_user_id = ?, updated_by_actor_id = ?, revision = revision + 1
      where deployment_id = ? and workspace_id = ? and extension_id = ? and deleted_at is null
    `).bind(now, now, who.userId, who.actorId, this.options.deploymentId, workspaceId, extensionId)])
    return { ok: true }
  }

  async listAgentExtensionPolicyOverrides(auth: SignedControlPlaneAuth, args: { workspaceId: string }) {
    const who = await this.requirePrincipal(auth)
    const workspaceId = boundedText(args.workspaceId, "workspaceId", 300)
    const workspace = await this.workspaceAccess(who, workspaceId, "read")
    if (!workspace) return []
    return await this.policyRows(workspace, who.userId, true)
  }

  async listAgentExtensionPolicyOverridesForRuntime(args: { workspaceId: string }) {
    const workspace = await this.runtimeWorkspace(boundedText(args.workspaceId, "workspaceId", 300))
    if (!workspace) return []
    return await this.policyRows(workspace, undefined, false)
  }

  async setAgentExtensionPolicyOverride(auth: SignedControlPlaneAuth, args: {
    workspaceId: string
    extensionId: string
    scope: PolicyScope
    enabled: boolean
    reason?: string
  }) {
    const who = await this.requirePrincipal(auth)
    const workspaceId = boundedText(args.workspaceId, "workspaceId", 300)
    const extensionId = boundedText(args.extensionId, "extensionId", 300)
    const scope = policyScope(args.scope)
    if (typeof args.enabled !== "boolean") invalid("enabled must be a boolean")
    const reason = optionalBoundedText(args.reason, "reason", 500)
    const workspace = await this.requireWorkspaceAccess(who, workspaceId, "admin")
    const target = policyTarget(scope, workspace, who.userId)
    const now = this.now()

    await this.guardedAdminBatch(who, workspaceId, scope === "org", [this.database.prepare(`
      insert into agent_extension_policy_overrides (
        deployment_id, scope, scope_key, extension_id, org_id, project_id, workspace_id, user_id,
        enabled, reason, created_by_user_id, created_by_actor_id, updated_by_user_id,
        updated_by_actor_id, created_at, updated_at, deleted_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null)
      on conflict (deployment_id, scope, scope_key, extension_id) do update set
        enabled = excluded.enabled,
        reason = excluded.reason,
        updated_by_user_id = excluded.updated_by_user_id,
        updated_by_actor_id = excluded.updated_by_actor_id,
        updated_at = excluded.updated_at,
        deleted_at = null
      where agent_extension_policy_overrides.deleted_at is not null
        or agent_extension_policy_overrides.enabled != excluded.enabled
        or agent_extension_policy_overrides.reason is not excluded.reason
    `).bind(
      this.options.deploymentId,
      scope,
      target.scopeKey,
      extensionId,
      target.orgId,
      target.projectId,
      target.workspaceId,
      target.userId,
      args.enabled ? 1 : 0,
      reason ?? null,
      who.userId,
      who.actorId,
      who.userId,
      who.actorId,
      now,
      now,
    )])
    return { extension_id: extensionId, scope }
  }

  async deleteAgentExtensionPolicyOverride(auth: SignedControlPlaneAuth, args: {
    workspaceId: string
    extensionId: string
    scope: PolicyScope
  }) {
    const who = await this.requirePrincipal(auth)
    const workspaceId = boundedText(args.workspaceId, "workspaceId", 300)
    const extensionId = boundedText(args.extensionId, "extensionId", 300)
    const scope = policyScope(args.scope)
    const workspace = await this.requireWorkspaceAccess(who, workspaceId, "admin")
    const target = policyTarget(scope, workspace, who.userId)
    const now = this.now()
    await this.guardedAdminBatch(who, workspaceId, scope === "org", [this.database.prepare(`
      update agent_extension_policy_overrides set
        deleted_at = ?, updated_at = ?, updated_by_user_id = ?, updated_by_actor_id = ?
      where deployment_id = ? and scope = ? and scope_key = ? and extension_id = ? and deleted_at is null
    `).bind(
      now,
      now,
      who.userId,
      who.actorId,
      this.options.deploymentId,
      scope,
      target.scopeKey,
      extensionId,
    )])
    return { ok: true }
  }

  private async installRows(workspaceId: string) {
    const result = await this.database.prepare(`
      select install.* from agent_extension_installs install
      join workspaces workspace
        on workspace.workspace_id = install.workspace_id and workspace.org_id = install.org_id
        and workspace.project_id = install.project_id and workspace.deleted_at is null
      join projects project
        on project.project_id = workspace.project_id and project.org_id = workspace.org_id and project.deleted_at is null
      join orgs organization on organization.org_id = workspace.org_id and organization.deleted_at is null
      where install.deployment_id = ? and install.workspace_id = ? and install.deleted_at is null
      order by install.extension_id
      limit 513
    `).bind(this.options.deploymentId, workspaceId).all<InstallRow>()
    if (result.results.length > 512) {
      throw new D1AgentExtensionAuthorityError("storage_limit_exceeded", "Workspace Agent Extension list exceeds 512 rows")
    }
    return result.results.map((row) => ({
      desired: parseObjectJson(row.desired_json, "stored Agent Extension desired state"),
      ...(row.lock_json === null ? {} : { lock: parseObjectJson(row.lock_json, "stored Agent Extension lock") }),
      enabled: row.enabled === 1,
      updated_at: row.updated_at,
    }))
  }

  private async policyRows(workspace: WorkspaceRow, userId: string | undefined, includeUser: boolean) {
    const result = await this.database.prepare(`
      select scope, extension_id, enabled, reason
      from agent_extension_policy_overrides
      where deployment_id = ? and deleted_at is null and (
        (scope = 'org' and org_id = ?)
        or (scope = 'workspace' and workspace_id = ? and org_id = ? and project_id = ?)
        or (? = 1 and scope = 'user' and user_id = ?)
      )
      order by extension_id, case scope when 'org' then 1 when 'user' then 2 else 3 end
      limit 2049
    `).bind(
      this.options.deploymentId,
      workspace.org_id,
      workspace.workspace_id,
      workspace.org_id,
      workspace.project_id,
      includeUser ? 1 : 0,
      userId ?? null,
    ).all<PolicyRow>()
    if (result.results.length > 2048) {
      throw new D1AgentExtensionAuthorityError("storage_limit_exceeded", "Agent Extension policy list exceeds 2048 rows")
    }
    return result.results.map((row) => ({
      id: row.extension_id,
      scope: row.scope,
      enabled: row.enabled === 1,
      ...(row.reason ? { reason: row.reason } : {}),
    }))
  }

  private async installRow(workspaceId: string, extensionId: string) {
    return await this.database.prepare(`
      select * from agent_extension_installs
      where deployment_id = ? and workspace_id = ? and extension_id = ?
    `).bind(this.options.deploymentId, workspaceId, extensionId).first<InstallRow>()
  }

  private async runtimeWorkspace(workspaceId: string) {
    return await this.database.prepare(`
      select workspace.workspace_id, workspace.org_id, workspace.project_id, 4 as role_rank
      from workspaces workspace
      join projects project
        on project.project_id = workspace.project_id and project.org_id = workspace.org_id and project.deleted_at is null
      join orgs organization on organization.org_id = workspace.org_id and organization.deleted_at is null
      where workspace.workspace_id = ? and workspace.deleted_at is null
    `).bind(workspaceId).first<WorkspaceRow>()
  }

  private async requirePrincipal(auth: SignedControlPlaneAuth): Promise<Principal> {
    const principal = auth.principal
    if (!principal) throw new ControlPlaneAuthError(503, "identity_provisioning", "Canonical application identity is required")
    if (principal.deploymentId !== this.options.deploymentId || principal.actorKind !== "human") {
      throw new ControlPlaneAuthError(401, "invalid_bearer_token", "Application principal belongs to another authority domain")
    }
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
    ).first<PrincipalRow>()
    if (
      !row || row.unlinked_at !== null || row.user_id !== principal.userId || row.actor_id !== principal.actorId
      || row.actor_kind !== "human"
    ) throw new ControlPlaneAuthError(401, "invalid_bearer_token", "Application principal is stale or unlinked")
    if (row.user_state === "deleted") throw new ControlPlaneAuthError(403, "account_deleted", "Application account is deleted")
    if (row.user_state !== "active" || row.actor_state !== "active") {
      throw new ControlPlaneAuthError(403, "account_suspended", "Application account is suspended")
    }
    return { userId: row.user_id, actorId: row.actor_id }
  }

  private async workspaceAccess(who: Principal, workspaceId: string, action: "read" | "admin") {
    return await this.database.prepare(`
      ${workspaceAccessCte(action === "read" ? 1 : 3)}
      select * from authorized_workspace
    `).bind(who.actorId, workspaceId).first<WorkspaceRow>()
  }

  private async requireWorkspaceAccess(who: Principal, workspaceId: string, action: "read" | "admin") {
    const workspace = await this.workspaceAccess(who, workspaceId, action)
    if (!workspace) throw denied()
    return workspace
  }

  private async guardedAdminBatch(
    who: Principal,
    workspaceId: string,
    requireOrgAdmin: boolean,
    statements: D1PreparedStatement[],
  ) {
    const assertionId = this.randomId()
    try {
      return await this.database.batch([
        ...statements,
        this.database.prepare(`
          ${workspaceAccessCte(3)}
          insert into authority_batch_assertions (assertion_id, passed)
          select ?, case when exists (
            select 1 from authorized_workspace workspace
            where ? = 0 or exists (
              select 1 from orgs organization
              left join org_memberships membership
                on membership.org_id = organization.org_id and membership.user_id = ?
                and membership.revoked_at is null
              where organization.org_id = workspace.org_id and organization.deleted_at is null
                and (organization.owner_user_id = ? or membership.role in ('owner', 'admin'))
            )
          ) then 1 else 0 end
        `).bind(
          who.actorId,
          workspaceId,
          assertionId,
          requireOrgAdmin ? 1 : 0,
          who.userId,
          who.userId,
        ),
        this.database.prepare(`delete from authority_batch_assertions where assertion_id = ?`).bind(assertionId),
      ])
    } catch (error) {
      if (String(error).includes("authority_batch_assertions.passed") || String(error).includes("CHECK constraint failed")) {
        throw denied()
      }
      throw error
    }
  }
}

function workspaceAccessCte(rank: 1 | 3) {
  return `with current_actor as (
    select actor.actor_id, actor.user_id
    from actors actor join users user on user.user_id = actor.user_id and user.state = 'active'
    where actor.actor_id = ? and actor.state = 'active'
  ), authorized_workspace as (
    select workspace.workspace_id, workspace.org_id, workspace.project_id,
      max(
        case when workspace.owner_user_id = current_actor.user_id then 4 else 0 end,
        coalesce(case direct.role when 'viewer' then 1 when 'editor' then 2 when 'admin' then 3 when 'owner' then 4 end, 0),
        coalesce(case project_member.role when 'viewer' then 1 when 'editor' then 2 when 'admin' then 3 when 'owner' then 4 end, 0),
        case when organization.owner_user_id = current_actor.user_id then 3
          when org_member.role in ('owner', 'admin') then 3
          when org_member.role = 'member' then 1 else 0 end
      ) as role_rank
    from current_actor
    join workspaces workspace on workspace.workspace_id = ? and workspace.deleted_at is null
    join projects project
      on project.project_id = workspace.project_id and project.org_id = workspace.org_id and project.deleted_at is null
    join orgs organization on organization.org_id = workspace.org_id and organization.deleted_at is null
    left join workspace_memberships direct
      on direct.workspace_id = workspace.workspace_id and direct.user_id = current_actor.user_id and direct.revoked_at is null
    left join project_memberships project_member
      on project_member.project_id = workspace.project_id and project_member.user_id = current_actor.user_id
      and project_member.revoked_at is null
    left join org_memberships org_member
      on org_member.org_id = workspace.org_id and org_member.user_id = current_actor.user_id and org_member.revoked_at is null
    where organization.owner_user_id = current_actor.user_id or org_member.user_id is not null
    group by workspace.workspace_id
    having role_rank >= ${rank}
  )`
}

function policyTarget(scope: PolicyScope, workspace: WorkspaceRow, userId: string) {
  if (scope === "org") {
    return { scopeKey: workspace.org_id, orgId: workspace.org_id, projectId: null, workspaceId: null, userId: null }
  }
  if (scope === "user") {
    return { scopeKey: userId, orgId: null, projectId: null, workspaceId: null, userId }
  }
  return {
    scopeKey: workspace.workspace_id,
    orgId: workspace.org_id,
    projectId: workspace.project_id,
    workspaceId: workspace.workspace_id,
    userId: null,
  }
}

function desiredJson(input: unknown, expected: { extensionId: string; packageName: string }) {
  const value = plainObject(input, "desired")
  if (value.id !== expected.extensionId) invalid("desired.id must match extensionId")
  if (value.package_name !== expected.packageName) invalid("desired.package_name must match packageName")
  if (value.scope !== "workspace") invalid("desired.scope must be workspace")
  if (typeof value.enabled !== "boolean") invalid("desired.enabled must be a boolean")
  plainObject(value.source, "desired.source")
  if (!Array.isArray(value.targets) || !value.targets.every((target) => HARNESS_TARGETS.has(String(target)))) {
    invalid("desired.targets contains an unsupported harness")
  }
  safeTimestamp(value.installed_at, "desired.installed_at")
  safeTimestamp(value.updated_at, "desired.updated_at")
  const canonical = canonicalJson(value, "desired", MAX_DESIRED_BYTES)
  return { ...canonical, value }
}

function lockJson(input: unknown) {
  if (input === undefined || input === null) return undefined
  const value = plainObject(input, "lock")
  boundedText(value.resolved_sha, "lock.resolved_sha", 300)
  plainObject(value.source, "lock.source")
  plainObject(value.manifest_digests, "lock.manifest_digests")
  plainObject(value.component_digests, "lock.component_digests")
  if (!Array.isArray(value.targets) || !value.targets.every((target) => HARNESS_TARGETS.has(String(target)))) {
    invalid("lock.targets contains an unsupported harness")
  }
  return { ...canonicalJson(value, "lock", MAX_LOCK_BYTES), value }
}

function canonicalJson(input: unknown, name: string, maxBytes: number) {
  let nodes = 0
  const seen = new Set<object>()
  const visit = (value: unknown, depth: number): unknown => {
    nodes++
    if (nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) invalid(`${name} is too complex`)
    if (value === null || typeof value === "string" || typeof value === "boolean") return value
    if (typeof value === "number") {
      if (!Number.isFinite(value)) invalid(`${name} contains a non-finite number`)
      return value
    }
    if (Array.isArray(value)) {
      if (seen.has(value)) invalid(`${name} contains a cycle`)
      seen.add(value)
      const result = value.map((item) => {
        if (item === undefined) invalid(`${name} contains undefined`)
        return visit(item, depth + 1)
      })
      seen.delete(value)
      return result
    }
    if (!value || typeof value !== "object") invalid(`${name} is not JSON-compatible`)
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) invalid(`${name} contains a non-plain object`)
    if (seen.has(value)) invalid(`${name} contains a cycle`)
    seen.add(value)
    const result: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      if (key.length > 200) invalid(`${name} contains an oversized key`)
      const item = (value as Record<string, unknown>)[key]
      if (item === undefined) invalid(`${name} contains undefined`)
      result[key] = visit(item, depth + 1)
    }
    seen.delete(value)
    return result
  }
  const text = JSON.stringify(visit(input, 0))
  if (new TextEncoder().encode(text).byteLength > maxBytes) invalid(`${name} exceeds ${maxBytes} bytes`)
  return { text }
}

function parseObjectJson(text: string, name: string) {
  try {
    return plainObject(JSON.parse(text), name)
  } catch (error) {
    if (error instanceof D1AgentExtensionAuthorityError) throw error
    throw new D1AgentExtensionAuthorityError("resource_conflict", `${name} is corrupt`)
  }
}

function plainObject(input: unknown, name: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid(`${name} must be an object`)
  const prototype = Object.getPrototypeOf(input)
  if (prototype !== Object.prototype && prototype !== null) invalid(`${name} must be a plain object`)
  return input as Record<string, unknown>
}

function safeTimestamp(input: unknown, name: string) {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 0) invalid(`${name} must be a timestamp`)
}

function policyScope(input: unknown): PolicyScope {
  if (input !== "org" && input !== "user" && input !== "workspace") invalid("scope is invalid")
  return input
}

function boundedText(input: unknown, name: string, max: number) {
  if (typeof input !== "string" || !input.trim()) invalid(`${name} is required`)
  const value = input.trim()
  if (value.length > max) invalid(`${name} exceeds ${max} characters`)
  return value
}

function optionalBoundedText(input: unknown, name: string, max: number) {
  if (input === undefined) return undefined
  return boundedText(input, name, max)
}

function changes(result: unknown) {
  return Number((result as { meta?: { changes?: number } })?.meta?.changes ?? 0)
}

function invalid(message: string): never {
  throw new D1AgentExtensionAuthorityError("invalid_input", message)
}

function denied() {
  return new ControlPlaneAuthError(403, "workspace_authorization_denied", "Workspace authority denied workspace access")
}
