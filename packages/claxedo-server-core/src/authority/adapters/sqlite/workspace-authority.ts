import { timingSafeEqual } from "node:crypto"
import { sha256Hex } from "@claxedo/helpers/crypto"
import { isRecord } from "@claxedo/helpers/guards"
import { ControlPlaneAuthError, type SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { jsonString } from "@claxedo/server-core/platform/runtime/lib/json"
import { hostEnrollmentScope, hostSessionAuthority } from "@claxedo/server-core/platform/auth/authority"
import { asOrgId } from "@claxedo/server-core/platform/auth/branded-id"
import type {
  HostAssignmentAck,
  HostAssignmentDescription,
  HostConnectErrorCode,
  HostEnrollment,
  HostEnrollmentListRow,
  HostEnrollmentScope,
  HostInvitationRow,
  HostScopeDefinition,
  HostSessionAuthority,
  MachineAuthAdapter,
  MachinePrincipal,
  ProjectAction,
  ProjectRoleResult,
  SessionShareFanoutTarget,
  WorkspaceAuthority,
  WorkspaceShareTarget,
} from "@claxedo/server-core/platform/auth/authority"
import {
  directoryWithinRoots,
  invitationRedeemPayload,
  invitationToken,
  normalizePosixDirectory,
  normalizeStoredDirectory,
  publicKeyFingerprint,
} from "@claxedo/server-core/platform/auth/host-connect-contract"
import type { MachineAuthRefusal } from "@claxedo/server-core/platform/auth/machine-auth"
import { ClaxedoError } from "@claxedo/server-core/platform/errors/base"
import type { PrivateSessionAuthority } from "@claxedo/server-core/platform/auth/private-session-authority"
import type { SessionTurnAuthority } from "@claxedo/server-core/platform/auth/session-turn-authority"
import { randomToken } from "@claxedo/server-core/platform/auth/web-crypto"
import {
  activeOrgById,
  authorizeProjectForUser,
  authorizeWorkspaceForUser,
  ensurePersonalOrg,
  ensureProject,
  openAuthorityDb,
  orgAdminForUser,
  roleAtLeast,
  projectByPublicId,
  projectRoleForUser,
  sqliteRepoKey,
  upsertUser,
  userBySubject,
  usersBySubject,
  workspaceByPublicId,
  workspaceRoleForUser,
  type AuthorityUser,
  type ProjectRow,
  type IdentifiedSessionShareTargetRow,
  type SessionShareTargetRow,
  type SqliteAuthorityDb,
  type SqliteWorkspaceAuthorityOptions,
  type WorkspaceAction,
  type WorkspaceRow,
  type WorkspaceRole,
  type WorkspaceShareGrantRow,
} from "./workspace-authority-store"
import { createSqlitePrivateSessionAuthority } from "./private-session-authority"

// Claxedo's LOCAL workspace-authority adapter: the full `WorkspaceAuthority`
// port backed by a local SQLite database instead of the authority. This is the
// self-host enabler — a deployment with no hosted authority or identity env composes this
// authority so `requireAuthority` never fails 503 and workspace/session
// features work out of the box. Per-method semantics mirror the hosted
// backend functions (the workspace authority, the host-enrollment authority, ...).
// Node-only (better-sqlite3 via the store): hosted/Worker compositions must
// never import this module (worker.import-graph guard).

// Mirrors the host-enrollment authority TTL policy.
const DEFAULT_TTL_MS = 60_000
const MAX_TTL_MS = 5 * 60_000

/**
 * Machine-enrollment retention bounds, shared with the hosted host-enrollment
 * authority: the two are implementations of one contract and must retire the
 * same row at the same age, so these are not adapter defaults to tune.
 *
 * ENROLLMENT_CHALLENGE_TTL_MS — how long an unconsumed nonce may be signed.
 *   The nonce is one-use, owner-bound and host-bound, so the TTL is a bound on
 *   how many live unconsumed rows an attacker can hold (per-account budget x
 *   TTL), not the primary control. A client that takes longer — a first
 *   enrollment blocked on an OS keychain prompt — asks for another nonce;
 *   `POST /requests` mutates no enrollment, so the retry is free.
 *
 * ENROLLMENT_CONSUMED_RETENTION_MS — how long a consumed request row is kept,
 *   as the evidence an exact-retry answer is reconstructed from. Implemented by
 *   pushing `expires_at` out at consumption (`enrollHost`).
 *
 * ENROLLMENT_REQUEST_SWEEP_LIMIT — rows one prune may retire. A saturated pass
 *   leaves the rest for the next writer; an expired row stays expired, so
 *   nothing is skipped forever.
 */
const ENROLLMENT_CHALLENGE_TTL_MS = 60_000
const ENROLLMENT_CONSUMED_RETENTION_MS = 10 * 60_000
const ENROLLMENT_REQUEST_SWEEP_LIMIT = 500

/** A signed heartbeat payload must stay small; 200 shares per machine is generous. Mirrors the D1 authority. */
const MAX_ACKED_WORKSPACES = 200

/** Consumed machine-request nonces one heartbeat may sweep; the rest wait for the next beat. */
const NONCE_SWEEP_LIMIT = 500

const INVITATION_DEFAULT_TTL_MS = 60 * 60_000
const INVITATION_MIN_TTL_MS = 5 * 60_000
const INVITATION_MAX_TTL_MS = 24 * 60 * 60_000

type SqliteHostConnectErrorCode =
  | HostConnectErrorCode
  | MachineAuthRefusal["code"]
  | "host_attestation_denied"
  | "invalid_input"
  | "host_enrollment_not_found"
  | "workspace_not_found"

const HOST_CONNECT_ERROR_STATUS: Record<SqliteHostConnectErrorCode, number> = {
  invitation_invalid: 403,
  invitation_expired: 410,
  invitation_revoked: 410,
  invitation_redeemed: 409,
  invitation_host_conflict: 409,
  enrollment_generation_superseded: 409,
  host_assignment_outside_scope: 400,
  machine_headers_invalid: 400,
  machine_body_invalid: 400,
  machine_timestamp_skew: 401,
  machine_request_denied: 401,
  machine_nonce_replayed: 401,
  enrollment_revoked: 403,
  enrollment_paused: 403,
  enrollment_owner_ineligible: 403,
  enrollment_key_version_mismatch: 403,
  host_attestation_denied: 403,
  invalid_input: 400,
  host_enrollment_not_found: 404,
  workspace_not_found: 404,
}

export class SqliteHostConnectError extends ClaxedoError<SqliteHostConnectErrorCode> {
  constructor(code: SqliteHostConnectErrorCode, message: string, public readonly details?: Record<string, unknown>) {
    super({ code, message, status: HOST_CONNECT_ERROR_STATUS[code] })
  }
}

function ttl(input?: number) {
  if (!input || !Number.isFinite(input)) return DEFAULT_TTL_MS
  return Math.max(5_000, Math.min(input, MAX_TTL_MS))
}

function requiredText(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`)
  return value.trim()
}

function base64url(bytes: Uint8Array) {
  return Buffer.from(bytes).toString("base64url")
}

function enrollmentPayload(input: { host_id: string; request_id: string; nonce: string }) {
  // A versioned, domain-prefixed payload. Payload domains must not overlap: a
  // signature captured from one flow being replayable in another is exactly
  // what a prefix prevents.
  return [
    "claxedo.host-enrollment.enroll.v1",
    `host_id=${input.host_id}`,
    `request_id=${input.request_id}`,
    `nonce=${input.nonce}`,
  ].join("\n")
}

/**
 * Heartbeat v2: the machine's ONE signature per interval also covers the
 * workspaces it currently serves (sorted, comma-joined). Routing requires a
 * workspace to be BOTH owner-assigned and inside this acked set, which
 * preserves the retired per-workspace signature's security property — an
 * owner session cannot conjure serving the machine never consented to — at
 * one signature instead of N+1. Same literal as the D1 authority's
 * `hostEnrollmentHeartbeatPayloadV2`: two authorities, one signed contract.
 */
function heartbeatEnrollmentPayloadV2(input: {
  host_id: string
  ttl_ms?: number
  workspace_ids: readonly string[]
}) {
  return [
    "claxedo.host-enrollment.heartbeat.v2",
    `host_id=${input.host_id}`,
    `ttl_ms=${input.ttl_ms ?? ""}`,
    `workspaces=${[...input.workspace_ids].sort().join(",")}`,
  ].join("\n")
}

type HostEnrollmentRow = {
  enrollment_id: string
  owner_token_identifier: string
  host_id: string
  public_key: string
  display_name: string | null
  last_seen_at: number
  expires_at: number
  paused_at: number | null
  revoked_at: number | null
  acked_workspace_ids: string | null
  acked_at: number | null
  session_authority: string | null
  key_version: number
  serving_generation: number
  generation_acquired_at: number | null
  enrolled_via: string
  scope_json: string | null
  scope_revision: number
  created_at: number
}

type HostInvitationRowRecord = {
  invitation_id: string
  owner_token_identifier: string
  org_id: string | null
  secret_hash: string
  display_name: string | null
  scope_json: string
  expires_at: number
  redeemed_at: number | null
  redeemed_enrollment_id: string | null
  redeemed_host_id: string | null
  redeemed_public_key_fingerprint: string | null
  created_at: number
  revoked_at: number | null
}

function enrollmentScope(row: Pick<HostEnrollmentRow, "scope_json" | "scope_revision">) {
  return hostEnrollmentScope(row.scope_json, row.scope_revision)
}

/** 0 withholds the implicit org-member role; an account enrollment has no scope and hides nothing. */
function orgMemberVisible(scope: HostScopeDefinition | undefined) {
  return scope?.visibility === "owner" ? 0 : 1
}

function validatedScope(input: HostScopeDefinition): HostScopeDefinition {
  if (!Array.isArray(input.allowed_roots) || (input.visibility !== "owner" && input.visibility !== "org")) {
    throw new SqliteHostConnectError("invalid_input", "scope requires allowed_roots and a visibility")
  }
  const roots = input.allowed_roots.map((root) => {
    const normalized = typeof root === "string" ? normalizePosixDirectory(root) : undefined
    if (normalized === undefined) {
      throw new SqliteHostConnectError("invalid_input", `scope root must be an absolute POSIX path: ${JSON.stringify(root)}`)
    }
    return normalized
  })
  return { allowed_roots: [...new Set(roots)], visibility: input.visibility }
}

function scopeDefinitionJson(json: string): HostScopeDefinition {
  const scope = hostEnrollmentScope(json, 0)
  if (!scope) throw new Error("host_invitation_scope_malformed")
  return { allowed_roots: scope.allowed_roots, visibility: scope.visibility }
}

/**
 * The public P-256 JWK a machine presents, or a refusal. `d` must be absent:
 * a private key stored as the public one would still verify and would leak
 * through every later read of the row.
 */
function publicHostKey(publicKey: string): JsonWebKey | undefined {
  let jwk: unknown
  try {
    jwk = JSON.parse(publicKey)
  } catch {
    return undefined
  }
  if (!isRecord(jwk)) return undefined
  const { kty, crv, x, y, d } = jwk
  if (kty !== "EC" || crv !== "P-256" || typeof x !== "string" || typeof y !== "string" || d !== undefined) {
    return undefined
  }
  return { kty, crv, x, y }
}

function secretHashMatches(stored: string, presented: string) {
  const a = Buffer.from(stored, "utf8")
  const b = Buffer.from(presented, "utf8")
  return a.length === b.length && timingSafeEqual(a, b)
}

type HostEnrollmentRequestRow = {
  request_id: string
  owner_token_identifier: string
  host_id: string
  nonce: string
  expires_at: number
  used_at: number | null
}

/** Row → what an owner may see. The public key never crosses this boundary. */
function toHostEnrollment(row: HostEnrollmentRow): HostEnrollment {
  return {
    enrollment_id: row.enrollment_id,
    host_id: row.host_id,
    ...(row.display_name ? { display_name: row.display_name } : {}),
    expires_at: row.expires_at,
    last_seen_at: row.last_seen_at,
    created_at: row.created_at,
  }
}

async function verifyHostSignature(input: {
  public_key: string
  payload: string
  signature: string
}) {
  const jwk = JSON.parse(input.public_key)
  if (jwk?.kty !== "EC" || jwk?.crv !== "P-256") throw new Error("Invalid host public key")
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  )
  if (!await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    Buffer.from(input.signature, "base64url"),
    new TextEncoder().encode(input.payload),
  )) {
    throw new Error("Invalid host attestation")
  }
}

/**
 * The one definition of "a host is serving this workspace right now": an
 * enrollment that is neither revoked nor paused, whose lease has not expired,
 * and whose readiness row for this workspace names the enrollment's current
 * serving generation and the assignment's current revision. Written against
 * an `assignment`/`enrollment` join, and binding exactly one value — `now`.
 *
 * `activeWorkspaceHost` answers it for one workspace; `listWorkspaces` stamps
 * it on every user-hosted row so the rail can say "host offline" before any
 * pane opens the workspace; the relay resolver's `user-hosted-relay-target.ts`
 * routes by it with no principal — all three must mean the same thing.
 * Mirrors the D1 adapter's `HOST_SERVING_WORKSPACE_SQL`. A re-pointed
 * directory (new revision) or a superseded instance (new generation) stops
 * routing on the next read, not on the next token.
 */
export const HOST_SERVING_WORKSPACE_SQL = `enrollment.revoked_at IS NULL AND enrollment.paused_at IS NULL
          AND enrollment.expires_at > ?
          AND EXISTS (
            SELECT 1 FROM host_assignment_readiness readiness
            WHERE readiness.workspace_id = assignment.workspace_id
              AND readiness.enrollment_id = enrollment.enrollment_id
              AND readiness.generation = enrollment.serving_generation
              AND readiness.revision = assignment.revision
          )`

/**
 * Owner eligibility in this adapter: the owner's `users` row exists. The
 * table has no state or deleted column and there is no actors table, so row
 * existence is the whole predicate. `alias` names the enrollment row in the
 * enclosing statement.
 */
function ownerEligibleSql(alias: string) {
  return `EXISTS (SELECT 1 FROM users WHERE users.token_identifier = ${alias}.owner_token_identifier)`
}

/**
 * The predicate every machine-caller mutation re-asserts inside its own
 * transaction, binding `enrollment_id` then `key_version`: a key replaced or
 * an owner removed between verification and write makes the write a no-op.
 */
function machineMutationGuardSql(alias: string) {
  return `${alias}.enrollment_id = ? AND ${alias}.key_version = ?
    AND ${alias}.revoked_at IS NULL AND ${alias}.paused_at IS NULL AND ${ownerEligibleSql(alias)}`
}

/**
 * Why a guarded machine mutation wrote nothing, read back after the fact.
 * The verifier already refused the cheap cases; this names the one that
 * changed between verification and the write.
 */
function machineMutationRefusal(db: SqliteAuthorityDb, machine: MachinePrincipal, input: { generation?: number }) {
  const row = db.prepare<unknown[], HostEnrollmentRow & { owner_eligible: number }>(`
    SELECT enrollment.*, ${ownerEligibleSql("enrollment")} AS owner_eligible
    FROM host_enrollments enrollment WHERE enrollment.enrollment_id = ?
  `).get(machine.enrollmentId)
  if (!row) return new SqliteHostConnectError("machine_request_denied", "Host enrollment not found")
  if (row.revoked_at !== null) return new SqliteHostConnectError("enrollment_revoked", "Host enrollment was revoked")
  if (row.paused_at !== null) return new SqliteHostConnectError("enrollment_paused", "Host enrollment is paused")
  if (row.owner_eligible !== 1) return new SqliteHostConnectError("enrollment_owner_ineligible", "Enrollment owner is not eligible")
  if (row.key_version !== machine.keyVersion) {
    return new SqliteHostConnectError("enrollment_key_version_mismatch", "Host key was replaced")
  }
  if (input.generation !== undefined && row.serving_generation !== input.generation) {
    return sqliteGenerationSuperseded(row.serving_generation)
  }
  return new Error("host_enrollment_mutation_refused")
}

function sqliteGenerationSuperseded(servingGeneration: number) {
  return new SqliteHostConnectError(
    "enrollment_generation_superseded",
    "A newer instance of this machine has acquired the serving generation",
    { serving_generation: servingGeneration },
  )
}

function recordHostAudit(db: SqliteAuthorityDb, input: {
  tokenIdentifier: string
  action: string
  workspaceId?: string
  metadata?: Record<string, unknown>
}) {
  db.prepare(`
    INSERT INTO audit_events (token_identifier, workspace_id, action, result, metadata, created_at)
    VALUES (?, ?, ?, 'allow', ?, ?)
  `).run(input.tokenIdentifier, input.workspaceId ?? null, input.action, input.metadata ? JSON.stringify(input.metadata) : null, Date.now())
}

function redeemResult(db: SqliteAuthorityDb, input: {
  resumed: boolean
  enrollment: HostEnrollmentRow
  invitation: HostInvitationRowRecord
}) {
  const owner = db.prepare<unknown[], { name: string | null }>(`SELECT name FROM users WHERE token_identifier = ?`)
    .get(input.invitation.owner_token_identifier)
  const scope = enrollmentScope(input.enrollment)
  if (!scope) throw new Error("host_enrollment_scope_missing")
  return {
    resumed: input.resumed,
    enrollment: toHostEnrollment(input.enrollment),
    owner_user_id: input.invitation.owner_token_identifier,
    owner_actor_id: input.invitation.owner_token_identifier,
    ...(input.invitation.org_id ? { org_id: input.invitation.org_id } : {}),
    ...(owner?.name ? { owner_display_name: owner.name } : {}),
    key_version: input.enrollment.key_version,
    serving_generation: input.enrollment.serving_generation,
    scope,
  }
}

type LeaseRenewal = {
  expires_at: number
  last_seen_at: number
  assignments: HostAssignmentDescription[]
  scope: HostEnrollmentScope | undefined
  assigned_workspace_ids: string[]
}

/**
 * The lease renewal both heartbeat callers share. Must run inside the caller's
 * transaction: the guarded enrollment UPDATE and the readiness rewrite are
 * one statement group, or a refused beat could still mark workspaces ready.
 * Returns undefined when `where` admitted no row.
 */
function renewLease(db: SqliteAuthorityDb, input: {
  enrollmentId: string
  ttlMs?: number
  /** `"current"` acks whatever revision the assignment holds now (account v2 callers, which do not see revisions). */
  acks: Array<{ workspaceId: string; revision: number | "current" }>
  sessionAuthority?: HostSessionAuthority
  where: { sql: string; params: unknown[] }
}): LeaseRenewal | undefined {
  const now = Date.now()
  const expiresAt = now + ttl(input.ttlMs)
  const ackedIds = input.acks.map((ack) => ack.workspaceId).sort()
  const changed = db.prepare(`
    UPDATE host_enrollments SET
      last_seen_at = ?, expires_at = ?, updated_at = ?, acked_workspace_ids = ?, acked_at = ?,
      session_authority = ?
    WHERE ${input.where.sql}
  `).run(
    now,
    expiresAt,
    now,
    JSON.stringify(ackedIds),
    now,
    // The latest beat is the whole truth about the machine's composition:
    // a host that stops declaring is undeclared again, so this assigns
    // rather than coalesces.
    hostSessionAuthority(input.sessionAuthority) ?? null,
    ...input.where.params,
  ).changes
  if (changed !== 1) return undefined
  const row = db.prepare<unknown[], HostEnrollmentRow>(`SELECT * FROM host_enrollments WHERE enrollment_id = ?`)
    .get(input.enrollmentId)
  if (!row) throw new Error("host_enrollment_missing_after_renewal")

  // Readiness is rewritten from this beat alone: an ack for a revision the
  // assignment no longer holds writes nothing, and a workspace the host
  // stopped acking loses its row.
  const ready = db.prepare(`
    INSERT INTO host_assignment_readiness (workspace_id, enrollment_id, generation, revision, ready_at)
    SELECT assignment.workspace_id, ?, ?, assignment.revision, ?
    FROM host_workspace_assignments assignment
    WHERE assignment.workspace_id = ? AND assignment.host_id = ? AND assignment.owner_token_identifier = ?
      AND (? IS NULL OR assignment.revision = ?)
    ON CONFLICT (workspace_id) DO UPDATE SET
      enrollment_id = excluded.enrollment_id,
      generation = excluded.generation,
      revision = excluded.revision,
      ready_at = excluded.ready_at
  `)
  for (const ack of input.acks) {
    const revision = ack.revision === "current" ? null : ack.revision
    ready.run(row.enrollment_id, row.serving_generation, now, ack.workspaceId, row.host_id, row.owner_token_identifier, revision, revision)
  }
  db.prepare(`
    DELETE FROM host_assignment_readiness
    WHERE enrollment_id = ? AND workspace_id NOT IN (SELECT value FROM json_each(?))
  `).run(row.enrollment_id, JSON.stringify(ackedIds))

  // The owner's assignment view rides back on every ack so the machine can
  // reconcile its persisted set — without this, machine consent and owner
  // intent drift apart silently forever.
  const assignments = hostAssignments(db, row.host_id, row.owner_token_identifier)
  return {
    expires_at: expiresAt,
    last_seen_at: now,
    assignments: assignments.descriptions,
    scope: enrollmentScope(row),
    assigned_workspace_ids: assignments.workspace_ids,
  }
}

/**
 * The owner's assignments to one host. A workspace with no directory is
 * assigned but not describable: it is in `workspace_ids` for reconciliation
 * and absent from `descriptions`.
 */
function hostAssignments(db: SqliteAuthorityDb, hostId: string, ownerTokenIdentifier: string) {
  const rows = db.prepare<unknown[], {
    workspace_id: string
    revision: number
    remote_directory: string | null
    display_name: string | null
  }>(`
    SELECT assignment.workspace_id, assignment.revision, workspace.remote_directory, workspace.display_name
    FROM host_workspace_assignments assignment
    JOIN workspaces workspace ON workspace.workspace_id = assignment.workspace_id
    WHERE assignment.host_id = ? AND assignment.owner_token_identifier = ? AND workspace.deleted_at IS NULL
    ORDER BY assignment.workspace_id
  `).all(hostId, ownerTokenIdentifier)
  return {
    workspace_ids: rows.map((assignment) => assignment.workspace_id),
    descriptions: rows.flatMap((assignment): HostAssignmentDescription[] => assignment.remote_directory === null ? [] : [{
      workspace_id: assignment.workspace_id,
      remote_directory: assignment.remote_directory,
      ...(assignment.display_name ? { display_name: assignment.display_name } : {}),
      revision: assignment.revision,
    }]),
  }
}

/** Of these workspaces, the ones a live enrollment currently serves. */
function workspacesWithServingHost(db: SqliteAuthorityDb, workspaceIds: string[]) {
  if (workspaceIds.length === 0) return new Set<string>()
  const rows = db.prepare<unknown[], { workspace_id: string }>(`
    SELECT DISTINCT assignment.workspace_id
    FROM host_workspace_assignments assignment
    JOIN host_enrollments enrollment ON enrollment.host_id = assignment.host_id
      AND enrollment.owner_token_identifier = assignment.owner_token_identifier
    WHERE assignment.workspace_id IN (${workspaceIds.map(() => "?").join(", ")})
      AND ${HOST_SERVING_WORKSPACE_SQL}
  `).all(...workspaceIds, Date.now())
  return new Set(rows.map((row) => row.workspace_id))
}

/**
 * A user-hosted workspace exists in the inventory exactly as long as a machine
 * is assigned to serve it: unsharing it or revoking its machine retires the
 * row, and sharing it again revives the same record. Cloud rows are never
 * touched here — their lifetime is the sandbox's.
 */
function retireUserHostedWorkspaceSql(where: string) {
  return `
    UPDATE workspaces SET deleted_at = ?, updated_at = ?
    WHERE access = 'user-hosted' AND deleted_at IS NULL AND ${where}
  `
}

function refuseCloudWorkspace(workspace: { backing?: unknown; access?: unknown }) {
  if (workspace.backing === "cloud-vm" || workspace.access === "cloud") {
    throw new Error("workspace_backing_conflict: cannot attach a local host link to a cloud workspace")
  }
}

// Mirrors `KNOWN_HOME_REGIONS` in the workspace authority: validate only, never default.
const KNOWN_HOME_REGIONS = ["apac-south", "apac-east", "eu-west", "us-east", "us-west"]

function validatedHomeRegion(input?: string) {
  if (input === undefined) return undefined
  if (!KNOWN_HOME_REGIONS.includes(input)) {
    throw new Error(`home_region_invalid: ${input} is not a known Claxedo region`)
  }
  return input
}

function defaultProjectId() {
  return `prj_${randomToken()}`
}

function denied(): never {
  throw new ControlPlaneAuthError(403, "workspace_authorization_denied", "Workspace authority denied workspace access")
}

type ShareTarget = {
  primaryKey: string
  activeKeys: string[]
  tokenIdentifier?: string
  subject?: string
  orgId?: string
  teamId?: string
  teamOrgId?: string
}

function shareTarget(db: SqliteAuthorityDb, args: {
  grantedToTokenIdentifier?: string
  grantedToSubject?: string
  grantedToOrgId?: string
  grantedToTeamId?: string
  grantedToTeamPublicId?: string
}, options: { requireExisting: boolean }): ShareTarget {
  const selectors = [
    args.grantedToTokenIdentifier,
    args.grantedToSubject,
    args.grantedToOrgId,
    args.grantedToTeamId,
    args.grantedToTeamPublicId,
  ].filter(Boolean)
  if (selectors.length !== 1) throw new Error("Share target must be exactly one user, org, or team")

  if (args.grantedToTokenIdentifier) {
    const target = db.prepare<unknown[], AuthorityUser>(`SELECT token_identifier, subject FROM users WHERE token_identifier = ?`)
      .get(args.grantedToTokenIdentifier)
    if (!target && options.requireExisting) throw new Error("Share target not found")
    const legacySubjectKey = target?.subject && userBySubject(db, target.subject)?.token_identifier === target.token_identifier
      ? `subject:${target.subject}`
      : undefined
    return {
      primaryKey: `token:${args.grantedToTokenIdentifier}`,
      activeKeys: [`token:${args.grantedToTokenIdentifier}`, legacySubjectKey].filter((value): value is string => !!value),
      tokenIdentifier: args.grantedToTokenIdentifier,
    }
  }

  if (args.grantedToSubject) {
    const subjectUsers = usersBySubject(db, args.grantedToSubject)
    if (subjectUsers.length > 1) denied()
    const target = subjectUsers[0]
    if (!target && options.requireExisting) throw new Error("Share target not found")
    return target
      ? {
          primaryKey: `token:${target.token_identifier}`,
          activeKeys: [`token:${target.token_identifier}`, `subject:${args.grantedToSubject}`],
          subject: args.grantedToSubject,
        }
      : {
          primaryKey: `subject:${args.grantedToSubject}`,
          activeKeys: [`subject:${args.grantedToSubject}`],
          subject: args.grantedToSubject,
        }
  }

  const teamSelector = args.grantedToTeamId ?? args.grantedToTeamPublicId
  if (teamSelector) {
    const team = db.prepare<unknown[], { team_id: string; org_id: string }>(`
      SELECT team_id, org_id FROM teams WHERE team_id = ? AND deleted_at IS NULL
    `).get(teamSelector)
    if (!team && options.requireExisting) throw new Error("Share target not found")
    const teamId = team?.team_id ?? teamSelector
    return {
      primaryKey: `team:${teamId}`,
      activeKeys: [`team:${teamId}`],
      teamId,
      ...(team ? { teamOrgId: team.org_id } : {}),
    }
  }

  const orgSelector = args.grantedToOrgId!
  const org = activeOrgById(db, orgSelector)
  if (!org && options.requireExisting) throw new Error("Share target not found")
  const orgId = org?.org_id ?? orgSelector
  return {
    primaryKey: `org:${orgId}`,
    activeKeys: [...new Set([`org:${orgId}`, `org:${orgSelector}`])],
    orgId,
  }
}

function canonicalShareTarget(
  db: SqliteAuthorityDb,
  target: WorkspaceShareTarget,
  options: { requireExisting: boolean },
) {
  if (target.kind === "actor") {
    return shareTarget(db, { grantedToTokenIdentifier: requiredText(target.actorId, "actorId") }, options)
  }
  if (target.kind === "user") {
    return shareTarget(db, { grantedToTokenIdentifier: requiredText(target.userId, "userId") }, options)
  }
  return shareTarget(db, { grantedToOrgId: requiredText(target.orgId, "orgId") }, options)
}

function jsonText(input: unknown) {
  try {
    return JSON.stringify(input) ?? "null"
  } catch {
    return "null"
  }
}

function workspaceJson(workspace: WorkspaceRow) {
  return {
    workspace_id: workspace.workspace_id,
    org_id: workspace.org_id ?? undefined,
    project_id: workspace.project_id ?? undefined,
    backing: workspace.backing,
    access: workspace.access,
    home_region: workspace.home_region ?? undefined,
    display_name: workspace.display_name ?? undefined,
    repo_url: workspace.repo_url ?? undefined,
    repo_name: workspace.repo_name ?? undefined,
    git_branch: workspace.git_branch ?? undefined,
    remote_directory: workspace.remote_directory ?? undefined,
  }
}

export function createSqliteWorkspaceAuthority(
  options: SqliteWorkspaceAuthorityOptions = {},
): WorkspaceAuthority & PrivateSessionAuthority & SessionTurnAuthority & {
  close(): void
  /** D1 parity: revoke the machine key and cascade its assignments and runtime tokens. */
  revokeHostEnrollment(
    auth: SignedControlPlaneAuth,
    args: { hostId?: string },
  ): Promise<{ revoked: number; runtime_tokens_revoked: number }>
} {
  const database = openAuthorityDb(options)

  const user = (auth: SignedControlPlaneAuth): AuthorityUser => {
    const db = database()
    return upsertUser(db, {
      token_identifier: auth.user.tokenIdentifier,
      subject: auth.user.subject,
      issuer: auth.user.issuer,
      kind: "human",
    })
  }

  const requireWorkspace = (db: SqliteAuthorityDb, who: AuthorityUser, workspaceId: string, action: WorkspaceAction) => {
    const workspace = workspaceByPublicId(db, workspaceId)
    if (!workspace || workspace.deleted_at || !authorizeWorkspaceForUser(db, workspace, who, action)) {
      throw new Error("Workspace not found")
    }
    return workspace
  }

  const ownedProject = (db: SqliteAuthorityDb, who: AuthorityUser, input: {
    workspaceId: string
    orgId?: string
    projectId?: string
    repoUrl?: string
    remoteDirectory?: string
  }) => {
    const orgId = input.orgId ?? ensurePersonalOrg(db, who)
    if (input.orgId) {
      const membership = db.prepare<unknown[], { role: string }>(`
        SELECT m.role FROM org_memberships m
        JOIN orgs o ON o.org_id = m.org_id
        WHERE m.org_id = ? AND m.token_identifier = ? AND o.deleted_at IS NULL
      `).get(input.orgId, who.token_identifier)
      if (membership?.role !== "owner" && membership?.role !== "admin") denied()
    }
    const projectId = ensureProject(db, {
      projectId: input.projectId ?? defaultProjectId(),
      orgId,
      repoKey: sqliteRepoKey(input.repoUrl ?? input.remoteDirectory, input.workspaceId),
      owner: who,
    })
    return { orgId, projectId }
  }

  const revokeRuntimeTokensForUsers = (db: SqliteAuthorityDb, workspaceId: string, tokenIdentifiers: string[]) => {
    if (!tokenIdentifiers.length) return 0
    const now = Date.now()
    let revoked = 0
    for (const tokenIdentifier of tokenIdentifiers) {
      revoked += db.prepare(`
        UPDATE runtime_access_tokens SET revoked_at = ?
        WHERE workspace_id = ? AND actor_id = ? AND revoked_at IS NULL
      `).run(now, workspaceId, tokenIdentifier).changes
    }
    return revoked
  }

  const linkedChannelUser = (
    db: SqliteAuthorityDb,
    args: { channel: string; externalUserId: string },
  ): AuthorityUser | undefined => {
    const link = db.prepare<unknown[], { token_identifier: string }>(`
      SELECT token_identifier FROM channel_identities
      WHERE channel = ? AND external_user_id = ? AND revoked_at IS NULL
    `).get(args.channel, args.externalUserId)
    if (!link) return undefined
    return db.prepare<unknown[], AuthorityUser>(`SELECT token_identifier, public_id, subject, name, image_url FROM users WHERE token_identifier = ?`)
      .get(link.token_identifier)
  }

  type SessionRow = {
    session_id: string
    workspace_id: string
    creator_actor_id: string
    title: string | null
    created_at: number
    updated_at: number
    deleted_at: number | null
  }

  const sessionRoleForWorkspaceUser = (
    db: SqliteAuthorityDb,
    workspace: WorkspaceRow,
    session: SessionRow,
    who: AuthorityUser,
    workspaceRole: WorkspaceRole,
    isOrgAdmin?: boolean,
  ): WorkspaceRole | undefined => {
    if (session.creator_actor_id === who.token_identifier) return workspaceRole
    const participant = db.prepare<unknown[], { revoked_at: number | null }>(`
      SELECT revoked_at FROM session_participants WHERE session_id = ? AND participant_actor_id = ?
    `).get(session.session_id, who.token_identifier)
    if (participant && !participant.revoked_at) return workspaceRole
    if (sessionShareAllowsUser(db, who, session.session_id)) return workspaceRole
    if (isOrgAdmin ?? orgAdminForUser(db, who, workspace.org_id)) return workspaceRole
    return undefined
  }

  const sessionShareAllowsUser = (db: SqliteAuthorityDb, who: AuthorityUser, sessionId: string) => {
    const grants = db.prepare<unknown[], SessionShareTargetRow>(`
      SELECT granted_to_user_token_identifier, granted_to_org_id, granted_to_team_id
      FROM session_share_grants
      WHERE session_id = ? AND revoked_at IS NULL
    `).all(sessionId)
    for (const grant of grants) {
      if (grant.granted_to_user_token_identifier === who.token_identifier) return true
      if (grant.granted_to_org_id) {
        const membership = db.prepare(`
          SELECT 1 FROM org_memberships WHERE org_id = ? AND token_identifier = ?
        `).get(grant.granted_to_org_id, who.token_identifier)
        if (membership) return true
      }
      if (grant.granted_to_team_id) {
        const membership = db.prepare(`
          SELECT 1 FROM team_memberships WHERE team_id = ? AND user_token_identifier = ?
        `).get(grant.granted_to_team_id, who.token_identifier)
        if (membership) return true
      }
    }
    return false
  }

  const teamAdminForProject = (db: SqliteAuthorityDb, who: AuthorityUser, workspace: WorkspaceRow) => {
    if (!workspace.org_id || !workspace.project_id) return false
    const memberships = db.prepare<unknown[], { team_id: string; role: string }>(`
      SELECT m.team_id AS team_id, m.role AS role FROM team_memberships m
      JOIN teams t ON t.team_id = m.team_id
      WHERE m.user_token_identifier = ? AND t.org_id = ? AND t.deleted_at IS NULL
        AND (m.role = 'admin' OR m.role = 'owner')
    `).all(who.token_identifier, workspace.org_id)
    for (const membership of memberships) {
      const grant = db.prepare(`
        SELECT 1 FROM team_project_grants
        WHERE team_id = ? AND project_id = ? AND revoked_at IS NULL
      `).get(membership.team_id, workspace.project_id)
      if (grant) return true
    }
    return false
  }

  // Mirror of the project authority `authResult`: role (optionally action-gated)
  // + the org check; no role or no org → { ok: false }.
  const projectResultFor = (
    db: SqliteAuthorityDb,
    project: ProjectRow,
    who: AuthorityUser,
    input: { action?: ProjectAction; orgId?: string },
  ): ProjectRoleResult => {
    const role = input.action
      ? authorizeProjectForUser(db, project, who, input.action)
      : projectRoleForUser(db, project, who)
    if (!role || !project.org_id) return { ok: false }
    if (input.orgId && input.orgId !== project.org_id) return { ok: false }
    return { ok: true, role, orgId: asOrgId(project.org_id) }
  }

  const recordUserRuntimeToken = (who: AuthorityUser, args: Parameters<WorkspaceAuthority["recordRuntimeAccessToken"]>[1]) => {
      const db = database()
      const workspace = requireWorkspace(db, who, args.workspaceId, "read")
      const currentRole = workspaceRoleForUser(db, workspace, who)
      if (!currentRole || !roleAtLeast(currentRole, args.role)) denied()
      const existing = db.prepare(`SELECT jti FROM runtime_access_tokens WHERE jti = ?`).get(args.jti)
      if (existing) throw new Error("Runtime Access Token already recorded")
      db.prepare(`
        INSERT INTO runtime_access_tokens
          (jti, workspace_id, host_id, principal_kind, actor_id, actor_kind, role, minted_for_token_identifier, expires_at, created_at)
        VALUES (?, ?, ?, 'user', ?, ?, ?, ?, ?, ?)
      `).run(args.jti, args.workspaceId, args.hostId, args.actorId, args.actorKind, args.role, who.token_identifier, args.expiresAt, Date.now())
      return { ok: true }
  }

  const privateSessions = createSqlitePrivateSessionAuthority({ database, principal: user })

  const workspaceAuthority: Omit<WorkspaceAuthority, keyof PrivateSessionAuthority> & {
    close(): void
    revokeHostEnrollment(
      auth: SignedControlPlaneAuth,
      args: { hostId?: string },
    ): Promise<{ revoked: number; runtime_tokens_revoked: number }>
  } = {
    close() {
      database.close()
    },
    // --- identity (users, orgs, projects) ------------------------------------
    async usersMe(auth: SignedControlPlaneAuth) {
      const db = database()
      const who = user(auth)
      const orgId = ensurePersonalOrg(db, who)
      return {
        user_id: who.token_identifier,
        actor_id: who.token_identifier,
        actor_kind: who.kind === "agent" ? "agent" as const : "human" as const,
        actor_public_id: who.public_id,
        actor_name: who.name ?? (who.kind === "agent" ? "Agent" : "User"),
        actor_avatar_url: who.image_url,
        subject: who.subject,
        token_identifier: who.token_identifier,
        org_id: orgId,
      }
    },
    async listOrgs(auth: SignedControlPlaneAuth) {
      const db = database()
      const who = user(auth)
      ensurePersonalOrg(db, who)
      return db.prepare(`
        SELECT o.org_id, o.name, m.role FROM org_memberships m
        JOIN orgs o ON o.org_id = m.org_id
        WHERE m.token_identifier = ? AND o.deleted_at IS NULL
      `).all(who.token_identifier)
    },
    async createOrg(auth: SignedControlPlaneAuth, args: { name: string }) {
      const db = database()
      const who = user(auth)
      const name = args.name.trim()
      if (!name) throw new Error("org_name_required")
      const now = Date.now()
      const orgId = `org_${randomToken()}`
      const teamId = `team_${randomToken()}`
      db.transaction(() => {
        db.prepare(`
          INSERT INTO orgs (org_id, name, kind, owner_token_identifier, created_at, updated_at)
          VALUES (?, ?, 'team', ?, ?, ?)
        `).run(orgId, name, who.token_identifier, now, now)
        db.prepare(`
          INSERT INTO org_memberships (org_id, token_identifier, role, created_at, updated_at)
          VALUES (?, ?, 'owner', ?, ?)
        `).run(orgId, who.token_identifier, now, now)
        db.prepare(`
          INSERT INTO teams (team_id, org_id, name, is_default, created_by_token_identifier, created_at, updated_at)
          VALUES (?, ?, 'Everyone', 1, ?, ?, ?)
        `).run(teamId, orgId, who.token_identifier, now, now)
        db.prepare(`
          INSERT INTO team_memberships (team_id, user_token_identifier, role, created_at, updated_at)
          VALUES (?, ?, 'owner', ?, ?)
        `).run(teamId, who.token_identifier, now, now)
      })()
      return { org_id: orgId, name, role: "owner" as const, default_team_id: teamId }
    },
    async listTeams(auth: SignedControlPlaneAuth, args: { orgId: string }) {
      const db = database()
      const who = user(auth)
      const org = db.prepare<unknown[], { org_id: string; owner_token_identifier: string }>(`SELECT org_id, owner_token_identifier FROM orgs WHERE org_id = ? AND deleted_at IS NULL`)
        .get(args.orgId)
      if (!org) return []
      const membership = db.prepare(`
        SELECT 1 FROM org_memberships WHERE org_id = ? AND token_identifier = ?
      `).get(args.orgId, who.token_identifier)
      if (!membership && org.owner_token_identifier !== who.token_identifier) return []
      return db.prepare(`
        SELECT team_id, org_id, name, is_default FROM teams
        WHERE org_id = ? AND deleted_at IS NULL
        ORDER BY name ASC
      `).all(args.orgId).map((row: any) => ({
        team_id: row.team_id,
        org_id: row.org_id,
        name: row.name,
        is_default: row.is_default === 1,
      }))
    },
    async createTeamInOrg(auth: SignedControlPlaneAuth, args: { orgId: string; name: string }) {
      const db = database()
      const who = user(auth)
      const name = args.name.trim()
      if (!name) throw new Error("team_name_required")
      const org = db.prepare<unknown[], { org_id: string; kind: string }>(`SELECT org_id, kind FROM orgs WHERE org_id = ? AND deleted_at IS NULL`)
        .get(args.orgId)
      if (!org) throw new Error("Organization not found")
      if (org.kind === "personal") throw new Error("team_not_allowed_on_personal_org")
      if (!orgAdminForUser(db, who, args.orgId)) throw new Error("org_admin_required")
      const now = Date.now()
      const teamId = `team_${randomToken()}`
      db.transaction(() => {
        db.prepare(`
          INSERT INTO teams (team_id, org_id, name, is_default, created_by_token_identifier, created_at, updated_at)
          VALUES (?, ?, ?, 0, ?, ?, ?)
        `).run(teamId, args.orgId, name, who.token_identifier, now, now)
        db.prepare(`
          INSERT INTO team_memberships (team_id, user_token_identifier, role, created_at, updated_at)
          VALUES (?, ?, 'owner', ?, ?)
        `).run(teamId, who.token_identifier, now, now)
      })()
      return { team_id: teamId, name, role: "owner" as const }
    },
    async ensureDefaultTeam(auth: SignedControlPlaneAuth, args: { orgId: string }) {
      const db = database()
      const who = user(auth)
      const org = db.prepare<unknown[], { org_id: string; kind: string; name: string; owner_token_identifier: string }>(`SELECT org_id, kind, name, owner_token_identifier FROM orgs WHERE org_id = ? AND deleted_at IS NULL`)
        .get(args.orgId)
      if (!org) throw new Error("Organization not found")
      if (org.kind === "personal") return { skipped: true as const }
      const membership = db.prepare(`
        SELECT 1 FROM org_memberships WHERE org_id = ? AND token_identifier = ?
      `).get(args.orgId, who.token_identifier)
      if (!membership && org.owner_token_identifier !== who.token_identifier) throw new Error("org_membership_required")
      const now = Date.now()
      return db.transaction(() => {
        let defaultTeam = db.prepare<unknown[], { team_id: string }>(`
          SELECT team_id FROM teams WHERE org_id = ? AND is_default = 1 AND deleted_at IS NULL
        `).get(args.orgId)
        if (!defaultTeam) {
          const teamId = `team_${randomToken()}`
          db.prepare(`
            INSERT INTO teams (team_id, org_id, name, is_default, created_by_token_identifier, created_at, updated_at)
            VALUES (?, ?, ?, 1, ?, ?, ?)
          `).run(teamId, args.orgId, org.name || "Everyone", who.token_identifier, now, now)
          defaultTeam = { team_id: teamId }
        }
        const orgMembers = db.prepare<unknown[], { token_identifier: string; role: string }>(`
          SELECT token_identifier, role FROM org_memberships WHERE org_id = ?
        `).all(args.orgId)
        for (const member of orgMembers) {
          const existing = db.prepare(`
            SELECT 1 FROM team_memberships WHERE team_id = ? AND user_token_identifier = ?
          `).get(defaultTeam.team_id, member.token_identifier)
          if (existing) continue
          const role = member.role === "owner" || member.role === "admin" ? member.role : "member"
          db.prepare(`
            INSERT INTO team_memberships (team_id, user_token_identifier, role, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
          `).run(defaultTeam.team_id, member.token_identifier, role, now, now)
        }
        const projects = db.prepare<unknown[], { project_id: string }>(`
          SELECT project_id FROM projects WHERE org_id = ? AND deleted_at IS NULL
        `).all(args.orgId)
        for (const project of projects) {
          const grant = db.prepare<unknown[], { revoked_at: number | null }>(`
            SELECT revoked_at FROM team_project_grants WHERE team_id = ? AND project_id = ?
          `).get(defaultTeam.team_id, project.project_id)
          if (grant) continue
          db.prepare(`
            INSERT INTO team_project_grants (
              team_id, project_id, role, created_by_token_identifier, created_at
            ) VALUES (?, ?, 'editor', ?, ?)
          `).run(defaultTeam.team_id, project.project_id, who.token_identifier, now)
        }

        // D18: retarget interim org-scoped shares onto the default team.
        const teamTargetKey = `team:${defaultTeam.team_id}`
        let workspaceSharesRetargeted = 0
        const orgWorkspaceShares = db.prepare<unknown[], { grant_id: string; workspace_id: string }>(`
          SELECT grant_id, workspace_id FROM workspace_share_grants
          WHERE granted_to_org_id = ? AND revoked_at IS NULL
        `).all(args.orgId)
        for (const share of orgWorkspaceShares) {
          const existingTeam = db.prepare<unknown[], { grant_id: string }>(`
            SELECT grant_id FROM workspace_share_grants
            WHERE workspace_id = ? AND granted_to_team_id = ? AND revoked_at IS NULL
          `).get(share.workspace_id, defaultTeam.team_id)
          if (existingTeam) {
            db.prepare(`UPDATE workspace_share_grants SET revoked_at = ? WHERE grant_id = ?`)
              .run(now, share.grant_id)
            continue
          }
          db.prepare(`
            UPDATE workspace_share_grants
            SET granted_to_org_id = NULL, granted_to_team_id = ?, target_key = ?
            WHERE grant_id = ?
          `).run(defaultTeam.team_id, teamTargetKey, share.grant_id)
          workspaceSharesRetargeted += 1
        }

        let sessionSharesRetargeted = 0
        const orgSessionShares = db.prepare<unknown[], { grant_id: string; session_id: string }>(`
          SELECT grant_id, session_id FROM session_share_grants
          WHERE granted_to_org_id = ? AND revoked_at IS NULL
        `).all(args.orgId)
        for (const share of orgSessionShares) {
          const existingTeam = db.prepare<unknown[], { grant_id: string }>(`
            SELECT grant_id FROM session_share_grants
            WHERE session_id = ? AND granted_to_team_id = ? AND revoked_at IS NULL
          `).get(share.session_id, defaultTeam.team_id)
          if (existingTeam) {
            db.prepare(`UPDATE session_share_grants SET revoked_at = ? WHERE grant_id = ?`)
              .run(now, share.grant_id)
            continue
          }
          db.prepare(`
            UPDATE session_share_grants
            SET granted_to_org_id = NULL, granted_to_team_id = ?
            WHERE grant_id = ?
          `).run(defaultTeam.team_id, share.grant_id)
          sessionSharesRetargeted += 1
        }

        return {
          team_id: defaultTeam.team_id,
          org_id: args.orgId,
          workspace_shares_retargeted: workspaceSharesRetargeted,
          session_shares_retargeted: sessionSharesRetargeted,
        }
      })()
    },
    async addTeamMember(auth: SignedControlPlaneAuth, args: {
      teamId: string
      tokenIdentifier?: string
      providerSubject?: string
      userPublicId?: string
      role?: "member" | "admin" | "owner"
    }) {
      const db = database()
      const who = user(auth)
      const team = db.prepare<unknown[], { team_id: string; org_id: string }>(`SELECT team_id, org_id FROM teams WHERE team_id = ? AND deleted_at IS NULL`)
        .get(args.teamId)
      if (!team) throw new Error("Team not found")
      if (!orgAdminForUser(db, who, team.org_id)) throw new Error("org_admin_required")
      const target = args.tokenIdentifier
        ? db.prepare<unknown[], AuthorityUser>(`SELECT token_identifier FROM users WHERE token_identifier = ?`).get(args.tokenIdentifier)
        : args.providerSubject
          ? userBySubject(db, args.providerSubject)
          : args.userPublicId
            ? db.prepare<unknown[], AuthorityUser>(`SELECT token_identifier FROM users WHERE public_id = ?`).get(args.userPublicId)
            : undefined
      if (!target) throw new Error("team_member_not_found")
      const orgMembership = db.prepare(`
        SELECT 1 FROM org_memberships WHERE org_id = ? AND token_identifier = ?
      `).get(team.org_id, target.token_identifier)
      if (!orgMembership) throw new Error("team_member_org_membership_required")
      const now = Date.now()
      const role = args.role ?? "member"
      db.prepare(`
        INSERT INTO team_memberships (team_id, user_token_identifier, role, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (team_id, user_token_identifier) DO UPDATE SET role = excluded.role, updated_at = excluded.updated_at
      `).run(args.teamId, target.token_identifier, role, now, now)
      return { team_id: args.teamId, user_id: target.token_identifier, role }
    },
    async removeTeamMember(auth: SignedControlPlaneAuth, args: {
      teamId: string
      tokenIdentifier?: string
      providerSubject?: string
      userPublicId?: string
    }) {
      const db = database()
      const who = user(auth)
      const team = db.prepare<unknown[], { team_id: string; org_id: string }>(`SELECT team_id, org_id FROM teams WHERE team_id = ? AND deleted_at IS NULL`)
        .get(args.teamId)
      if (!team) throw new Error("Team not found")
      if (!orgAdminForUser(db, who, team.org_id)) throw new Error("org_admin_required")
      const target = args.tokenIdentifier
        ? db.prepare<unknown[], AuthorityUser>(`SELECT token_identifier FROM users WHERE token_identifier = ?`).get(args.tokenIdentifier)
        : args.providerSubject
          ? userBySubject(db, args.providerSubject)
          : args.userPublicId
            ? db.prepare<unknown[], AuthorityUser>(`SELECT token_identifier FROM users WHERE public_id = ?`).get(args.userPublicId)
            : undefined
      if (!target) return { removed: false }
      const result = db.prepare(`
        DELETE FROM team_memberships WHERE team_id = ? AND user_token_identifier = ?
      `).run(args.teamId, target.token_identifier)
      return { removed: result.changes > 0 }
    },
    async listTeamMembers(auth: SignedControlPlaneAuth, args: { teamId: string }) {
      const db = database()
      const who = user(auth)
      const team = db.prepare<unknown[], { team_id: string; org_id: string }>(`SELECT team_id, org_id FROM teams WHERE team_id = ? AND deleted_at IS NULL`)
        .get(args.teamId)
      if (!team) return []
      const membership = db.prepare(`
        SELECT 1 FROM org_memberships WHERE org_id = ? AND token_identifier = ?
      `).get(team.org_id, who.token_identifier)
      if (!membership && !orgAdminForUser(db, who, team.org_id)) return []
      return db.prepare(`
        SELECT m.user_token_identifier AS user_id, u.public_id, u.name AS display_name,
          m.user_token_identifier AS token_identifier, u.subject AS provider_subject, m.role
        FROM team_memberships m
        LEFT JOIN users u ON u.token_identifier = m.user_token_identifier
        WHERE m.team_id = ?
        ORDER BY m.role DESC, m.user_token_identifier ASC
      `).all(args.teamId)
    },
    async grantTeamProject(auth: SignedControlPlaneAuth, args: {
      teamId: string
      projectId: string
      role: "viewer" | "editor" | "admin"
    }) {
      const db = database()
      const who = user(auth)
      const team = db.prepare<unknown[], { team_id: string; org_id: string }>(`SELECT team_id, org_id FROM teams WHERE team_id = ? AND deleted_at IS NULL`)
        .get(args.teamId)
      if (!team) throw new Error("Team not found")
      if (!orgAdminForUser(db, who, team.org_id)) throw new Error("org_admin_required")
      const project = projectByPublicId(db, args.projectId)
      if (!project || project.org_id !== team.org_id) throw new Error("Project not found")
      const now = Date.now()
      const existing = db.prepare<unknown[], { revoked_at: number | null }>(`
        SELECT revoked_at FROM team_project_grants WHERE team_id = ? AND project_id = ?
      `).get(args.teamId, args.projectId)
      if (existing) {
        db.prepare(`
          UPDATE team_project_grants
          SET role = ?, revoked_at = NULL, created_by_token_identifier = ?
          WHERE team_id = ? AND project_id = ?
        `).run(args.role, who.token_identifier, args.teamId, args.projectId)
      } else {
        db.prepare(`
          INSERT INTO team_project_grants (team_id, project_id, role, created_by_token_identifier, created_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(args.teamId, args.projectId, args.role, who.token_identifier, now)
      }
      return { team_id: args.teamId, project_id: args.projectId, role: args.role }
    },
    async revokeTeamProject(auth: SignedControlPlaneAuth, args: { teamId: string; projectId: string }) {
      const db = database()
      const who = user(auth)
      const team = db.prepare<unknown[], { team_id: string; org_id: string }>(`SELECT team_id, org_id FROM teams WHERE team_id = ? AND deleted_at IS NULL`)
        .get(args.teamId)
      if (!team) throw new Error("Team not found")
      if (!orgAdminForUser(db, who, team.org_id)) throw new Error("org_admin_required")
      const result = db.prepare(`
        UPDATE team_project_grants SET revoked_at = ?
        WHERE team_id = ? AND project_id = ? AND revoked_at IS NULL
      `).run(Date.now(), args.teamId, args.projectId)
      return { revoked: result.changes > 0 }
    },
    /**
     * Who a credential this box minted for one of its own sessions acts as.
     *
     * `userId` is the workspace owner's token SUBJECT, because that is what
     * this adapter's signed Tasks actor carries as its `ownerId`: a grant that
     * resolved to anything else would own a different preset catalog than the
     * person whose workspace it is.
     */
    async resolveWorkspaceOwner(workspaceId: string) {
      const db = database()
      const workspace = workspaceByPublicId(db, workspaceId)
      if (!workspace || workspace.deleted_at !== null) return undefined
      const owner = db.prepare<unknown[], { subject: string; token_identifier: string }>(
        `SELECT subject, token_identifier FROM users WHERE token_identifier = ?`,
      ).get(workspace.owner_token_identifier)
      if (!owner?.subject) return undefined
      return {
        userId: owner.subject,
        actorId: owner.token_identifier,
        orgId: workspace.org_id,
        projectId: workspace.project_id,
      }
    },
    async resolveOrgId(auth: SignedControlPlaneAuth) {
      const db = database()
      const who = user(auth)
      if (auth.user.orgId) {
        const org = db.prepare<unknown[], { org_id: string }>(`
          SELECT o.org_id FROM orgs o
          JOIN org_memberships m ON m.org_id = o.org_id AND m.token_identifier = ?
          WHERE o.org_id = ? AND o.deleted_at IS NULL
        `).get(who.token_identifier, auth.user.orgId)
        if (org) return asOrgId(org.org_id)
      }
      return asOrgId(ensurePersonalOrg(db, who))
    },
    async projectRole(auth: SignedControlPlaneAuth, args): Promise<ProjectRoleResult> {
      const db = database()
      const who = user(auth)
      const project = projectByPublicId(db, args.projectId)
      if (!project) return { ok: false }
      return projectResultFor(db, project, who, { orgId: args.orgId })
    },
    async authorizeProject(auth: SignedControlPlaneAuth, args): Promise<ProjectRoleResult> {
      const db = database()
      const who = user(auth)
      const project = projectByPublicId(db, args.projectId)
      if (!project) return { ok: false }
      return projectResultFor(db, project, who, { action: args.action, orgId: args.orgId })
    },
    async authorizeChannelProject(args) {
      const db = database()
      const who = linkedChannelUser(db, args)
      if (!who) return { ok: false }
      const project = projectByPublicId(db, args.projectId)
      if (!project) return { ok: false }
      const result = projectResultFor(db, project, who, { action: args.action })
      if (!result.ok) return result
      return {
        ...result,
        actorId: who.token_identifier,
        actorKind: "human",
        ...(who.public_id
          ? { actorPublicId: who.public_id, actorName: who.name ?? "User", ...(who.image_url ? { actorAvatarUrl: who.image_url } : {}) }
          : {}),
      }
    },
    async authorizeChannelWorkspace(args) {
      const db = database()
      const who = linkedChannelUser(db, args)
      if (!who) denied()
      const workspace = workspaceByPublicId(db, args.workspaceId)
      if (!workspace || !authorizeWorkspaceForUser(db, workspace, who, args.action)) denied()
      return {
        actorId: who.token_identifier,
        actorKind: "human" as const,
        ...(who.public_id
          ? { actorPublicId: who.public_id, actorName: who.name ?? "User", ...(who.image_url ? { actorAvatarUrl: who.image_url } : {}) }
          : {}),
      }
    },
    async bindChannelIdentity(auth, args) {
      const db = database()
      const who = user(auth)
      const channel = requiredText(args.channel, "channel")
      const externalUserId = requiredText(args.externalUserId, "externalUserId")
      const existing = db.prepare<unknown[], { binding_id: string; token_identifier: string }>(`
        SELECT binding_id, token_identifier FROM channel_identities
        WHERE channel = ? AND external_user_id = ? AND revoked_at IS NULL
      `).get(channel, externalUserId)
      if (existing && existing.token_identifier !== who.token_identifier) {
        throw new Error("Channel identity is already bound")
      }
      const bindingId = existing?.binding_id ?? `channel_${randomToken()}`
      if (!existing) {
        db.prepare(`
          INSERT INTO channel_identities (
            binding_id, channel, external_user_id, token_identifier, created_at, revoked_at
          ) VALUES (?, ?, ?, ?, ?, NULL)
        `).run(bindingId, channel, externalUserId, who.token_identifier, Date.now())
      }
      return {
        bindingId,
        created: !existing,
        userId: who.token_identifier,
        actorId: who.token_identifier,
        actorKind: "human" as const,
      }
    },
    async revokeChannelIdentity(auth, args) {
      const db = database()
      const who = user(auth)
      const channel = requiredText(args.channel, "channel")
      const externalUserId = requiredText(args.externalUserId, "externalUserId")
      const result = db.prepare(`
        UPDATE channel_identities SET revoked_at = ?
        WHERE channel = ? AND external_user_id = ? AND token_identifier = ? AND revoked_at IS NULL
      `).run(
        Date.now(),
        channel,
        externalUserId,
        who.token_identifier,
      )
      if (result.changes > 0) return { revoked: true }
      const latest = db.prepare<unknown[], { token_identifier: string }>(`
        SELECT token_identifier FROM channel_identities
        WHERE channel = ? AND external_user_id = ?
        ORDER BY created_at DESC, rowid DESC LIMIT 1
      `).get(channel, externalUserId)
      return { revoked: latest?.token_identifier === who.token_identifier }
    },

    // --- workspaces (workspaces, workspace shares) ---------------------------
    async authorizeWorkspaceCreate(auth: SignedControlPlaneAuth, args) {
      if (!args.orgId) return
      const db = database()
      const who = user(auth)
      const membership = db.prepare<unknown[], { role: string }>(`
        SELECT m.role FROM org_memberships m
        JOIN orgs o ON o.org_id = m.org_id
        WHERE m.org_id = ? AND m.token_identifier = ? AND o.deleted_at IS NULL
      `).get(args.orgId, who.token_identifier)
      if (membership?.role !== "owner" && membership?.role !== "admin") denied()
    },
    async authorizeWorkspaceOpen(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      const workspace = workspaceByPublicId(db, args.workspaceId)
      if (!workspace || workspace.deleted_at || !authorizeWorkspaceForUser(db, workspace, who, "read")) denied()
    },
    async openWorkspace(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      const workspace = workspaceByPublicId(db, args.workspaceId)
      if (!workspace || workspace.deleted_at) denied()
      const role = authorizeWorkspaceForUser(db, workspace, who, "read")
      if (!role) denied()
      return {
        allowed: true,
        role,
        workspace: workspaceJson(workspace),
      }
    },
    async listWorkspaces(auth: SignedControlPlaneAuth) {
      const db = database()
      const who = user(auth)
      const rows = db.prepare<unknown[], WorkspaceRow>(`SELECT * FROM workspaces WHERE deleted_at IS NULL`).all()
      const visible = rows
        .map((workspace) => ({
          workspace_id: workspace.workspace_id,
          project_id: workspace.project_id ?? undefined,
          display_name: workspace.display_name ?? undefined,
          backing: workspace.backing,
          access: workspace.access,
          remote_directory: workspace.remote_directory ?? undefined,
          role: workspaceRoleForUser(db, workspace, who),
        }))
        .filter((item) => !!item.role)
      const online = workspacesWithServingHost(
        db,
        visible.filter((item) => item.access === "user-hosted").map((item) => item.workspace_id),
      )
      return visible.map((item) => ({
        ...item,
        // Reachability, not authorization: a shared workspace whose machine is
        // asleep is still listed, and the rail says "host offline" for it
        // rather than dropping the row or waiting for a pane to discover it.
        ...(item.access === "user-hosted" ? { host_online: online.has(item.workspace_id) } : {}),
      }))
    },
    async registerLocalForSharing(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      const requestedHomeRegion = validatedHomeRegion(args.homeRegion)
      const remoteDirectory = args.remoteDirectory === undefined ? undefined : normalizeStoredDirectory(args.remoteDirectory)
      const now = Date.now()
      const existing = workspaceByPublicId(db, args.workspaceId)
      if (existing) {
        if (!authorizeWorkspaceForUser(db, existing, who, "admin")) throw new Error("Workspace not found")
        if (existing.backing === "cloud-vm" || existing.access === "cloud") {
          throw new Error("workspace_backing_conflict: cannot register a cloud workspace as a user-hosted local workspace")
        }
        if (!existing.org_id || !existing.project_id) throw new Error("workspace_tenant_missing")
        const projectId = ensureProject(db, {
          projectId: existing.project_id,
          orgId: existing.org_id,
          repoKey: sqliteRepoKey(
            args.repoUrl ?? existing.repo_url ?? remoteDirectory ?? existing.remote_directory,
            args.workspaceId,
          ),
          owner: who,
        })
        const home_region = existing.home_region ?? requestedHomeRegion
        db.prepare(`
          UPDATE workspaces SET
            project_id = ?,
            backing = 'local-worktree', access = 'user-hosted',
            home_region = COALESCE(?, home_region),
            display_name = ?,
            repo_url = COALESCE(?, repo_url),
            repo_name = COALESCE(?, repo_name),
            git_branch = COALESCE(?, git_branch),
            remote_directory = COALESCE(?, remote_directory),
            deleted_at = NULL,
            updated_at = ?
          WHERE workspace_id = ?
        `).run(
          projectId,
          home_region ?? null,
          args.displayName,
          args.repoUrl ?? null,
          args.repoName ?? null,
          args.gitBranch ?? null,
          remoteDirectory ?? null,
          now,
          args.workspaceId,
        )
        return { workspace_doc_id: args.workspaceId, workspace_id: args.workspaceId, home_region }
      }
      const { orgId, projectId } = ownedProject(db, who, { ...args, remoteDirectory })
      db.prepare(`
        INSERT INTO workspaces (
          workspace_id, org_id, project_id, owner_token_identifier, backing, access,
          display_name, home_region, repo_url, repo_name, git_branch, remote_directory,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'local-worktree', 'user-hosted', ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        args.workspaceId,
        orgId,
        projectId,
        who.token_identifier,
        args.displayName,
        requestedHomeRegion ?? null,
        args.repoUrl ?? null,
        args.repoName ?? null,
        args.gitBranch ?? null,
        remoteDirectory ?? null,
        now,
        now,
      )
      return { workspace_doc_id: args.workspaceId, workspace_id: args.workspaceId, home_region: requestedHomeRegion }
    },
    async createCloudWorkspace(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      const { orgId, projectId } = ownedProject(db, who, args)
      const home_region = validatedHomeRegion(args.homeRegion)
      const now = Date.now()
      db.prepare(`
        INSERT INTO workspaces (
          workspace_id, org_id, project_id, owner_token_identifier, backing, access,
          display_name, home_region, repo_url, repo_name, git_branch, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'cloud-vm', 'cloud', ?, ?, ?, ?, ?, ?, ?)
      `).run(
        args.workspaceId,
        orgId,
        projectId,
        who.token_identifier,
        args.displayName,
        home_region ?? null,
        args.repoUrl ?? null,
        args.repoName ?? null,
        args.gitBranch ?? null,
        now,
        now,
      )
      return { workspace_doc_id: args.workspaceId }
    },
    async deleteWorkspace(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      const workspace = workspaceByPublicId(db, args.workspaceId)
      if (!workspace || workspace.deleted_at || !authorizeWorkspaceForUser(db, workspace, who, "owner")) {
        throw new Error("Workspace not found")
      }
      db.prepare(`UPDATE workspaces SET deleted_at = ?, updated_at = ? WHERE workspace_id = ?`)
        .run(Date.now(), Date.now(), args.workspaceId)
      return { deleted: true }
    },
    async grantWorkspaceShare(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      requireWorkspace(db, who, args.workspaceId, "admin")
      const target = canonicalShareTarget(db, args.target, { requireExisting: true })
      return db.transaction(() => {
        const active = target.activeKeys.flatMap((targetKey) => db.prepare<unknown[], { grant_id: string; role: string }>(`
            SELECT grant_id, role FROM workspace_share_grants
            WHERE workspace_id = ? AND target_key = ? AND revoked_at IS NULL
          `).all(args.workspaceId, targetKey))
        if (active.length === 1 && active[0].role === args.role) return active[0].grant_id
        const now = Date.now()
        if (active.length > 0) {
          for (const grant of active) {
            db.prepare(`UPDATE workspace_share_grants SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL`)
              .run(now, grant.grant_id)
          }
          const tokenIdentifiers = target.tokenIdentifier
            ? [target.tokenIdentifier]
            : target.subject
              ? [userBySubject(db, target.subject)?.token_identifier]
                .filter((item): item is string => !!item)
              : target.teamId
                ? (db.prepare<unknown[], { user_token_identifier: string }>(`SELECT user_token_identifier FROM team_memberships WHERE team_id = ?`)
                  .all(target.teamId))
                  .map((item) => item.user_token_identifier)
                : (db.prepare<unknown[], { token_identifier: string }>(`SELECT token_identifier FROM org_memberships WHERE org_id = ?`)
                  .all(target.orgId))
                  .map((item) => item.token_identifier)
          revokeRuntimeTokensForUsers(db, args.workspaceId, tokenIdentifiers)
        }
        const grantId = `grant_${randomToken()}`
        db.prepare(`
          INSERT INTO workspace_share_grants (
            grant_id, workspace_id, target_key, granted_to_token_identifier, granted_to_subject, granted_to_org_id,
            granted_to_team_id, role, created_by_token_identifier, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          grantId,
          args.workspaceId,
          target.primaryKey,
          target.tokenIdentifier ?? null,
          target.subject ?? null,
          target.orgId ?? null,
          target.teamId ?? null,
          args.role,
          who.token_identifier,
          now,
        )
        return grantId
      })()
    },
    async revokeWorkspaceShare(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      requireWorkspace(db, who, args.workspaceId, "admin")
      if (!!args.grantId === !!args.target) {
        throw new Error("Share revoke target must be exactly one grant or canonical target")
      }
      const target = args.grantId ? undefined : canonicalShareTarget(db, args.target!, { requireExisting: false })
      const grants = args.grantId
        ? db.prepare<unknown[], WorkspaceShareGrantRow>(
          `SELECT * FROM workspace_share_grants WHERE workspace_id = ? AND grant_id = ? AND revoked_at IS NULL`,
        ).all(args.workspaceId, args.grantId)
        : target!.activeKeys.flatMap((targetKey) =>
          db.prepare<unknown[], WorkspaceShareGrantRow>(`
            SELECT * FROM workspace_share_grants
            WHERE workspace_id = ? AND target_key = ? AND revoked_at IS NULL
          `).all(args.workspaceId, targetKey)
        )
      if (grants.length === 0) return { revoked: false }
      return db.transaction(() => {
        const now = Date.now()
        for (const grant of grants) {
          db.prepare(`UPDATE workspace_share_grants SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL`)
            .run(now, grant.grant_id)
        }
        const tokenIdentifiers = new Set<string>()
        for (const grant of grants) {
          if (grant.granted_to_token_identifier) tokenIdentifiers.add(grant.granted_to_token_identifier)
          if (grant.granted_to_subject) {
            const user = userBySubject(db, grant.granted_to_subject)
            if (user) tokenIdentifiers.add(user.token_identifier)
          }
          if (grant.granted_to_org_id) {
            for (const membership of db.prepare<unknown[], { token_identifier: string }>(`SELECT token_identifier FROM org_memberships WHERE org_id = ?`)
              .all(grant.granted_to_org_id)) {
              tokenIdentifiers.add(membership.token_identifier)
            }
          }
          if (grant.granted_to_team_id) {
            for (const membership of db.prepare<unknown[], { user_token_identifier: string }>(`SELECT user_token_identifier FROM team_memberships WHERE team_id = ?`)
              .all(grant.granted_to_team_id)) {
              tokenIdentifiers.add(membership.user_token_identifier)
            }
          }
        }
        return {
          revoked: true,
          runtime_tokens_revoked: revokeRuntimeTokensForUsers(db, args.workspaceId, [...tokenIdentifiers]),
        }
      })()
    },

    // --- machine-wide enrollment -------------------------------------------
    //
    // The retired per-workspace host-link methods did these four things per
    // WORKSPACE. These do them per MACHINE, and every difference is the
    // removal of workspace handling: no ownership check against a workspace
    // row, no cloud-workspace refusal, and — the one that matters — no implicit
    // `INSERT INTO workspaces`. Enrolling a laptop creates nothing to own.
    async createHostEnrollmentRequest(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      const now = Date.now()
      const nonce = base64url(crypto.getRandomValues(new Uint8Array(32)))
      const requestId = base64url(crypto.getRandomValues(new Uint8Array(16)))
      // Prune BEFORE inserting, on the one path that grows this table.
      //
      // This adapter has no scheduler — nothing here corresponds to
      // a cron surface, so a sweep has to ride a write or it never runs. The
      // request row is server-random-keyed and nothing else ever deletes it, so
      // without this the table grew monotonically for the life of the
      // deployment: every issued nonce, kept forever, whether it was ever used
      // or not.
      //
      // Bounded by `ENROLLMENT_REQUEST_SWEEP_LIMIT` so one unlucky caller never
      // pays for an arbitrarily large backlog, and ranged on
      // `host_enrollment_requests_by_expires_at` so the scan is over collectable
      // rows rather than the whole table.
      //
      // `expires_at` is the COLLECTABLE-AT clock, not just challenge validity:
      // `enrollHost` pushes it out to `used_at + ENROLLMENT_CONSUMED_RETENTION_MS`
      // when it claims the nonce, so consumed evidence survives this delete for
      // its full retention window. Validity is decided by `used_at`, which is
      // checked first.
      db.prepare(`
        DELETE FROM host_enrollment_requests WHERE request_id IN (
          SELECT request_id FROM host_enrollment_requests WHERE expires_at <= ? LIMIT ?
        )
      `).run(now, ENROLLMENT_REQUEST_SWEEP_LIMIT)
      db.prepare(`
        INSERT INTO host_enrollment_requests (request_id, owner_token_identifier, host_id, nonce, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(requestId, who.token_identifier, args.hostId, nonce, now + ENROLLMENT_CHALLENGE_TTL_MS, now)
      return { request_id: requestId, nonce, expires_at: now + ENROLLMENT_CHALLENGE_TTL_MS }
    },
    async enrollHost(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      const now = Date.now()
      const request = db.prepare<unknown[], HostEnrollmentRequestRow>(`SELECT * FROM host_enrollment_requests WHERE request_id = ?`)
        .get(args.requestId)
      if (
        !request
        || request.owner_token_identifier !== who.token_identifier
        || request.host_id !== args.hostId
        || request.used_at
        || request.expires_at <= now
      ) {
        throw new Error("Invalid host enrollment request")
      }
      // Signature verified BEFORE the nonce is claimed: a bad signature must
      // not burn the request, or an attacker who can reach this endpoint could
      // invalidate every enrollment attempt the user makes.
      await verifyHostSignature({
        public_key: args.publicKey,
        payload: enrollmentPayload({
          host_id: args.hostId,
          request_id: args.requestId,
          nonce: request.nonce,
        }),
        signature: args.signature,
      })
      return db.transaction(() => {
        const claimedAt = Date.now()
        const claimed = db.prepare(`
          UPDATE host_enrollment_requests SET used_at = ?, expires_at = ?
          WHERE request_id = ? AND used_at IS NULL AND expires_at > ?
        `).run(claimedAt, claimedAt + ENROLLMENT_CONSUMED_RETENTION_MS, args.requestId, claimedAt)
        // Claiming REWRITES `expires_at` from "the nonce is signable until" to
        // "this evidence is collectable at", starting the ten-minute consumed
        // retention window the prune in `createHostEnrollmentRequest` reads.
        // Extending it cannot extend validity: `used_at` is now set, and every
        // read of this row — the guard above and this statement's own
        // `used_at IS NULL` — rejects a claimed request before it ever looks at
        // the expiry. The WHERE still sees the pre-update value, so a nonce
        // that had already lapsed is not resurrected by its own claim.
        // One-use, enforced by the UPDATE's own WHERE rather than by the read
        // above: two concurrent enrollments race through that read, and only
        // one can win here.
        if (claimed.changes !== 1) throw new Error("Invalid host enrollment request")

        const expiresAt = claimedAt + ttl(args.ttlMs)
        const enrollmentId = base64url(crypto.getRandomValues(new Uint8Array(16)))
        db.prepare(`
          INSERT INTO host_enrollments (
            enrollment_id, owner_token_identifier, host_id, public_key, display_name,
            last_seen_at, expires_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (owner_token_identifier, host_id) DO UPDATE SET
            -- Compared as stored text: the desktop re-presents the exact
            -- serialization it persisted, and a spurious bump only makes the
            -- machine re-learn a version it is handed in the same response.
            key_version = CASE
              WHEN host_enrollments.public_key = excluded.public_key THEN host_enrollments.key_version
              ELSE host_enrollments.key_version + 1
            END,
            public_key = excluded.public_key,
            display_name = COALESCE(excluded.display_name, host_enrollments.display_name),
            last_seen_at = excluded.last_seen_at,
            expires_at = excluded.expires_at,
            updated_at = excluded.updated_at,
            -- Re-enrolling a machine clears a previous revoke or pause. The
            -- user just proved possession of the key again, which is a stronger
            -- statement than either flag.
            paused_at = NULL,
            paused_by = NULL,
            paused_reason = NULL,
            revoked_at = NULL
        `).run(
          enrollmentId,
          who.token_identifier,
          args.hostId,
          args.publicKey,
          args.displayName ?? null,
          claimedAt,
          expiresAt,
          claimedAt,
          claimedAt,
        )
        const row = db.prepare<unknown[], HostEnrollmentRow>(
          `SELECT * FROM host_enrollments WHERE owner_token_identifier = ? AND host_id = ?`,
        ).get(who.token_identifier, args.hostId)
        if (!row) throw new Error("host_enrollment_missing_after_claim")
        return toHostEnrollment(row)
      })()
    },
    async heartbeatHostEnrollment(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      const row = db.prepare<unknown[], HostEnrollmentRow>(`SELECT * FROM host_enrollments WHERE owner_token_identifier = ? AND host_id = ?`)
        .get(who.token_identifier, args.hostId)
      if (!row || row.revoked_at) throw new SqliteHostConnectError("host_enrollment_not_found", "Host enrollment not found")
      if (!Array.isArray(args.workspaceIds)) {
        throw new Error("workspaceIds is required — the heartbeat signature covers the served set")
      }
      const workspaceIds = [...new Set(args.workspaceIds.map((id) => requiredText(id, "workspaceIds")))].sort()
      if (workspaceIds.length > MAX_ACKED_WORKSPACES) {
        throw new Error("workspaceIds exceeds the served-set cap")
      }
      await verifyHostSignature({
        public_key: row.public_key,
        payload: heartbeatEnrollmentPayloadV2({ host_id: args.hostId, ttl_ms: args.ttlMs, workspace_ids: workspaceIds }),
        signature: args.signature,
      })
      // A v2 caller consents to a workspace set, not to revisions: each ack
      // lands at the assignment's current revision.
      const renewed = db.transaction(() => renewLease(db, {
        enrollmentId: row.enrollment_id,
        ttlMs: args.ttlMs,
        acks: workspaceIds.map((workspaceId) => ({ workspaceId, revision: "current" as const })),
        sessionAuthority: args.sessionAuthority,
        where: { sql: "host_enrollments.enrollment_id = ? AND host_enrollments.revoked_at IS NULL", params: [row.enrollment_id] },
      }))()
      if (!renewed) throw new SqliteHostConnectError("host_enrollment_not_found", "Host enrollment not found")
      return {
        expires_at: renewed.expires_at,
        last_seen_at: renewed.last_seen_at,
        assigned_workspace_ids: renewed.assigned_workspace_ids,
      }
    },
    async heartbeatHostEnrollmentByMachine(machine: MachinePrincipal, args) {
      const db = database()
      if (!Array.isArray(args.acks)) throw new SqliteHostConnectError("invalid_input", "acks is required")
      if (!Number.isInteger(args.generation) || args.generation < 0) {
        throw new SqliteHostConnectError("invalid_input", "generation must be a non-negative integer")
      }
      if (args.generation < machine.generation) throw sqliteGenerationSuperseded(machine.generation)
      if (args.generation > machine.generation) {
        throw new SqliteHostConnectError("invalid_input", "generation was never issued to this enrollment")
      }
      const acks = new Map<string, number>()
      for (const ack of args.acks) {
        const workspaceId = requiredText(ack?.workspaceId, "acks[].workspaceId")
        if (!Number.isInteger(ack.revision) || ack.revision < 1) {
          throw new SqliteHostConnectError("invalid_input", "acks[].revision must be a positive integer")
        }
        acks.set(workspaceId, ack.revision)
      }
      if (acks.size > MAX_ACKED_WORKSPACES) throw new SqliteHostConnectError("invalid_input", "acks exceeds the served-set cap")
      return db.transaction(() => {
        db.prepare(`
          DELETE FROM host_request_nonces WHERE rowid IN (
            SELECT rowid FROM host_request_nonces WHERE expires_at <= ? LIMIT ?
          )
        `).run(Date.now(), NONCE_SWEEP_LIMIT)
        const renewed = renewLease(db, {
          enrollmentId: machine.enrollmentId,
          ttlMs: args.ttlMs,
          acks: [...acks].map(([workspaceId, revision]) => ({ workspaceId, revision })),
          sessionAuthority: args.sessionAuthority,
          where: {
            sql: `${machineMutationGuardSql("host_enrollments")} AND host_enrollments.serving_generation = ?`,
            params: [machine.enrollmentId, machine.keyVersion, args.generation],
          },
        })
        if (!renewed) throw machineMutationRefusal(db, machine, { generation: args.generation })
        return renewed
      })()
    },
    async acquireHostServingGeneration(machine: MachinePrincipal) {
      const db = database()
      return db.transaction(() => {
        const now = Date.now()
        // A compare-and-set on the generation the verifier read: a principal
        // from before another instance's acquire is superseded, not a taker.
        const changed = db.prepare(`
          UPDATE host_enrollments SET
            serving_generation = serving_generation + 1, generation_acquired_at = ?, updated_at = ?
          WHERE ${machineMutationGuardSql("host_enrollments")} AND host_enrollments.serving_generation = ?
        `).run(now, now, machine.enrollmentId, machine.keyVersion, machine.generation).changes
        if (changed !== 1) throw machineMutationRefusal(db, machine, { generation: machine.generation })
        const row = db.prepare<unknown[], Pick<HostEnrollmentRow, "serving_generation" | "owner_token_identifier">>(`
          SELECT serving_generation, owner_token_identifier FROM host_enrollments WHERE enrollment_id = ?
        `).get(machine.enrollmentId)
        if (!row) throw new Error("host_enrollment_missing_after_acquire")
        // A superseded instance's readiness must not keep a workspace routable
        // once the fence has moved past it.
        db.prepare(`DELETE FROM host_assignment_readiness WHERE enrollment_id = ? AND generation < ?`)
          .run(machine.enrollmentId, row.serving_generation)
        recordHostAudit(db, {
          tokenIdentifier: row.owner_token_identifier,
          action: "host_enrollment.generation_acquired",
          metadata: { enrollment_id: machine.enrollmentId, host_id: machine.hostId, generation: row.serving_generation },
        })
        return { generation: row.serving_generation, generation_acquired_at: now }
      })()
    },
    async pauseHostEnrollment(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      const now = Date.now()
      const values = [
        args.paused ? now : null,
        args.paused ? "user" : null,
        args.paused ? "user_paused" : null,
        now,
        who.token_identifier,
      ]
      // No host id pauses every machine this owner enrolled — the "stop all
      // remote access" the settings switch means.
      if (args.hostId) {
        db.prepare(`
          UPDATE host_enrollments SET paused_at = ?, paused_by = ?, paused_reason = ?, updated_at = ?
          WHERE owner_token_identifier = ? AND host_id = ?
        `).run(...values, args.hostId)
      } else {
        db.prepare(`
          UPDATE host_enrollments SET paused_at = ?, paused_by = ?, paused_reason = ?, updated_at = ?
          WHERE owner_token_identifier = ?
        `).run(...values)
      }
      return { paused: args.paused }
    },
    async activeHostEnrollment(auth: SignedControlPlaneAuth) {
      const db = database()
      const who = user(auth)
      const row = db.prepare<unknown[], HostEnrollmentRow>(`
        SELECT * FROM host_enrollments WHERE owner_token_identifier = ?
        ORDER BY last_seen_at DESC LIMIT 1
      `).get(who.token_identifier)
      if (!row) return { active: false as const, reason: "not-enrolled" as const }
      // Ordered most-specific first: a revoked enrollment is also expired
      // eventually, and reporting the expiry would send the user to reconnect
      // when the real answer is that access was taken away.
      if (row.revoked_at) return { active: false as const, reason: "revoked" as const }
      if (row.paused_at) return { active: false as const, reason: "paused" as const }
      if (row.expires_at <= Date.now()) return { active: false as const, reason: "expired" as const }
      return { active: true as const, ...toHostEnrollment(row) }
    },
    async revokeHostEnrollment(auth: SignedControlPlaneAuth, args: { hostId?: string }) {
      const db = database()
      const who = user(auth)
      const now = Date.now()
      const hostId = args.hostId ?? null
      return db.transaction(() => {
        const revoked = db.prepare(`
          UPDATE host_enrollments SET revoked_at = ?, updated_at = ?
          WHERE owner_token_identifier = ? AND (? IS NULL OR host_id = ?) AND revoked_at IS NULL
        `).run(now, now, who.token_identifier, hostId, hostId).changes
        // A revoked key's host id never returns (a later enable enrolls a NEW
        // id), so its assignments could never become routable again — leaving
        // them would only accumulate dangling rows that a later re-share must
        // displace. The cascade keeps "revoke = nothing routable" exactly true.
        db.prepare(retireUserHostedWorkspaceSql(`workspace_id IN (
          SELECT workspace_id FROM host_workspace_assignments
          WHERE owner_token_identifier = ? AND (? IS NULL OR host_id = ?)
        )`)).run(now, now, who.token_identifier, hostId, hostId)
        db.prepare(`
          DELETE FROM host_assignment_readiness WHERE workspace_id IN (
            SELECT workspace_id FROM host_workspace_assignments
            WHERE owner_token_identifier = ? AND (? IS NULL OR host_id = ?)
          )
        `).run(who.token_identifier, hostId, hostId)
        db.prepare(`
          DELETE FROM host_workspace_assignments
          WHERE owner_token_identifier = ? AND (? IS NULL OR host_id = ?)
        `).run(who.token_identifier, hostId, hostId)
        const runtimeTokensRevoked = db.prepare(`
          UPDATE runtime_access_tokens SET revoked_at = ?
          WHERE actor_id = ? AND (? IS NULL OR host_id = ?) AND revoked_at IS NULL
        `).run(now, who.token_identifier, hostId, hostId).changes
        return { revoked, runtime_tokens_revoked: runtimeTokensRevoked }
      })()
    },
    /**
     * The OWNER's declaration that host H serves workspace X. Pure data: no
     * challenge and no TTL — liveness is the enrollment lease, consent is the
     * heartbeat's acked set, and routing requires all three. Cold-registers
     * the workspace row exactly as the retired per-workspace registration did.
     */
    async assignWorkspaceHost(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      const now = Date.now()
      // ONE transaction over the cold register AND the assignment.
      //
      // Cold registration makes this method a two-write operation, and the two
      // writes are not independent: the workspace row exists only to be
      // assigned. Letting the first commit while the second fails leaves an
      // owned, user-hosted workspace that no machine serves and no caller
      // asked for — it shows up in the workspace list as a share that does not
      // work, and the retry cannot recreate it (the row is now `existing`, so
      // the second attempt takes the authorize branch instead).
      //
      // The enrollment read is inside for the same reason the writes are:
      // "this host is enrolled" is the precondition the assignment is only
      // valid under, and a revoke landing between the check and the insert
      // would otherwise be admitted.
      return db.transaction(() => {
        const enrollment = db.prepare<unknown[], HostEnrollmentRow & { invitation_org_id: string | null }>(`
          SELECT enrollment.*, invitation.org_id AS invitation_org_id
          FROM host_enrollments enrollment
          LEFT JOIN host_invitations invitation ON invitation.redeemed_enrollment_id = enrollment.enrollment_id
          WHERE enrollment.owner_token_identifier = ? AND enrollment.host_id = ?
        `).get(who.token_identifier, args.hostId)
        if (!enrollment || enrollment.revoked_at) {
          throw new SqliteHostConnectError("host_enrollment_not_found", "Host enrollment not found")
        }
        const scope = enrollmentScope(enrollment)
        const existing = workspaceByPublicId(db, args.workspaceId)
        // A retired user-hosted row is the same workspace coming back, so it
        // is authorized as live; any other deleted row stays gone. Nothing is
        // written until every refusal below has had its chance.
        const revivable = existing !== undefined && existing.deleted_at !== null && existing.access === "user-hosted"
        if (existing) {
          const candidate = revivable ? { ...existing, deleted_at: null } : existing
          if (candidate.deleted_at || !authorizeWorkspaceForUser(db, candidate, who, "admin")) {
            throw new SqliteHostConnectError("workspace_not_found", "Workspace not found")
          }
          refuseCloudWorkspace(existing)
        }
        const remoteDirectory = args.remoteDirectory === undefined ? undefined : normalizeStoredDirectory(args.remoteDirectory)
        const directory = remoteDirectory ?? existing?.remote_directory ?? undefined
        if (scope && (directory === undefined || !directoryWithinRoots(directory, scope.allowed_roots))) {
          throw new SqliteHostConnectError(
            "host_assignment_outside_scope",
            `${directory ?? "(no directory)"} is not under any root this machine may serve`,
          )
        }
        const invitationOrgId = enrollment.invitation_org_id ?? undefined
        if (invitationOrgId && (existing?.org_id ?? args.orgId ?? invitationOrgId) !== invitationOrgId) {
          throw new SqliteHostConnectError(
            "host_assignment_outside_scope",
            "This machine was invited into a different organization than the workspace's",
          )
        }
        if (existing) {
          // The assigning machine describes the workspace it serves — name,
          // repository, branch, directory — and that description is the record.
          db.prepare(`
            UPDATE workspaces SET
              deleted_at = NULL,
              display_name = COALESCE(?, display_name),
              repo_url = COALESCE(?, repo_url),
              repo_name = COALESCE(?, repo_name),
              git_branch = COALESCE(?, git_branch),
              remote_directory = COALESCE(?, remote_directory),
              org_member_visible = ?,
              updated_at = ?
            WHERE workspace_id = ?
          `).run(
            args.displayName ?? null,
            args.repoUrl ?? null,
            args.repoName ?? null,
            args.gitBranch ?? null,
            remoteDirectory ?? null,
            orgMemberVisible(scope),
            now,
            args.workspaceId,
          )
        } else {
          const { orgId, projectId } = ownedProject(db, who, { ...args, orgId: args.orgId ?? invitationOrgId, remoteDirectory })
          db.prepare(`
            INSERT INTO workspaces (
              workspace_id, org_id, project_id, owner_token_identifier, backing, access,
              display_name, home_region, repo_url, repo_name, git_branch, remote_directory,
              org_member_visible, created_at, updated_at
            ) VALUES (?, ?, ?, ?, 'local-worktree', 'user-hosted', ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            args.workspaceId,
            orgId,
            projectId,
            who.token_identifier,
            args.displayName ?? args.workspaceId,
            validatedHomeRegion(args.homeRegion) ?? null,
            args.repoUrl ?? null,
            args.repoName ?? null,
            args.gitBranch ?? null,
            remoteDirectory ?? null,
            orgMemberVisible(scope),
            now,
            now,
          )
        }
        // Same transaction as the directory write above: a description is
        // never a new directory under an old revision. The revision comes
        // from the workspace row's counter, which an unassign leaves in
        // place, so a re-share never reissues a revision a host already acked.
        db.prepare(`
          UPDATE workspaces SET host_assignment_revision = host_assignment_revision + 1 WHERE workspace_id = ?
        `).run(args.workspaceId)
        const assigned = db.prepare(`
          INSERT INTO host_workspace_assignments (
            workspace_id, host_id, owner_token_identifier, second_device_open_at, revision, assigned_at, updated_at
          )
          SELECT workspace.workspace_id, ?, ?, NULL, workspace.host_assignment_revision, ?, ?
          FROM workspaces workspace
          WHERE workspace.workspace_id = ?
            AND EXISTS (
              SELECT 1 FROM host_enrollments enrollment
              WHERE enrollment.enrollment_id = ? AND enrollment.scope_revision = ? AND enrollment.revoked_at IS NULL
            )
          ON CONFLICT (workspace_id) DO UPDATE SET
            host_id = excluded.host_id,
            owner_token_identifier = excluded.owner_token_identifier,
            revision = excluded.revision,
            updated_at = excluded.updated_at
        `).run(
          args.hostId,
          who.token_identifier,
          now,
          now,
          args.workspaceId,
          enrollment.enrollment_id,
          enrollment.scope_revision,
        ).changes
        if (assigned !== 1) throw new Error("host_assignment_scope_raced")
        return { assigned: true as const, workspace_id: args.workspaceId, host_id: args.hostId }
      })()
    },
    async unassignWorkspaceHost(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      requireWorkspace(db, who, args.workspaceId, "admin")
      const now = Date.now()
      return db.transaction(() => {
        const result = db.prepare(`DELETE FROM host_workspace_assignments WHERE workspace_id = ?`)
          .run(args.workspaceId)
        db.prepare(`DELETE FROM host_assignment_readiness WHERE workspace_id = ?`).run(args.workspaceId)
        db.prepare(retireUserHostedWorkspaceSql("workspace_id = ?")).run(now, now, args.workspaceId)
        return { unassigned: result.changes > 0 }
      })()
    },
    /** Routable host: owner-assigned AND machine-acked AND live lease. */
    async activeWorkspaceHost(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      requireWorkspace(db, who, args.workspaceId, "read")
      const row = db.prepare<unknown[], {
        workspace_id: string
        host_id: string
        second_device_open_at: number | null
        display_name: string | null
        expires_at: number
        last_seen_at: number
        session_authority: string | null
      }>(`
        SELECT assignment.workspace_id, assignment.host_id, assignment.second_device_open_at,
          enrollment.display_name, enrollment.expires_at, enrollment.last_seen_at,
          enrollment.session_authority
        FROM host_workspace_assignments assignment
        JOIN host_enrollments enrollment ON enrollment.host_id = assignment.host_id
          AND enrollment.owner_token_identifier = assignment.owner_token_identifier
        WHERE assignment.workspace_id = ? AND ${HOST_SERVING_WORKSPACE_SQL}
        LIMIT 1
      `).get(args.workspaceId, Date.now())
      if (!row) return { active: false as const }
      const sessionAuthority = hostSessionAuthority(row.session_authority)
      return {
        active: true as const,
        host_id: row.host_id,
        workspace_id: row.workspace_id,
        ...(row.display_name ? { display_name: row.display_name } : {}),
        ...(row.second_device_open_at ? { second_device_open_at: row.second_device_open_at } : {}),
        expires_at: row.expires_at,
        last_seen_at: row.last_seen_at,
        ...(sessionAuthority ? { session_authority: sessionAuthority } : {}),
      }
    },
    /** Every live assignment on the account, grouped for the devices surface. */
    async listHostAssignments(auth: SignedControlPlaneAuth) {
      const db = database()
      const who = user(auth)
      const rows = db.prepare<unknown[], {
        workspace_id: string
        host_id: string
        display_name: string | null
        last_seen_at: number
        expires_at: number
        acked_workspace_ids: string
      }>(`
        SELECT assignment.workspace_id, assignment.host_id,
          enrollment.display_name, enrollment.last_seen_at, enrollment.expires_at,
          COALESCE(enrollment.acked_workspace_ids, '[]') AS acked_workspace_ids
        FROM host_workspace_assignments assignment
        JOIN host_enrollments enrollment ON enrollment.host_id = assignment.host_id
          AND enrollment.owner_token_identifier = assignment.owner_token_identifier
        WHERE assignment.owner_token_identifier = ?
          AND enrollment.revoked_at IS NULL AND enrollment.paused_at IS NULL
          AND enrollment.expires_at > ?
        ORDER BY assignment.host_id, assignment.workspace_id
      `).all(who.token_identifier, Date.now())
      const groups = new Map<string, {
        host_id: string
        display_name: string
        last_seen_at: number
        expires_at: number
        workspace_ids: string[]
        acked_workspace_ids: string[]
      }>()
      for (const row of rows) {
        const group = groups.get(row.host_id) ?? {
          host_id: row.host_id,
          display_name: row.display_name ?? row.host_id,
          last_seen_at: row.last_seen_at,
          expires_at: row.expires_at,
          workspace_ids: [],
          acked_workspace_ids: ackedWorkspaceIds(row.acked_workspace_ids),
        }
        group.workspace_ids.push(row.workspace_id)
        groups.set(row.host_id, group)
      }
      return [...groups.values()]
    },

    async createHostInvitation(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      const scope = validatedScope(args.scope)
      // The invitation's org is the caller's current org, recorded now and
      // never inferred later — so a named org the caller is not in is a
      // refusal, not a fall-through to the personal org.
      const orgId = await workspaceAuthority.resolveOrgId(auth)
      if (auth.user.orgId && auth.user.orgId !== orgId) denied()
      const now = Date.now()
      const expiresIn = Number.isFinite(args.expiresInMs) && args.expiresInMs !== undefined
        ? Math.max(INVITATION_MIN_TTL_MS, Math.min(args.expiresInMs, INVITATION_MAX_TTL_MS))
        : INVITATION_DEFAULT_TTL_MS
      const invitationId = base64url(crypto.getRandomValues(new Uint8Array(16)))
      const secret = base64url(crypto.getRandomValues(new Uint8Array(32)))
      const expiresAt = now + expiresIn
      db.prepare(`
        INSERT INTO host_invitations (
          invitation_id, owner_token_identifier, org_id, secret_hash, display_name, scope_json,
          expires_at, created_by_token_identifier, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        invitationId,
        who.token_identifier,
        orgId,
        await sha256Hex(secret),
        args.displayName?.trim() || null,
        JSON.stringify(scope),
        expiresAt,
        who.token_identifier,
        now,
      )
      return { invitationId, token: invitationToken({ invitationId, secret }), expiresAt }
    },
    async listHostInvitations(auth: SignedControlPlaneAuth) {
      const db = database()
      const who = user(auth)
      return db.prepare<unknown[], HostInvitationRowRecord>(`
        SELECT * FROM host_invitations WHERE owner_token_identifier = ? ORDER BY created_at DESC, invitation_id
      `).all(who.token_identifier).map((row): HostInvitationRow => ({
        invitation_id: row.invitation_id,
        ...(row.display_name ? { display_name: row.display_name } : {}),
        scope: scopeDefinitionJson(row.scope_json),
        ...(row.org_id ? { org_id: row.org_id } : {}),
        created_at: row.created_at,
        expires_at: row.expires_at,
        ...(row.redeemed_at !== null ? { redeemed_at: row.redeemed_at } : {}),
        ...(row.redeemed_host_id ? { redeemed_host_id: row.redeemed_host_id } : {}),
        ...(row.redeemed_enrollment_id ? { redeemed_enrollment_id: row.redeemed_enrollment_id } : {}),
        ...(row.revoked_at !== null ? { revoked_at: row.revoked_at } : {}),
      }))
    },
    async revokeHostInvitation(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      // Never after redemption: the enrollment it created is revoked through
      // `revokeHostEnrollment`, and a redeem and a revoke cannot both win.
      const changed = db.prepare(`
        UPDATE host_invitations SET revoked_at = ?
        WHERE invitation_id = ? AND owner_token_identifier = ? AND revoked_at IS NULL AND redeemed_at IS NULL
      `).run(Date.now(), args.invitationId, who.token_identifier).changes
      return { revoked: changed > 0 }
    },
    async redeemHostInvitation(args) {
      const db = database()
      const invitationId = requiredText(args.invitationId, "invitationId")
      const secret = requiredText(args.secret, "secret")
      const hostId = requiredText(args.hostId, "hostId")
      const jwk = publicHostKey(args.publicKey)
      if (!jwk) throw new SqliteHostConnectError("invalid_input", "publicKey must be a public P-256 JWK")
      const fingerprint = await publicKeyFingerprint(jwk)
      try {
        await verifyHostSignature({
          public_key: JSON.stringify(jwk),
          payload: invitationRedeemPayload({ invitationId, hostId, publicKeySha256: fingerprint }),
          signature: args.signature,
        })
      } catch {
        throw new SqliteHostConnectError("host_attestation_denied", "Invalid host attestation")
      }
      const secretHash = await sha256Hex(secret)
      const publicKey = JSON.stringify(jwk)
      return db.transaction(() => {
        const now = Date.now()
        const invitation = db.prepare<unknown[], HostInvitationRowRecord>(`SELECT * FROM host_invitations WHERE invitation_id = ?`)
          .get(invitationId)
        // One answer for a wrong id and a wrong secret: the id is not secret,
        // but which half failed would tell a guesser it has half.
        if (!invitation || !secretHashMatches(invitation.secret_hash, secretHash)) {
          throw new SqliteHostConnectError("invitation_invalid", "Invitation is invalid")
        }
        if (invitation.redeemed_at !== null) {
          const resumable = invitation.redeemed_public_key_fingerprint === fingerprint && invitation.redeemed_host_id === hostId
          const enrollment = resumable && invitation.redeemed_enrollment_id
            ? db.prepare<unknown[], HostEnrollmentRow>(`SELECT * FROM host_enrollments WHERE enrollment_id = ?`)
              .get(invitation.redeemed_enrollment_id)
            : undefined
          if (enrollment && enrollment.revoked_at === null) {
            return redeemResult(db, { resumed: true, enrollment, invitation })
          }
          throw new SqliteHostConnectError("invitation_redeemed", "Invitation was already redeemed", {
            redeemed_host_id: invitation.redeemed_host_id,
            redeemed_at: invitation.redeemed_at,
          })
        }
        if (invitation.revoked_at !== null) throw new SqliteHostConnectError("invitation_revoked", "Invitation was revoked")
        if (invitation.expires_at <= now) throw new SqliteHostConnectError("invitation_expired", "Invitation has expired")
        // The (owner, host_id) pair is occupied for ever: a revoked row keeps
        // it, and a different key does not free it.
        const occupied = db.prepare(`SELECT 1 FROM host_enrollments WHERE owner_token_identifier = ? AND host_id = ?`)
          .get(invitation.owner_token_identifier, hostId)
        if (occupied) {
          throw new SqliteHostConnectError("invitation_host_conflict", "This owner already has an enrollment for that host id")
        }
        const enrollmentId = base64url(crypto.getRandomValues(new Uint8Array(16)))
        const claimed = db.prepare(`
          UPDATE host_invitations SET
            redeemed_at = ?, redeemed_host_id = ?, redeemed_public_key_fingerprint = ?, redeemed_enrollment_id = ?
          WHERE invitation_id = ? AND secret_hash = ? AND redeemed_at IS NULL AND revoked_at IS NULL AND expires_at > ?
        `).run(now, hostId, fingerprint, enrollmentId, invitationId, invitation.secret_hash, now).changes
        if (claimed !== 1) throw new SqliteHostConnectError("invitation_invalid", "Invitation is invalid")
        db.prepare(`
          INSERT INTO host_enrollments (
            enrollment_id, owner_token_identifier, host_id, public_key, display_name,
            last_seen_at, expires_at, key_version, serving_generation, enrolled_via, scope_json, scope_revision,
            created_at, updated_at
          )
          SELECT redeemed_enrollment_id, owner_token_identifier, redeemed_host_id, ?, ?,
            ?, ?, 1, 0, 'invitation', scope_json, 1, ?, ?
          FROM host_invitations WHERE invitation_id = ? AND redeemed_enrollment_id = ?
        `).run(
          publicKey,
          args.displayName?.trim() || invitation.display_name,
          now,
          now + ttl(undefined),
          now,
          now,
          invitationId,
          enrollmentId,
        )
        const enrollment = db.prepare<unknown[], HostEnrollmentRow>(`SELECT * FROM host_enrollments WHERE enrollment_id = ?`)
          .get(enrollmentId)
        if (!enrollment) throw new Error("host_enrollment_missing_after_redeem")
        recordHostAudit(db, {
          tokenIdentifier: invitation.owner_token_identifier,
          action: "host_enrollment.redeemed",
          metadata: { enrollment_id: enrollmentId, host_id: hostId, invitation_id: invitationId },
        })
        return redeemResult(db, { resumed: false, enrollment, invitation })
      })()
    },
    async updateHostEnrollmentScope(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      const scope = validatedScope(args.scope)
      return db.transaction(() => {
        const now = Date.now()
        const enrollment = db.prepare<unknown[], HostEnrollmentRow>(`
          SELECT * FROM host_enrollments WHERE enrollment_id = ? AND owner_token_identifier = ? AND revoked_at IS NULL
        `).get(args.enrollmentId, who.token_identifier)
        if (!enrollment) throw new SqliteHostConnectError("host_enrollment_not_found", "Host enrollment not found")
        const revision = enrollment.scope_revision + 1
        const updated = db.prepare(`
          UPDATE host_enrollments SET scope_json = ?, scope_revision = ?, updated_at = ?
          WHERE enrollment_id = ? AND scope_revision = ? AND revoked_at IS NULL
        `).run(JSON.stringify(scope), revision, now, enrollment.enrollment_id, enrollment.scope_revision).changes
        if (updated !== 1) throw new Error("host_enrollment_scope_raced")
        const assigned = db.prepare<unknown[], { workspace_id: string; remote_directory: string | null }>(`
          SELECT assignment.workspace_id, workspace.remote_directory
          FROM host_workspace_assignments assignment
          JOIN workspaces workspace ON workspace.workspace_id = assignment.workspace_id
          WHERE assignment.host_id = ? AND assignment.owner_token_identifier = ?
          ORDER BY assignment.workspace_id
        `).all(enrollment.host_id, enrollment.owner_token_identifier)
        const retired: string[] = []
        for (const assignment of assigned) {
          if (assignment.remote_directory !== null && directoryWithinRoots(assignment.remote_directory, scope.allowed_roots)) {
            db.prepare(`UPDATE workspaces SET org_member_visible = ?, updated_at = ? WHERE workspace_id = ?`)
              .run(orgMemberVisible(scope), now, assignment.workspace_id)
            continue
          }
          db.prepare(`DELETE FROM host_workspace_assignments WHERE workspace_id = ?`).run(assignment.workspace_id)
          db.prepare(`DELETE FROM host_assignment_readiness WHERE workspace_id = ?`).run(assignment.workspace_id)
          db.prepare(retireUserHostedWorkspaceSql("workspace_id = ?")).run(now, now, assignment.workspace_id)
          retired.push(assignment.workspace_id)
        }
        recordHostAudit(db, {
          tokenIdentifier: who.token_identifier,
          action: "host_enrollment.scope_updated",
          metadata: { enrollment_id: enrollment.enrollment_id, scope_revision: revision, retired_workspace_ids: retired },
        })
        return { scope: { ...scope, revision }, retired_workspace_ids: retired }
      })()
    },
    async listHostEnrollments(auth: SignedControlPlaneAuth) {
      const db = database()
      const who = user(auth)
      const rows = db.prepare<unknown[], HostEnrollmentRow>(`
        SELECT * FROM host_enrollments WHERE owner_token_identifier = ? AND revoked_at IS NULL
        ORDER BY last_seen_at DESC, enrollment_id
      `).all(who.token_identifier)
      const acked = db.prepare<unknown[], { workspace_id: string; revision: number }>(`
        SELECT workspace_id, revision FROM host_assignment_readiness
        WHERE enrollment_id = ? AND generation = ? ORDER BY workspace_id
      `)
      const out: HostEnrollmentListRow[] = []
      for (const row of rows) {
        const jwk = publicHostKey(row.public_key)
        out.push({
          enrollment_id: row.enrollment_id,
          ...(row.display_name ? { display_name: row.display_name } : {}),
          host_id: row.host_id,
          public_key_fingerprint: jwk ? await publicKeyFingerprint(jwk) : "",
          key_version: row.key_version,
          enrolled_via: row.enrolled_via === "invitation" ? "invitation" : "account",
          last_seen_at: row.last_seen_at,
          expires_at: row.expires_at,
          serving_generation: row.serving_generation,
          ...(row.generation_acquired_at !== null ? { generation_acquired_at: row.generation_acquired_at } : {}),
          ...(row.paused_at !== null ? { paused_at: row.paused_at } : {}),
          assignments: hostAssignments(db, row.host_id, row.owner_token_identifier).descriptions,
          acked: acked.all(row.enrollment_id, row.serving_generation)
            .map((ack): HostAssignmentAck => ({ workspaceId: ack.workspace_id, revision: ack.revision })),
          scope: enrollmentScope(row),
        })
      }
      return out
    },
    machineAuth: {
      async lookupEnrollment(enrollmentId) {
        const db = database()
        const row = db.prepare<unknown[], HostEnrollmentRow & { owner_eligible: number }>(`
          SELECT enrollment.*, ${ownerEligibleSql("enrollment")} AS owner_eligible
          FROM host_enrollments enrollment WHERE enrollment.enrollment_id = ?
        `).get(enrollmentId)
        if (!row) return undefined
        return {
          enrollment_id: row.enrollment_id,
          host_id: row.host_id,
          owner_user_id: row.owner_token_identifier,
          owner_actor_id: row.owner_token_identifier,
          public_key_json: row.public_key,
          key_version: row.key_version,
          serving_generation: row.serving_generation,
          revoked_at: row.revoked_at,
          paused_at: row.paused_at,
          scope: enrollmentScope(row),
          ownerEligible: row.owner_eligible === 1,
        }
      },
      async consumeNonce(input) {
        const db = database()
        return db.prepare(`
          INSERT INTO host_request_nonces (enrollment_id, nonce, expires_at) VALUES (?, ?, ?)
          ON CONFLICT (enrollment_id, nonce) DO NOTHING
        `).run(input.enrollmentId, input.nonce, input.expiresAt).changes === 1
      },
    } satisfies MachineAuthAdapter,

    async markSecondDeviceOpen(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      const workspace = workspaceByPublicId(db, args.workspaceId)
      if (!workspace || !authorizeWorkspaceForUser(db, workspace, who, "read")) denied()
      const now = Date.now()
      const result = db.prepare(`
        UPDATE host_workspace_assignments
        SET second_device_open_at = COALESCE(second_device_open_at, ?), updated_at = ?
        WHERE workspace_id = ? AND owner_token_identifier = ?
      `).run(now, now, args.workspaceId, who.token_identifier)
      return { recorded: result.changes > 0, second_device_open_at: now }
    },

    // --- sessions (the session authority) --------------------------------------
    async grantSessionShare(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      const workspace = workspaceByPublicId(db, args.workspaceId)
      const session = db.prepare<unknown[], SessionRow>(`SELECT * FROM session_history WHERE session_id = ?`).get(args.sessionId)
      if (!workspace || !session || session.workspace_id !== args.workspaceId || session.deleted_at) denied()
      if (!authorizeWorkspaceForUser(db, workspace, who, "read")) denied()
      if (
        session.creator_actor_id !== who.token_identifier
        && !orgAdminForUser(db, who, workspace.org_id)
        && !teamAdminForProject(db, who, workspace)
      ) throw new Error("session_share_admin_required")
      const selectors = [
        args.grantedToTokenIdentifier,
        args.grantedToSubject,
        args.grantedToUserId,
        args.grantedToOrgId,
        args.grantedToTeamId,
        args.grantedToTeamPublicId,
      ].filter(Boolean)
      if (selectors.length !== 1) throw new Error("session_share_target_required")
      const userTarget = args.grantedToTokenIdentifier
        ? db.prepare<unknown[], AuthorityUser>(`SELECT token_identifier FROM users WHERE token_identifier = ?`).get(args.grantedToTokenIdentifier)
        : args.grantedToSubject
          ? userBySubject(db, args.grantedToSubject)
          : args.grantedToUserId
            ? db.prepare<unknown[], AuthorityUser>(`SELECT token_identifier FROM users WHERE public_id = ? OR token_identifier = ?`)
              .get(args.grantedToUserId, args.grantedToUserId)
            : undefined
      const orgSelector = args.grantedToOrgId
      const org = orgSelector ? activeOrgById(db, orgSelector) : undefined
      const teamSelector = args.grantedToTeamId ?? args.grantedToTeamPublicId
      const team = teamSelector
        ? db.prepare<unknown[], { team_id: string; org_id: string }>(`SELECT team_id, org_id FROM teams WHERE team_id = ? AND deleted_at IS NULL`)
          .get(teamSelector)
        : undefined
      if (!userTarget && !org && !team) throw new Error("session_share_target_not_found")
      if (userTarget && !authorizeWorkspaceForUser(db, workspace, userTarget, "read")) {
        throw new Error("session_participant_workspace_access_required")
      }
      if (team && team.org_id !== workspace.org_id) throw new Error("session_share_team_org_mismatch")
      if (org && workspace.org_id && org.org_id !== workspace.org_id) throw new Error("session_share_org_mismatch")
      const now = Date.now()
      const existing = db.prepare<unknown[], IdentifiedSessionShareTargetRow>(`
        SELECT grant_id, granted_to_user_token_identifier, granted_to_org_id, granted_to_team_id
        FROM session_share_grants WHERE session_id = ? AND revoked_at IS NULL
      `).all(args.sessionId)
      const match = existing.filter((grant) => {
        if (userTarget) return grant.granted_to_user_token_identifier === userTarget.token_identifier
        if (team) return grant.granted_to_team_id === team.team_id
        if (org) return grant.granted_to_org_id === org.org_id
        return false
      })
      if (match.length === 1) return { grant_id: match[0].grant_id }
      for (const grant of match) {
        db.prepare(`UPDATE session_share_grants SET revoked_at = ? WHERE grant_id = ?`).run(now, grant.grant_id)
      }
      const grantId = `ssg_${randomToken()}`
      db.prepare(`
        INSERT INTO session_share_grants (
          grant_id, session_id, workspace_id, granted_to_user_token_identifier, granted_to_org_id,
          granted_to_team_id, created_by_token_identifier, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        grantId,
        args.sessionId,
        args.workspaceId,
        userTarget?.token_identifier ?? null,
        org?.org_id ?? null,
        team?.team_id ?? null,
        who.token_identifier,
        now,
      )
      return { grant_id: grantId }
    },
    async revokeSessionShare(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      const workspace = workspaceByPublicId(db, args.workspaceId)
      const session = db.prepare<unknown[], SessionRow>(`SELECT * FROM session_history WHERE session_id = ?`).get(args.sessionId)
      if (!workspace || !session || session.workspace_id !== args.workspaceId || session.deleted_at) denied()
      if (!authorizeWorkspaceForUser(db, workspace, who, "read")) denied()
      if (
        session.creator_actor_id !== who.token_identifier
        && !orgAdminForUser(db, who, workspace.org_id)
        && !teamAdminForProject(db, who, workspace)
      ) throw new Error("session_share_admin_required")
      const now = Date.now()
      let grants: IdentifiedSessionShareTargetRow[]
      if (args.grantId) {
        grants = db.prepare<unknown[], IdentifiedSessionShareTargetRow>(`
          SELECT grant_id, granted_to_user_token_identifier, granted_to_org_id, granted_to_team_id
          FROM session_share_grants
          WHERE session_id = ? AND grant_id = ? AND revoked_at IS NULL
        `).all(args.sessionId, args.grantId)
      } else {
        const selectors = [
          args.grantedToTokenIdentifier,
          args.grantedToSubject,
          args.grantedToUserId,
          args.grantedToOrgId,
          args.grantedToTeamId,
          args.grantedToTeamPublicId,
        ].filter(Boolean)
        if (selectors.length !== 1) throw new Error("session_share_target_required")
        const userTarget = args.grantedToTokenIdentifier
          ? args.grantedToTokenIdentifier
          : args.grantedToSubject
            ? userBySubject(db, args.grantedToSubject)?.token_identifier
            : args.grantedToUserId
              ? (db.prepare<unknown[], { token_identifier: string }>(`SELECT token_identifier FROM users WHERE public_id = ? OR token_identifier = ?`)
                .get(args.grantedToUserId, args.grantedToUserId))?.token_identifier
              : undefined
        const orgSelector = args.grantedToOrgId
        const orgId = orgSelector ? activeOrgById(db, orgSelector)?.org_id : undefined
        const teamId = args.grantedToTeamId ?? args.grantedToTeamPublicId
        grants = db.prepare<unknown[], IdentifiedSessionShareTargetRow>(`
          SELECT grant_id, granted_to_user_token_identifier, granted_to_org_id, granted_to_team_id
          FROM session_share_grants WHERE session_id = ? AND revoked_at IS NULL
        `).all(args.sessionId).filter((grant) => {
          if (userTarget) return grant.granted_to_user_token_identifier === userTarget
          if (teamId) return grant.granted_to_team_id === teamId
          if (orgId) return grant.granted_to_org_id === orgId
          return false
        })
      }
      if (grants.length === 0) return { revoked: false, revokedTargets: [] }
      const revokedTargets = grants.flatMap((grant): SessionShareFanoutTarget[] => {
        if (grant.granted_to_user_token_identifier) {
          return [{ grantedToTokenIdentifier: grant.granted_to_user_token_identifier }]
        }
        if (grant.granted_to_team_id) {
          return [{ grantedToTeamPublicId: grant.granted_to_team_id }]
        }
        if (grant.granted_to_org_id) {
          return [{ grantedToOrgId: grant.granted_to_org_id }]
        }
        return []
      })
      const tokenIdentifiers = new Set<string>()
      for (const grant of grants) {
        db.prepare(`UPDATE session_share_grants SET revoked_at = ? WHERE grant_id = ?`).run(now, grant.grant_id)
        if (grant.granted_to_user_token_identifier) tokenIdentifiers.add(grant.granted_to_user_token_identifier)
        if (grant.granted_to_org_id) {
          for (const membership of db.prepare<unknown[], { token_identifier: string }>(`SELECT token_identifier FROM org_memberships WHERE org_id = ?`)
            .all(grant.granted_to_org_id)) {
            tokenIdentifiers.add(membership.token_identifier)
          }
        }
        if (grant.granted_to_team_id) {
          for (const membership of db.prepare<unknown[], { user_token_identifier: string }>(`SELECT user_token_identifier FROM team_memberships WHERE team_id = ?`)
            .all(grant.granted_to_team_id)) {
            tokenIdentifiers.add(membership.user_token_identifier)
          }
        }
      }
      return {
        revoked: true,
        runtime_tokens_revoked: revokeRuntimeTokensForUsers(db, args.workspaceId, [...tokenIdentifiers]),
        revokedTargets,
      }
    },
    async listSessionShares(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      const workspace = workspaceByPublicId(db, args.workspaceId)
      if (!workspace || workspace.deleted_at) throw new Error("Session not found")
      const workspaceRole = authorizeWorkspaceForUser(db, workspace, who, "read")
      if (!workspaceRole) throw new Error("session_share_admin_required")
      const session = db.prepare<unknown[], SessionRow>(`SELECT * FROM session_history WHERE session_id = ?`).get(args.sessionId)
      // A session this authority does not hold has no shares here and none to
      // manage — a definite answer for a workspace reader, not an error.
      if (!session || session.workspace_id !== args.workspaceId || session.deleted_at) {
        return { can_manage_shares: false, grants: [], participants: [], teams: [] }
      }
      const isOrgAdmin = orgAdminForUser(db, who, workspace.org_id)
      const canManageShares = session.creator_actor_id === who.token_identifier
        || isOrgAdmin
        || teamAdminForProject(db, who, workspace)
      if (
        !canManageShares
        && !sessionRoleForWorkspaceUser(db, workspace, session, who, workspaceRole, isOrgAdmin)
      ) throw new Error("session_share_admin_required")
      if (!canManageShares) {
        return { can_manage_shares: false, grants: [], participants: [], teams: [] }
      }
      const grants = db.prepare<unknown[], Record<string, unknown>>(`
        SELECT grant_id, session_id, workspace_id, granted_to_user_token_identifier AS granted_to_user_id,
          granted_to_org_id, granted_to_team_id, created_by_token_identifier AS created_by_user_id,
          created_at, revoked_at
        FROM session_share_grants
        WHERE session_id = ? AND revoked_at IS NULL
        ORDER BY created_at ASC
      `).all(args.sessionId)
      const participants = db.prepare<unknown[], Record<string, unknown>>(`
        SELECT participant_actor_id AS user_id, added_by_actor_id AS added_by_user_id, created_at
        FROM session_participants
        WHERE session_id = ? AND revoked_at IS NULL
        ORDER BY created_at ASC
      `).all(args.sessionId)
      const sharedTeamIds = new Set(grants.flatMap((grant: any) =>
        typeof grant.granted_to_team_id === "string" ? [grant.granted_to_team_id] : []))
      const teams = db.prepare(`
        SELECT team_id, name FROM teams
        WHERE org_id = ? AND deleted_at IS NULL
        ORDER BY name ASC
      `).all(workspace.org_id).map((team: any) => ({
        team_id: team.team_id,
        name: team.name,
        is_shared: sharedTeamIds.has(team.team_id),
      }))
      return { can_manage_shares: true, grants, participants, teams }
    },
    // --- runtime tokens ------------------------------------------------------
    async resolveRuntimeMachineAccess(actorId, workspaceId) {
      const db = database()
      const who = db.prepare<unknown[], AuthorityUser>(`SELECT token_identifier, subject, kind, public_id, name, image_url FROM users WHERE token_identifier = ?`).get(actorId)
      if (!who || who.kind !== "human") denied()
      const workspace = requireWorkspace(db, who, workspaceId, "write")
      const role = workspaceRoleForUser(db, workspace, who)
      if (!role) denied()
      return { actorId: who.token_identifier, actorKind: "human" as const, orgId: workspace.org_id, role, ...(who.public_id && who.name ? { actorPublicId: who.public_id, actorName: who.name, ...(who.image_url ? { actorAvatarUrl: who.image_url } : {}) } : {}) }
    },
    async recordActorRuntimeAccessToken(args) {
      const db = database()
      const who = db.prepare<unknown[], AuthorityUser>(`SELECT token_identifier, subject, kind FROM users WHERE token_identifier = ?`).get(args.actorId)
      if (!who || who.kind !== "human" || args.actorKind !== "human") denied()
      return recordUserRuntimeToken(who, args)
    },
    async resolveChannelMachineAccess(identity, workspaceId) {
      const db = database()
      const who = linkedChannelUser(db, identity)
      if (!who) denied()
      const workspace = requireWorkspace(db, who, workspaceId, "write")
      const role = workspaceRoleForUser(db, workspace, who)
      if (!role || !workspace.org_id) denied()
      return { actorId: who.token_identifier, actorKind: "human" as const, orgId: workspace.org_id, role, ...(who.public_id && who.name ? { actorPublicId: who.public_id, actorName: who.name, ...(who.image_url ? { actorAvatarUrl: who.image_url } : {}) } : {}) }
    },
    async recordChannelRuntimeAccessToken(identity, args) {
      const db = database()
      const who = linkedChannelUser(db, identity)
      if (!who || who.token_identifier !== args.actorId || who.kind !== args.actorKind) denied()
      return recordUserRuntimeToken(who, args)
    },
    async recordRuntimeAccessToken(auth: SignedControlPlaneAuth, args) {
      const who = user(auth)
      if (who.token_identifier !== args.actorId || who.kind !== args.actorKind) denied()
      return recordUserRuntimeToken(who, args)
    },
    async recordRuntimeAccessTokenForService(args) {
      const db = database()
      const workspace = workspaceByPublicId(db, args.workspaceId)
      const who = args.principalKind === "user"
        ? db.prepare<unknown[], AuthorityUser>(`SELECT token_identifier, subject, kind FROM users WHERE token_identifier = ?`)
            .get(args.actorId)
        : undefined
      const currentRole = workspace && who ? workspaceRoleForUser(db, workspace, who) : undefined
      const userAllowed = args.principalKind === "user"
        && who
        && who.kind === args.actorKind
        && currentRole
        && roleAtLeast(currentRole, args.role)
      const serviceAllowed = args.principalKind === "service"
        && args.actorKind === "agent"
        && !!args.actorId.trim()
        && args.role === "owner"
      if (!workspace || workspace.deleted_at || (!userAllowed && !serviceAllowed)) denied()
      const existing = db.prepare(`SELECT jti FROM runtime_access_tokens WHERE jti = ?`).get(args.jti)
      if (existing) throw new Error("Runtime Access Token already recorded")
      db.prepare(`
        INSERT INTO runtime_access_tokens
          (jti, workspace_id, host_id, principal_kind, actor_id, actor_kind, role, minted_for_token_identifier, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        args.jti,
        args.workspaceId,
        args.hostId,
        args.principalKind,
        args.actorId,
        args.actorKind,
        args.role,
        args.principalKind === "user" ? args.actorId : null,
        args.expiresAt,
        Date.now(),
      )
      return { ok: true }
    },
    async runtimeAccessTokenActive(args) {
      const db = database()
      const token = db.prepare<unknown[], {
        workspace_id: string
        host_id: string
        minted_for_token_identifier: string | null
        principal_kind: "user" | "service"
        actor_id: string
        actor_kind: "human" | "agent"
        role: "viewer" | "editor" | "admin" | "owner"
        expires_at: number
        revoked_at: number | null
      }>(`SELECT * FROM runtime_access_tokens WHERE jti = ?`).get(args.jti)
      if (!token) {
        return { active: false, code: "runtime_access_token_unknown", reason: "Runtime Access Token has not been recorded" }
      }
      if (token.revoked_at) {
        return { active: false, code: "runtime_access_token_revoked", reason: "Runtime Access Token has been revoked" }
      }
      if (token.workspace_id !== args.workspaceId || token.host_id !== args.hostId) {
        return { active: false, code: "runtime_access_token_mismatch", reason: "Runtime Access Token does not match workspace or host" }
      }
      if (token.expires_at <= Date.now()) {
        return { active: false, code: "runtime_access_token_expired", reason: "Runtime Access Token has expired" }
      }
      const workspace = workspaceByPublicId(db, args.workspaceId)
      const who = token.principal_kind === "user"
        ? db.prepare<unknown[], AuthorityUser>(`SELECT token_identifier, subject, kind FROM users WHERE token_identifier = ?`)
            .get(token.actor_id)
        : undefined
      const currentRole = workspace && who ? workspaceRoleForUser(db, workspace, who) : undefined
      const authorizationChanged = !workspace
        || !!workspace.deleted_at
        || (token.principal_kind === "user" && (
          !who
          || who.kind !== token.actor_kind
          || !currentRole
          || !roleAtLeast(currentRole, token.role)
        ))
        || (token.principal_kind === "service" && (
          token.role !== "owner"
          || token.actor_kind !== "agent"
          || !token.actor_id.trim()
        ))
        || (args.minimumRole && (token.principal_kind === "user"
          ? !currentRole || !roleAtLeast(currentRole, args.minimumRole)
          : !roleAtLeast(token.role, args.minimumRole)))
      if (authorizationChanged) {
        return {
          active: false,
          code: "runtime_access_token_revoked",
          reason: "Runtime Access Token authorization has changed",
        }
      }
      return { active: true }
    },
    async revokeRuntimeAccessToken(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      requireWorkspace(db, who, args.workspaceId, "read")
      db.prepare(`
        UPDATE runtime_access_tokens SET revoked_at = ?
        WHERE jti = ? AND workspace_id = ? AND revoked_at IS NULL
      `).run(Date.now(), args.jti, args.workspaceId)
      return { ok: true }
    },
    async revokeRuntimeAccessTokensForWorkspaceUser(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      requireWorkspace(db, who, args.workspaceId, "read")
      return { revoked: revokeRuntimeTokensForUsers(db, args.workspaceId, [who.token_identifier]) }
    },

    // --- audit ---------------------------------------------------------------
    async auditDeny(auth, args) {
      const db = database()
      db.prepare(`
        INSERT INTO audit_events (token_identifier, workspace_id, action, result, reason, metadata, created_at)
        VALUES (?, ?, ?, 'deny', ?, ?, ?)
      `).run(
        auth?.user.tokenIdentifier ?? null,
        args.workspaceId ?? null,
        args.action,
        args.reason,
        args.metadata ? jsonText(args.metadata) : null,
        Date.now(),
      )
    },
    async auditAllow(auth: SignedControlPlaneAuth, args) {
      const db = database()
      db.prepare(`
        INSERT INTO audit_events (token_identifier, workspace_id, action, result, reason, metadata, created_at)
        VALUES (?, ?, ?, 'allow', NULL, ?, ?)
      `).run(
        auth.user.tokenIdentifier,
        args.workspaceId ?? null,
        args.action,
        args.metadata ? jsonText(args.metadata) : null,
        Date.now(),
      )
    },
  }
  return Object.assign(workspaceAuthority, privateSessions)
}

/** The host's acknowledged workspace ids, as persisted by `markSecondDeviceOpen`. */
function ackedWorkspaceIds(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json)
    return Array.isArray(parsed) ? parsed.flatMap((item) => jsonString(item) ?? []) : []
  } catch {
    return []
  }
}
