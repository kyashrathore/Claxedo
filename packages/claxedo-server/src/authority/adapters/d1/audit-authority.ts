import type { D1Database } from "@cloudflare/workers-types"
import { ControlPlaneAuthError, type SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"

export const D1_AUDIT_AUTHORITY_METHODS = ["auditDeny", "auditAllow"] as const satisfies readonly (keyof WorkspaceAuthority)[]
export type D1AuditAuthorityPort = Pick<WorkspaceAuthority, (typeof D1_AUDIT_AUTHORITY_METHODS)[number]>

export type D1AuditAuthorityOptions = {
  deploymentId: string
  now?: () => number
  randomId?: () => string
  /** Per-deployment row cap. Production defaults to 10,000. */
  retentionLimit?: number
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
type WorkspaceRow = { workspace_id: string; org_id: string; project_id: string }

const AUDIT_METADATA_KEYS = new Set([
  "activeLeases",
  "cap",
  "driverResourceId",
  "expiresAt",
  "homeRegion",
  "hostId",
  "jti",
  "leaseEpoch",
  "hostLeaseExpiresAt",
  "orgId",
  "retryAfterMs",
  "runtimeKind",
])
const MAX_AUDIT_METADATA_BYTES = 4096

/**
 * Worker-safe bounded audit writer.
 *
 * Workspace attribution follows the retained rule: only a caller with
 * read access may file an event under a workspace. Denied or missing workspace
 * claims are kept separately as unverified attempts and never enter tenant
 * audit indexes. Metadata is a fixed scalar allowlist, not arbitrary JSON.
 */
export class D1AuditAuthority implements D1AuditAuthorityPort {
  private readonly now: () => number
  private readonly randomId: () => string
  private readonly retentionLimit: number

  constructor(
    private readonly database: D1Database,
    private readonly options: D1AuditAuthorityOptions,
  ) {
    requiredText(options.deploymentId, "deploymentId", 200)
    this.now = options.now ?? Date.now
    this.randomId = options.randomId ?? (() => `audit_${crypto.randomUUID()}`)
    const requested = options.retentionLimit ?? 10_000
    if (!Number.isSafeInteger(requested) || requested < 1 || requested > 100_000) {
      throw new TypeError("retentionLimit must be an integer from 1 through 100000")
    }
    this.retentionLimit = requested
  }

  async auditDeny(auth: SignedControlPlaneAuth | undefined, args: {
    action: string
    reason: string
    workspaceId?: string
    metadata?: Record<string, unknown>
  }) {
    // A deny-path audit call must not replace the caller's intended 4xx with a
    // telemetry 5xx. Failed/stale auth is recorded anonymously, and a storage
    // outage is allowed to drop this one diagnostic event.
    try {
      const who = auth ? await this.tryPrincipal(auth) : undefined
      await this.write(who, {
        result: "deny",
        action: auditText(args.action, "unknown", 200),
        reason: auditText(args.reason, "unspecified", 500),
        workspaceId: optionalAuditText(args.workspaceId, 300),
        metadata: safeMetadata(args.metadata),
      })
    } catch {
      // Deliberately total; see the retained Convex auditEvents.record contract.
    }
  }

  async auditAllow(auth: SignedControlPlaneAuth, args: {
    action: string
    workspaceId?: string
    metadata?: Record<string, unknown>
  }) {
    const who = await this.requirePrincipal(auth)
    await this.write(who, {
      result: "allow",
      action: auditText(args.action, "unknown", 200),
      workspaceId: optionalAuditText(args.workspaceId, 300),
      metadata: safeMetadata(args.metadata),
    })
  }

  private async write(who: Principal | undefined, input: {
    result: "allow" | "deny"
    action: string
    reason?: string
    workspaceId?: string
    metadata?: string
  }) {
    const workspace = who && input.workspaceId
      ? await this.attributedWorkspace(who, input.workspaceId)
      : undefined
    const attemptedWorkspaceId = input.workspaceId && !workspace ? input.workspaceId : null
    const now = this.now()
    await this.database.batch([
      this.database.prepare(`
        insert into authority_audit_events (
          event_id, deployment_id, user_id, actor_id, org_id, project_id, workspace_id,
          unverified_attempted_workspace_id, action, result, reason, metadata_json, created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        this.randomId(),
        this.options.deploymentId,
        who?.userId ?? null,
        who?.actorId ?? null,
        workspace?.org_id ?? null,
        workspace?.project_id ?? null,
        workspace?.workspace_id ?? null,
        attemptedWorkspaceId,
        input.action,
        input.result,
        input.reason ?? null,
        input.metadata ?? null,
        now,
      ),
      this.database.prepare(`
        delete from authority_audit_events
        where deployment_id = ? and event_id in (
          select event_id from authority_audit_events
          where deployment_id = ?
          order by created_at desc, event_id desc
          limit -1 offset ?
        )
      `).bind(this.options.deploymentId, this.options.deploymentId, this.retentionLimit),
    ])
  }

  private async attributedWorkspace(who: Principal, workspaceId: string) {
    return await this.database.prepare(`
      ${workspaceReadAccessCte()}
      select workspace_id, org_id, project_id from authorized_workspace
    `).bind(who.actorId, workspaceId).first<WorkspaceRow>()
  }

  private async tryPrincipal(auth: SignedControlPlaneAuth) {
    try {
      return await this.requirePrincipal(auth)
    } catch {
      return undefined
    }
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
}

function workspaceReadAccessCte() {
  return `with current_actor as (
    select actor.actor_id, actor.user_id
    from actors actor join users user on user.user_id = actor.user_id and user.state = 'active'
    where actor.actor_id = ? and actor.state = 'active'
  ), authorized_workspace as (
    select workspace.workspace_id, workspace.org_id, workspace.project_id
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
      or direct.user_id is not null or project_member.user_id is not null
  )`
}

function safeMetadata(input: Record<string, unknown> | undefined) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined
  const safe: Record<string, string | number | boolean | null> = {}
  for (const key of Object.keys(input).sort()) {
    if (!AUDIT_METADATA_KEYS.has(key)) continue
    const value = input[key]
    if (value === null || typeof value === "boolean") safe[key] = value
    else if (typeof value === "number" && Number.isFinite(value)) safe[key] = value
    else if (typeof value === "string" && value.length <= 500) safe[key] = value
  }
  if (Object.keys(safe).length === 0) return undefined
  const text = JSON.stringify(safe)
  return new TextEncoder().encode(text).byteLength <= MAX_AUDIT_METADATA_BYTES ? text : undefined
}

function auditText(input: unknown, fallback: string, max: number) {
  if (typeof input !== "string") return fallback
  const value = input.trim()
  return value ? value.slice(0, max) : fallback
}

function optionalAuditText(input: unknown, max: number) {
  if (typeof input !== "string") return undefined
  const value = input.trim()
  return value ? value.slice(0, max) : undefined
}

function requiredText(input: unknown, name: string, max: number) {
  if (typeof input !== "string" || !input.trim() || input.trim().length > max) {
    throw new TypeError(`${name} is required and must not exceed ${max} characters`)
  }
}
