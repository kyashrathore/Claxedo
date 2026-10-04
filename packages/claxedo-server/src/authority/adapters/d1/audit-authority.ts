import type { D1Database } from "@cloudflare/workers-types"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
import { accessChangeRowSql, requireHuman, type HumanPrincipal } from "./access-context"
import { maySql, type BoundSql } from "./authorization"

export const D1_AUDIT_AUTHORITY_METHODS = ["auditDeny", "auditAllow"] as const satisfies readonly (keyof WorkspaceAuthority)[]
export type D1AuditAuthorityPort = Pick<WorkspaceAuthority, (typeof D1_AUDIT_AUTHORITY_METHODS)[number]>

export type D1AuditAuthorityOptions = {
  deploymentId: string
  now?: () => number
  randomId?: () => string
  /**
   * Per-deployment cap on the rows this writer keeps. Production defaults to
   * 10,000. Access-change rows are outside it: deny rows are what any signed
   * caller can provoke, and they must not push the record of who granted what
   * out of the table.
   */
  retentionLimit?: number
}

type Principal = HumanPrincipal

const AUDIT_METADATA_KEYS = new Set([
  "activeLeases",
  "actor",
  "backing",
  "callerSessionId",
  "cap",
  "client",
  "driverResourceId",
  "expiresAt",
  "homeRegion",
  "hostId",
  "jti",
  "leaseEpoch",
  "hostLeaseExpiresAt",
  "orgId",
  "retryAfterMs",
  "sessionId",
  "tool",
  "workspaceId",
])
const MAX_AUDIT_METADATA_BYTES = 4096

/**
 * Worker-safe bounded audit writer.
 *
 * Workspace attribution follows the workspace rule: only a caller who may
 * open the workspace, its owner, files an event under it. Denied or missing workspace
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
      // Deliberately total; see the retained the authority auditEvents.record contract.
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
    const opens: BoundSql = who && input.workspaceId
      ? maySql(who, "open", { kind: "workspace", alias: "w" })
      : { sql: "0", bind: [] }
    const now = this.now()
    await this.database.batch([
      this.database.prepare(`
        insert into authority_audit_events (
          event_id, deployment_id, user_id, actor_id, org_id, project_id, workspace_id,
          unverified_attempted_workspace_id, action, result, reason, metadata_json, created_at
        )
        select ?, ?, ?, ?, w.org_id, w.project_id, w.workspace_id,
          case when w.workspace_id is null then ? end, ?, ?, ?, ?, ?
        from (select 1) audit_row
        left join workspaces w on w.workspace_id = ? and ${opens.sql}
      `).bind(
        this.randomId(),
        this.options.deploymentId,
        who?.userId ?? null,
        who?.actorId ?? null,
        input.workspaceId ?? null,
        input.action,
        input.result,
        input.reason ?? null,
        input.metadata ?? null,
        now,
        input.workspaceId ?? null,
        ...opens.bind,
      ),
      this.database.prepare(`
        delete from authority_audit_events
        where deployment_id = ? and event_id in (
          select event_id from authority_audit_events
          where deployment_id = ? and not ${accessChangeRowSql("action", "result")}
          order by created_at desc, event_id desc
          limit -1 offset ?
        )
      `).bind(this.options.deploymentId, this.options.deploymentId, this.retentionLimit),
    ])
  }

  private async tryPrincipal(auth: SignedControlPlaneAuth) {
    try {
      return await this.requirePrincipal(auth)
    } catch {
      return undefined
    }
  }

  private requirePrincipal(auth: SignedControlPlaneAuth): Promise<Principal> {
    return requireHuman(this.database, this.options.deploymentId, auth)
  }
}

/** Exported for the pin that every key an MCP audit record carries is allowlisted here. */
export function safeMetadata(input: Record<string, unknown> | undefined) {
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
