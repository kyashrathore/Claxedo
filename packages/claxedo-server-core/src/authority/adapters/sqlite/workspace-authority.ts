import { ControlPlaneAuthError, type SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type {
  HostEnrollment,
  OrgId,
  ProjectAction,
  ProjectRoleResult,
  SessionShareFanoutTarget,
  WorkspaceAuthority,
  WorkspaceShareTarget,
} from "@claxedo/server-core/platform/auth/authority"
import type { PrivateSessionAuthority } from "@claxedo/server-core/platform/auth/private-session-authority"
import type { SessionTurnAuthority } from "@claxedo/server-core/platform/auth/session-turn-authority"
import { randomToken } from "@claxedo/server-core/platform/auth/web-crypto"
import {
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
  type SqliteAuthorityDb,
  type SqliteWorkspaceAuthorityOptions,
  type WorkspaceAction,
  type WorkspaceRow,
  type WorkspaceRole,
} from "./workspace-authority-store"
import { createSqlitePrivateSessionAuthority } from "./private-session-authority"

// Claxedo's LOCAL workspace-authority adapter: the full `WorkspaceAuthority`
// port backed by a local SQLite database instead of Convex. This is the
// self-host enabler — a deployment with NO Convex/Clerk env composes this
// authority so `requireAuthority` never fails 503 and workspace/session
// features work out of the box. Per-method semantics mirror the Convex
// backend functions (convex/workspaces.ts, convex/hostEnrollments.ts, ...).
// Node-only (better-sqlite3 via the store): hosted/Worker compositions must
// never import this module (worker.import-graph guard).

// Mirrors convex/hostEnrollments.ts TTL policy.
const DEFAULT_TTL_MS = 60_000
const MAX_TTL_MS = 5 * 60_000

/**
 * Machine-enrollment retention policy — ONE canonical set of bounds, mirrored
 * verbatim in `convex/hostEnrollments.ts`.
 *
 * The two authorities are two implementations of one contract, so the numbers
 * are not adapter defaults to be tuned independently: a self-hosted SQLite
 * deployment and Convex Cloud must retire the same row at the same age or
 * "same bounds" is a claim nobody checks. `host-enrollment-policy-drift.test.ts`
 * reads both source files and fails when a value moves on one side only.
 *
 * ENROLLMENT_CHALLENGE_TTL_MS — how long an unconsumed nonce may be signed.
 *   60s, deliberately STRICTER than the plan's two minutes. The nonce is
 *   already one-use, owner-bound and host-bound, so its lifetime is
 *   defence-in-depth rather than the primary control; what the number really
 *   buys is a bound on how many live unconsumed rows an attacker can hold at
 *   once (steady-state rows = per-account budget x TTL). A client that takes
 *   longer than a minute — a first enrollment blocked on an OS keychain prompt,
 *   say — simply asks for another nonce, and `POST /requests` mutates no
 *   enrollment, so the retry is free. See the plan's Unit 6 retention bullet.
 *
 * ENROLLMENT_CONSUMED_RETENTION_MS — how long a CONSUMED request row is kept.
 *   The evidence a future exact-retry answer would be reconstructed from, so
 *   the sweep must never collect a consumed row earlier than this. Implemented
 *   by pushing `expires_at` out at consumption (see `enrollHost`), which is the
 *   same device `convex/connectionAttempts.ts` uses for its retention window.
 *
 * ENROLLMENT_REQUEST_SWEEP_LIMIT — rows one prune may retire. Level-triggered:
 *   a saturated pass leaves the rest for the next writer, and nothing is
 *   skipped forever because an expired row stays expired.
 */
const ENROLLMENT_CHALLENGE_TTL_MS = 60_000
const ENROLLMENT_CONSUMED_RETENTION_MS = 10 * 60_000
const ENROLLMENT_REQUEST_SWEEP_LIMIT = 500

/** A signed heartbeat payload must stay small; 200 shares per machine is generous. Mirrors the D1 authority. */
const MAX_ACKED_WORKSPACES = 200

function ttl(input?: number) {
  if (!input || !Number.isFinite(input)) return DEFAULT_TTL_MS
  return Math.max(5_000, Math.min(input, MAX_TTL_MS))
}

function requiredText(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`)
  return value.trim()
}

function roleAction(value: "viewer" | "editor" | "admin" | "owner") {
  return value === "viewer" ? "read" as const : value === "editor" ? "write" as const : value
}

function sqliteShareTarget(target: WorkspaceShareTarget): {
  tokenIdentifier: string | null
  orgId: string | null
} {
  if (target.kind === "actor") {
    if (!target.actorId.trim()) throw new Error("Share actor id is required")
    return { tokenIdentifier: target.actorId, orgId: null }
  }
  if (target.kind === "user") {
    if (!target.userId.trim()) throw new Error("Share user id is required")
    return { tokenIdentifier: target.userId, orgId: null }
  }
  if (!target.orgId.trim()) throw new Error("Share organization id is required")
  return { tokenIdentifier: null, orgId: target.orgId }
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
  created_at: number
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

function refuseCloudWorkspace(workspace: { backing?: unknown; access?: unknown }) {
  if (workspace.backing === "cloud-vm" || workspace.access === "cloud") {
    throw new Error("workspace_backing_conflict: cannot attach a local host link to a cloud workspace")
  }
}

// Mirrors `KNOWN_HOME_REGIONS` in convex/workspaces.ts: validate only, never default.
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

function object(input: unknown) {
  return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : undefined
}

function sourceKey(input: unknown) {
  const source = object(input)
  if (!source) return
  return JSON.stringify(Object.fromEntries(Object.entries(source).sort(([a], [b]) => a.localeCompare(b))))
}

function txt(input: unknown) {
  return typeof input === "string" && input.trim() ? input.trim() : undefined
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
  grantedToClerkSubject?: string
  grantedToClerkOrgId?: string
  grantedToTeamId?: string
  grantedToTeamPublicId?: string
}, options: { requireExisting: boolean }): ShareTarget {
  const selectors = [
    args.grantedToTokenIdentifier,
    args.grantedToClerkSubject,
    args.grantedToClerkOrgId,
    args.grantedToTeamId,
    args.grantedToTeamPublicId,
  ].filter(Boolean)
  if (selectors.length !== 1) throw new Error("Share target must be exactly one user, org, or team")

  if (args.grantedToTokenIdentifier) {
    const target = db.prepare(`SELECT token_identifier, subject FROM users WHERE token_identifier = ?`)
      .get(args.grantedToTokenIdentifier) as AuthorityUser | undefined
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

  if (args.grantedToClerkSubject) {
    const subjectUsers = usersBySubject(db, args.grantedToClerkSubject)
    if (subjectUsers.length > 1) denied()
    const target = subjectUsers[0]
    if (!target && options.requireExisting) throw new Error("Share target not found")
    return target
      ? {
          primaryKey: `token:${target.token_identifier}`,
          activeKeys: [`token:${target.token_identifier}`, `subject:${args.grantedToClerkSubject}`],
          subject: args.grantedToClerkSubject,
        }
      : {
          primaryKey: `subject:${args.grantedToClerkSubject}`,
          activeKeys: [`subject:${args.grantedToClerkSubject}`],
          subject: args.grantedToClerkSubject,
        }
  }

  const teamSelector = args.grantedToTeamId ?? args.grantedToTeamPublicId
  if (teamSelector) {
    const team = db.prepare(`
      SELECT team_id, org_id FROM teams WHERE team_id = ? AND deleted_at IS NULL
    `).get(teamSelector) as { team_id: string; org_id: string } | undefined
    if (!team && options.requireExisting) throw new Error("Share target not found")
    const teamId = team?.team_id ?? teamSelector
    return {
      primaryKey: `team:${teamId}`,
      activeKeys: [`team:${teamId}`],
      teamId,
      ...(team ? { teamOrgId: team.org_id } : {}),
    }
  }

  const orgSelector = args.grantedToClerkOrgId!
  const org = db.prepare(`
    SELECT org_id FROM orgs
    WHERE deleted_at IS NULL AND (org_id = ? OR clerk_org_id = ?)
    ORDER BY CASE WHEN org_id = ? THEN 0 ELSE 1 END
    LIMIT 1
  `).get(orgSelector, orgSelector, orgSelector) as { org_id: string } | undefined
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
  return shareTarget(db, { grantedToClerkOrgId: requiredText(target.orgId, "orgId") }, options)
}

function jsonText(input: unknown) {
  try {
    return JSON.stringify(input) ?? "null"
  } catch {
    return "null"
  }
}

function producerAuthorTokenIdentifier(
  db: SqliteAuthorityDb,
  message: unknown,
  expectedTokenIdentifier: string,
) {
  const row = object(message)
  const info = object(row?.info)
  const claxedo = object(info?.claxedo)
  const author = object(claxedo?.author)
  const publicId = txt(author?.id)
  if (!publicId) return
  const tokenIdentifier = (db.prepare(`SELECT token_identifier FROM users WHERE public_id = ?`).get(publicId) as {
    token_identifier: string
  } | undefined)?.token_identifier
  return tokenIdentifier === expectedTokenIdentifier ? tokenIdentifier : undefined
}

function messageWithPublicAuthor(input: unknown, user?: {
  public_id: string | null
  name: string | null
  image_url: string | null
  kind: string | null
}) {
  const row = object(input)
  const info = object(row?.info)
  if (!row || !info || info.role !== "user") return input
  const claxedo = object(info.claxedo) ?? {}
  const { author: _untrustedAuthor, ...safeClaxedo } = claxedo
  const { claxedo: _untrustedClaxedo, ...safeInfo } = info
  const canonicalClaxedo = user?.public_id
    ? {
        ...safeClaxedo,
        author: {
          id: user.public_id,
          name: user.name ?? (user.kind === "agent" ? "Agent" : "User"),
          kind: user.kind === "agent" ? "agent" : "human",
          ...(user.image_url ? { avatarUrl: user.image_url } : {}),
        },
      }
    : safeClaxedo
  return {
    ...row,
    info: {
      ...safeInfo,
      ...(Object.keys(canonicalClaxedo).length > 0 ? { claxedo: canonicalClaxedo } : {}),
    },
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
      const membership = db.prepare(`
        SELECT m.role FROM org_memberships m
        JOIN orgs o ON o.org_id = m.org_id
        WHERE m.org_id = ? AND m.token_identifier = ? AND o.deleted_at IS NULL
      `).get(input.orgId, who.token_identifier) as { role: string } | undefined
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

  const policyRows = (db: SqliteAuthorityDb, input: {
    workspace: WorkspaceRow
    userKey?: string
  }) => {
    const keys: Array<{ scope: string; key: string }> = [
      ...(input.workspace.org_id ? [{ scope: "org", key: input.workspace.org_id }] : []),
      ...(input.userKey ? [{ scope: "user", key: input.userKey }] : []),
      { scope: "workspace", key: input.workspace.workspace_id },
    ]
    return keys.flatMap(({ scope, key }) =>
      db.prepare(`
        SELECT extension_id, scope, enabled, reason FROM agent_extension_policy_overrides
        WHERE scope = ? AND scope_key = ? AND deleted_at IS NULL
      `).all(scope, key) as Array<{ extension_id: string; scope: string; enabled: number; reason: string | null }>,
    ).map((row) => ({
      id: row.extension_id,
      scope: row.scope,
      enabled: !!row.enabled,
      ...(row.reason ? { reason: row.reason } : {}),
    }))
  }

  const policyScopeKey = (db: SqliteAuthorityDb, who: AuthorityUser, workspace: WorkspaceRow, scope: "org" | "user" | "workspace") => {
    if (scope === "org") {
      if (!workspace.org_id) throw new Error("Workspace has no org")
      return workspace.org_id
    }
    if (scope === "user") return who.token_identifier
    return workspace.workspace_id
  }

  const linkedChannelUser = (db: SqliteAuthorityDb, args: { channel: string; externalUserId: string }) => {
    const link = db.prepare(`
      SELECT token_identifier FROM channel_identities
      WHERE channel = ? AND external_user_id = ? AND revoked_at IS NULL
    `).get(args.channel, args.externalUserId) as { token_identifier: string } | undefined
    if (!link) return
    return db.prepare(`SELECT token_identifier, public_id, subject, name, image_url FROM users WHERE token_identifier = ?`)
      .get(link.token_identifier) as AuthorityUser | undefined
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
  ) => {
    if (session.creator_actor_id === who.token_identifier) return workspaceRole
    const participant = db.prepare(`
      SELECT revoked_at FROM session_participants WHERE session_id = ? AND participant_actor_id = ?
    `).get(session.session_id, who.token_identifier) as { revoked_at: number | null } | undefined
    if (participant && !participant.revoked_at) return workspaceRole
    if (sessionShareAllowsUser(db, who, session.session_id)) return workspaceRole
    if (isOrgAdmin ?? orgAdminForUser(db, who, workspace.org_id)) return workspaceRole
  }

  const sessionRole = (
    db: SqliteAuthorityDb,
    workspace: WorkspaceRow,
    session: SessionRow,
    who: AuthorityUser,
    action: WorkspaceAction,
  ) => {
    const workspaceRole = authorizeWorkspaceForUser(db, workspace, who, action)
    if (!workspaceRole) return
    return sessionRoleForWorkspaceUser(db, workspace, session, who, workspaceRole)
  }

  const sessionShareAllowsUser = (db: SqliteAuthorityDb, who: AuthorityUser, sessionId: string) => {
    const grants = db.prepare(`
      SELECT granted_to_user_token_identifier, granted_to_org_id, granted_to_team_id
      FROM session_share_grants
      WHERE session_id = ? AND revoked_at IS NULL
    `).all(sessionId) as Array<{
      granted_to_user_token_identifier: string | null
      granted_to_org_id: string | null
      granted_to_team_id: string | null
    }>
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
    const memberships = db.prepare(`
      SELECT m.team_id AS team_id, m.role AS role FROM team_memberships m
      JOIN teams t ON t.team_id = m.team_id
      WHERE m.user_token_identifier = ? AND t.org_id = ? AND t.deleted_at IS NULL
        AND (m.role = 'admin' OR m.role = 'owner')
    `).all(who.token_identifier, workspace.org_id) as Array<{ team_id: string; role: string }>
    for (const membership of memberships) {
      const grant = db.prepare(`
        SELECT 1 FROM team_project_grants
        WHERE team_id = ? AND project_id = ? AND revoked_at IS NULL
      `).get(membership.team_id, workspace.project_id)
      if (grant) return true
    }
    return false
  }

  // Mirror of convex/projects.ts `authResult`: role (optionally action-gated)
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
    return { ok: true, role, orgId: project.org_id as OrgId }
  }

  const listAgentExtensions = (db: SqliteAuthorityDb, workspaceId: string) => {
    const rows = db.prepare(`
      SELECT desired, lock, enabled, updated_at FROM agent_extension_installs
      WHERE workspace_id = ? AND deleted_at IS NULL
      ORDER BY extension_id ASC
    `).all(workspaceId) as Array<{ desired: string; lock: string | null; enabled: number; updated_at: number }>
    return rows.map((row) => ({
      desired: JSON.parse(row.desired) as unknown,
      lock: row.lock === null ? undefined : JSON.parse(row.lock) as unknown,
      enabled: !!row.enabled,
      updated_at: row.updated_at,
    }))
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
    // --- identity (convex/users.ts, convex/orgs.ts, convex/projects.ts) ----
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
        SELECT o.org_id, o.clerk_org_id, o.name, m.role FROM org_memberships m
        JOIN orgs o ON o.org_id = m.org_id
        WHERE m.token_identifier = ? AND o.deleted_at IS NULL
      `).all(who.token_identifier) as unknown[]
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
      const org = db.prepare(`SELECT org_id, owner_token_identifier FROM orgs WHERE org_id = ? AND deleted_at IS NULL`)
        .get(args.orgId) as { org_id: string; owner_token_identifier: string } | undefined
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
      const org = db.prepare(`SELECT org_id, kind FROM orgs WHERE org_id = ? AND deleted_at IS NULL`)
        .get(args.orgId) as { org_id: string; kind: string } | undefined
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
      const org = db.prepare(`SELECT org_id, kind, name, owner_token_identifier FROM orgs WHERE org_id = ? AND deleted_at IS NULL`)
        .get(args.orgId) as { org_id: string; kind: string; name: string; owner_token_identifier: string } | undefined
      if (!org) throw new Error("Organization not found")
      if (org.kind === "personal") return { skipped: true as const }
      const membership = db.prepare(`
        SELECT 1 FROM org_memberships WHERE org_id = ? AND token_identifier = ?
      `).get(args.orgId, who.token_identifier)
      if (!membership && org.owner_token_identifier !== who.token_identifier) throw new Error("org_membership_required")
      const now = Date.now()
      return db.transaction(() => {
        let defaultTeam = db.prepare(`
          SELECT team_id FROM teams WHERE org_id = ? AND is_default = 1 AND deleted_at IS NULL
        `).get(args.orgId) as { team_id: string } | undefined
        if (!defaultTeam) {
          const teamId = `team_${randomToken()}`
          db.prepare(`
            INSERT INTO teams (team_id, org_id, name, is_default, created_by_token_identifier, created_at, updated_at)
            VALUES (?, ?, ?, 1, ?, ?, ?)
          `).run(teamId, args.orgId, org.name || "Everyone", who.token_identifier, now, now)
          defaultTeam = { team_id: teamId }
        }
        const orgMembers = db.prepare(`
          SELECT token_identifier, role FROM org_memberships WHERE org_id = ?
        `).all(args.orgId) as Array<{ token_identifier: string; role: string }>
        for (const member of orgMembers) {
          const existing = db.prepare(`
            SELECT 1 FROM team_memberships WHERE team_id = ? AND user_token_identifier = ?
          `).get(defaultTeam!.team_id, member.token_identifier)
          if (existing) continue
          const role = member.role === "owner" || member.role === "admin" ? member.role : "member"
          db.prepare(`
            INSERT INTO team_memberships (team_id, user_token_identifier, role, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
          `).run(defaultTeam!.team_id, member.token_identifier, role, now, now)
        }
        const projects = db.prepare(`
          SELECT project_id FROM projects WHERE org_id = ? AND deleted_at IS NULL
        `).all(args.orgId) as Array<{ project_id: string }>
        for (const project of projects) {
          const grant = db.prepare(`
            SELECT revoked_at FROM team_project_grants WHERE team_id = ? AND project_id = ?
          `).get(defaultTeam!.team_id, project.project_id) as { revoked_at: number | null } | undefined
          if (grant) continue
          db.prepare(`
            INSERT INTO team_project_grants (
              team_id, project_id, role, created_by_token_identifier, created_at
            ) VALUES (?, ?, 'editor', ?, ?)
          `).run(defaultTeam!.team_id, project.project_id, who.token_identifier, now)
        }

        // D18: retarget interim org-scoped shares onto the default team.
        const teamTargetKey = `team:${defaultTeam!.team_id}`
        let workspaceSharesRetargeted = 0
        const orgWorkspaceShares = db.prepare(`
          SELECT grant_id, workspace_id FROM workspace_share_grants
          WHERE granted_to_org_id = ? AND revoked_at IS NULL
        `).all(args.orgId) as Array<{ grant_id: string; workspace_id: string }>
        for (const share of orgWorkspaceShares) {
          const existingTeam = db.prepare(`
            SELECT grant_id FROM workspace_share_grants
            WHERE workspace_id = ? AND granted_to_team_id = ? AND revoked_at IS NULL
          `).get(share.workspace_id, defaultTeam!.team_id) as { grant_id: string } | undefined
          if (existingTeam) {
            db.prepare(`UPDATE workspace_share_grants SET revoked_at = ? WHERE grant_id = ?`)
              .run(now, share.grant_id)
            continue
          }
          db.prepare(`
            UPDATE workspace_share_grants
            SET granted_to_org_id = NULL, granted_to_team_id = ?, target_key = ?
            WHERE grant_id = ?
          `).run(defaultTeam!.team_id, teamTargetKey, share.grant_id)
          workspaceSharesRetargeted += 1
        }

        let sessionSharesRetargeted = 0
        const orgSessionShares = db.prepare(`
          SELECT grant_id, session_id FROM session_share_grants
          WHERE granted_to_org_id = ? AND revoked_at IS NULL
        `).all(args.orgId) as Array<{ grant_id: string; session_id: string }>
        for (const share of orgSessionShares) {
          const existingTeam = db.prepare(`
            SELECT grant_id FROM session_share_grants
            WHERE session_id = ? AND granted_to_team_id = ? AND revoked_at IS NULL
          `).get(share.session_id, defaultTeam!.team_id) as { grant_id: string } | undefined
          if (existingTeam) {
            db.prepare(`UPDATE session_share_grants SET revoked_at = ? WHERE grant_id = ?`)
              .run(now, share.grant_id)
            continue
          }
          db.prepare(`
            UPDATE session_share_grants
            SET granted_to_org_id = NULL, granted_to_team_id = ?
            WHERE grant_id = ?
          `).run(defaultTeam!.team_id, share.grant_id)
          sessionSharesRetargeted += 1
        }

        return {
          team_id: defaultTeam!.team_id,
          org_id: args.orgId,
          workspace_shares_retargeted: workspaceSharesRetargeted,
          session_shares_retargeted: sessionSharesRetargeted,
        }
      })()
    },
    async addTeamMember(auth: SignedControlPlaneAuth, args: {
      teamId: string
      tokenIdentifier?: string
      clerkSubject?: string
      userPublicId?: string
      role?: "member" | "admin" | "owner"
    }) {
      const db = database()
      const who = user(auth)
      const team = db.prepare(`SELECT team_id, org_id FROM teams WHERE team_id = ? AND deleted_at IS NULL`)
        .get(args.teamId) as { team_id: string; org_id: string } | undefined
      if (!team) throw new Error("Team not found")
      if (!orgAdminForUser(db, who, team.org_id)) throw new Error("org_admin_required")
      const target = args.tokenIdentifier
        ? db.prepare(`SELECT token_identifier FROM users WHERE token_identifier = ?`).get(args.tokenIdentifier) as AuthorityUser | undefined
        : args.clerkSubject
          ? userBySubject(db, args.clerkSubject)
          : args.userPublicId
            ? db.prepare(`SELECT token_identifier FROM users WHERE public_id = ?`).get(args.userPublicId) as AuthorityUser | undefined
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
      clerkSubject?: string
      userPublicId?: string
    }) {
      const db = database()
      const who = user(auth)
      const team = db.prepare(`SELECT team_id, org_id FROM teams WHERE team_id = ? AND deleted_at IS NULL`)
        .get(args.teamId) as { team_id: string; org_id: string } | undefined
      if (!team) throw new Error("Team not found")
      if (!orgAdminForUser(db, who, team.org_id)) throw new Error("org_admin_required")
      const target = args.tokenIdentifier
        ? db.prepare(`SELECT token_identifier FROM users WHERE token_identifier = ?`).get(args.tokenIdentifier) as AuthorityUser | undefined
        : args.clerkSubject
          ? userBySubject(db, args.clerkSubject)
          : args.userPublicId
            ? db.prepare(`SELECT token_identifier FROM users WHERE public_id = ?`).get(args.userPublicId) as AuthorityUser | undefined
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
      const team = db.prepare(`SELECT team_id, org_id FROM teams WHERE team_id = ? AND deleted_at IS NULL`)
        .get(args.teamId) as { team_id: string; org_id: string } | undefined
      if (!team) return []
      const membership = db.prepare(`
        SELECT 1 FROM org_memberships WHERE org_id = ? AND token_identifier = ?
      `).get(team.org_id, who.token_identifier)
      if (!membership && !orgAdminForUser(db, who, team.org_id)) return []
      return db.prepare(`
        SELECT m.user_token_identifier AS user_id, u.public_id, u.name AS display_name,
          m.user_token_identifier AS token_identifier, u.subject AS clerk_subject, m.role
        FROM team_memberships m
        LEFT JOIN users u ON u.token_identifier = m.user_token_identifier
        WHERE m.team_id = ?
        ORDER BY m.role DESC, m.user_token_identifier ASC
      `).all(args.teamId) as unknown[]
    },
    async grantTeamProject(auth: SignedControlPlaneAuth, args: {
      teamId: string
      projectId: string
      role: "viewer" | "editor" | "admin"
    }) {
      const db = database()
      const who = user(auth)
      const team = db.prepare(`SELECT team_id, org_id FROM teams WHERE team_id = ? AND deleted_at IS NULL`)
        .get(args.teamId) as { team_id: string; org_id: string } | undefined
      if (!team) throw new Error("Team not found")
      if (!orgAdminForUser(db, who, team.org_id)) throw new Error("org_admin_required")
      const project = projectByPublicId(db, args.projectId)
      if (!project || project.org_id !== team.org_id) throw new Error("Project not found")
      const now = Date.now()
      const existing = db.prepare(`
        SELECT revoked_at FROM team_project_grants WHERE team_id = ? AND project_id = ?
      `).get(args.teamId, args.projectId) as { revoked_at: number | null } | undefined
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
      const team = db.prepare(`SELECT team_id, org_id FROM teams WHERE team_id = ? AND deleted_at IS NULL`)
        .get(args.teamId) as { team_id: string; org_id: string } | undefined
      if (!team) throw new Error("Team not found")
      if (!orgAdminForUser(db, who, team.org_id)) throw new Error("org_admin_required")
      const result = db.prepare(`
        UPDATE team_project_grants SET revoked_at = ?
        WHERE team_id = ? AND project_id = ? AND revoked_at IS NULL
      `).run(Date.now(), args.teamId, args.projectId)
      return { revoked: result.changes > 0 }
    },
    async resolveOrgId(auth: SignedControlPlaneAuth) {
      const db = database()
      const who = user(auth)
      if (auth.user.orgId) {
        const org = db.prepare(`
          SELECT o.org_id FROM orgs o
          JOIN org_memberships m ON m.org_id = o.org_id AND m.token_identifier = ?
          WHERE o.clerk_org_id = ? AND o.deleted_at IS NULL
        `).get(who.token_identifier, auth.user.orgId) as { org_id: string } | undefined
        if (org) return org.org_id as OrgId
      }
      return ensurePersonalOrg(db, who) as OrgId
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
      const existing = db.prepare(`
        SELECT binding_id, token_identifier FROM channel_identities
        WHERE channel = ? AND external_user_id = ? AND revoked_at IS NULL
      `).get(channel, externalUserId) as { binding_id: string; token_identifier: string } | undefined
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
      const latest = db.prepare(`
        SELECT token_identifier FROM channel_identities
        WHERE channel = ? AND external_user_id = ?
        ORDER BY created_at DESC, rowid DESC LIMIT 1
      `).get(channel, externalUserId) as { token_identifier: string } | undefined
      return { revoked: latest?.token_identifier === who.token_identifier }
    },

    // --- workspaces (convex/workspaces.ts, convex/workspaceShares.ts) ------
    async authorizeWorkspaceCreate(auth: SignedControlPlaneAuth, args) {
      if (!args.orgId) return
      const db = database()
      const who = user(auth)
      const membership = db.prepare(`
        SELECT m.role FROM org_memberships m
        JOIN orgs o ON o.org_id = m.org_id
        WHERE m.org_id = ? AND m.token_identifier = ? AND o.deleted_at IS NULL
      `).get(args.orgId, who.token_identifier) as { role: string } | undefined
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
      const rows = db.prepare(`SELECT * FROM workspaces WHERE deleted_at IS NULL`).all() as WorkspaceRow[]
      return rows
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
    },
    async registerLocalForSharing(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      const requestedHomeRegion = validatedHomeRegion(args.homeRegion)
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
            args.repoUrl ?? existing.repo_url ?? args.remoteDirectory ?? existing.remote_directory,
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
          args.remoteDirectory ?? null,
          now,
          args.workspaceId,
        )
        return { workspace_doc_id: args.workspaceId, workspace_id: args.workspaceId, home_region }
      }
      const { orgId, projectId } = ownedProject(db, who, args)
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
        args.remoteDirectory ?? null,
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
        const active = target.activeKeys.flatMap((targetKey) => db.prepare(`
            SELECT grant_id, role FROM workspace_share_grants
            WHERE workspace_id = ? AND target_key = ? AND revoked_at IS NULL
          `).all(args.workspaceId, targetKey) as Array<{ grant_id: string; role: string }>)
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
                ? (db.prepare(`SELECT user_token_identifier FROM team_memberships WHERE team_id = ?`)
                  .all(target.teamId) as Array<{ user_token_identifier: string }>)
                  .map((item) => item.user_token_identifier)
                : (db.prepare(`SELECT token_identifier FROM org_memberships WHERE org_id = ?`)
                  .all(target.orgId) as Array<{ token_identifier: string }>)
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
      const grants = (args.grantId
        ? db.prepare(`SELECT * FROM workspace_share_grants WHERE workspace_id = ? AND grant_id = ? AND revoked_at IS NULL`)
          .all(args.workspaceId, args.grantId)
        : target!.activeKeys.flatMap((targetKey) => db.prepare(`
            SELECT * FROM workspace_share_grants
            WHERE workspace_id = ? AND target_key = ? AND revoked_at IS NULL
          `).all(args.workspaceId, targetKey))) as Array<{
          grant_id: string
          granted_to_token_identifier: string | null
          granted_to_subject: string | null
          granted_to_org_id: string | null
          granted_to_team_id: string | null
          revoked_at: number | null
        }>
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
            for (const membership of db.prepare(`SELECT token_identifier FROM org_memberships WHERE org_id = ?`)
              .all(grant.granted_to_org_id) as Array<{ token_identifier: string }>) {
              tokenIdentifiers.add(membership.token_identifier)
            }
          }
          if (grant.granted_to_team_id) {
            for (const membership of db.prepare(`SELECT user_token_identifier FROM team_memberships WHERE team_id = ?`)
              .all(grant.granted_to_team_id) as Array<{ user_token_identifier: string }>) {
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
      // `convex/crons.ts`, so a sweep has to ride a write or it never runs. The
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
      const request = db.prepare(`SELECT * FROM host_enrollment_requests WHERE request_id = ?`)
        .get(args.requestId) as HostEnrollmentRequestRow | undefined
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
        const row = db.prepare(`SELECT * FROM host_enrollments WHERE owner_token_identifier = ? AND host_id = ?`)
          .get(who.token_identifier, args.hostId) as HostEnrollmentRow
        return toHostEnrollment(row)
      })()
    },
    async heartbeatHostEnrollment(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      const row = db.prepare(`SELECT * FROM host_enrollments WHERE owner_token_identifier = ? AND host_id = ?`)
        .get(who.token_identifier, args.hostId) as HostEnrollmentRow | undefined
      if (!row || row.revoked_at) throw new Error("Host enrollment not found")
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
      const now = Date.now()
      const expiresAt = now + ttl(args.ttlMs)
      db.prepare(`
        UPDATE host_enrollments SET
          last_seen_at = ?, expires_at = ?, updated_at = ?, acked_workspace_ids = ?, acked_at = ?
        WHERE owner_token_identifier = ? AND host_id = ?
      `).run(now, expiresAt, now, JSON.stringify(workspaceIds), now, who.token_identifier, args.hostId)
      // The owner's assignment view rides back on every ack so the machine can
      // reconcile its persisted set — without this, machine consent and owner
      // intent drift apart silently forever.
      const assigned = db.prepare(`
        SELECT workspace_id FROM host_workspace_assignments
        WHERE host_id = ? AND owner_token_identifier = ?
        ORDER BY workspace_id
      `).all(args.hostId, who.token_identifier) as Array<{ workspace_id: string }>
      return {
        expires_at: expiresAt,
        last_seen_at: now,
        assigned_workspace_ids: assigned.map((assignment) => assignment.workspace_id),
      }
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
      const row = db.prepare(`
        SELECT * FROM host_enrollments WHERE owner_token_identifier = ?
        ORDER BY last_seen_at DESC LIMIT 1
      `).get(who.token_identifier) as HostEnrollmentRow | undefined
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
      const revoked = db.prepare(`
        UPDATE host_enrollments SET revoked_at = ?, updated_at = ?
        WHERE owner_token_identifier = ? AND (? IS NULL OR host_id = ?) AND revoked_at IS NULL
      `).run(now, now, who.token_identifier, args.hostId ?? null, args.hostId ?? null).changes
      // A revoked key's host id never returns (a later enable enrolls a NEW
      // id), so its assignments could never become routable again — leaving
      // them would only accumulate dangling rows that a later re-share must
      // displace. The cascade keeps "revoke = nothing routable" exactly true.
      db.prepare(`
        DELETE FROM host_workspace_assignments
        WHERE owner_token_identifier = ? AND (? IS NULL OR host_id = ?)
      `).run(who.token_identifier, args.hostId ?? null, args.hostId ?? null)
      const runtimeTokensRevoked = db.prepare(`
        UPDATE runtime_access_tokens SET revoked_at = ?
        WHERE actor_id = ? AND (? IS NULL OR host_id = ?) AND revoked_at IS NULL
      `).run(now, who.token_identifier, args.hostId ?? null, args.hostId ?? null).changes
      return { revoked, runtime_tokens_revoked: runtimeTokensRevoked }
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
        const enrollment = db.prepare(`SELECT * FROM host_enrollments WHERE owner_token_identifier = ? AND host_id = ?`)
          .get(who.token_identifier, args.hostId) as HostEnrollmentRow | undefined
        if (!enrollment || enrollment.revoked_at) throw new Error("Host enrollment not found")
        const existing = workspaceByPublicId(db, args.workspaceId)
        if (existing) {
          if (existing.deleted_at || !authorizeWorkspaceForUser(db, existing, who, "admin")) throw new Error("Workspace not found")
          refuseCloudWorkspace(existing)
        } else {
          const { orgId, projectId } = ownedProject(db, who, args)
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
            args.displayName ?? args.workspaceId,
            validatedHomeRegion(args.homeRegion) ?? null,
            args.repoUrl ?? null,
            args.repoName ?? null,
            args.gitBranch ?? null,
            args.remoteDirectory ?? null,
            now,
            now,
          )
        }
        db.prepare(`
          INSERT INTO host_workspace_assignments (
            workspace_id, host_id, owner_token_identifier, second_device_open_at, assigned_at, updated_at
          ) VALUES (?, ?, ?, NULL, ?, ?)
          ON CONFLICT (workspace_id) DO UPDATE SET
            host_id = excluded.host_id,
            owner_token_identifier = excluded.owner_token_identifier,
            updated_at = excluded.updated_at
        `).run(args.workspaceId, args.hostId, who.token_identifier, now, now)
        return { assigned: true as const, workspace_id: args.workspaceId, host_id: args.hostId }
      })()
    },
    async unassignWorkspaceHost(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      requireWorkspace(db, who, args.workspaceId, "admin")
      const result = db.prepare(`DELETE FROM host_workspace_assignments WHERE workspace_id = ?`)
        .run(args.workspaceId)
      return { unassigned: result.changes > 0 }
    },
    /** Routable host: owner-assigned AND machine-acked AND live lease. */
    async activeWorkspaceHost(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      requireWorkspace(db, who, args.workspaceId, "read")
      const row = db.prepare(`
        SELECT assignment.workspace_id, assignment.host_id, assignment.second_device_open_at,
          enrollment.display_name, enrollment.expires_at, enrollment.last_seen_at
        FROM host_workspace_assignments assignment
        JOIN host_enrollments enrollment ON enrollment.host_id = assignment.host_id
          AND enrollment.owner_token_identifier = assignment.owner_token_identifier
        WHERE assignment.workspace_id = ?
          AND enrollment.revoked_at IS NULL AND enrollment.paused_at IS NULL
          AND enrollment.expires_at > ?
          AND EXISTS (
            SELECT 1 FROM json_each(COALESCE(enrollment.acked_workspace_ids, '[]'))
            WHERE json_each.value = assignment.workspace_id
          )
        LIMIT 1
      `).get(args.workspaceId, Date.now()) as {
        workspace_id: string
        host_id: string
        second_device_open_at: number | null
        display_name: string | null
        expires_at: number
        last_seen_at: number
      } | undefined
      if (!row) return { active: false as const }
      return {
        active: true as const,
        host_id: row.host_id,
        workspace_id: row.workspace_id,
        ...(row.display_name ? { display_name: row.display_name } : {}),
        ...(row.second_device_open_at ? { second_device_open_at: row.second_device_open_at } : {}),
        expires_at: row.expires_at,
        last_seen_at: row.last_seen_at,
      }
    },
    /** Every live assignment on the account, grouped for the devices surface. */
    async listHostAssignments(auth: SignedControlPlaneAuth) {
      const db = database()
      const who = user(auth)
      const rows = db.prepare(`
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
      `).all(who.token_identifier, Date.now()) as Array<{
        workspace_id: string
        host_id: string
        display_name: string | null
        last_seen_at: number
        expires_at: number
        acked_workspace_ids: string
      }>
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
          acked_workspace_ids: JSON.parse(row.acked_workspace_ids) as string[],
        }
        group.workspace_ids.push(row.workspace_id)
        groups.set(row.host_id, group)
      }
      return [...groups.values()]
    },

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

    // --- sessions (convex/sessions.ts) --------------------------------------
    async grantSessionShare(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      const workspace = workspaceByPublicId(db, args.workspaceId)
      const session = db.prepare(`SELECT * FROM session_history WHERE session_id = ?`).get(args.sessionId) as SessionRow | undefined
      if (!workspace || !session || session.workspace_id !== args.workspaceId || session.deleted_at) denied()
      if (!authorizeWorkspaceForUser(db, workspace, who, "read")) denied()
      if (
        session.creator_actor_id !== who.token_identifier
        && !orgAdminForUser(db, who, workspace.org_id)
        && !teamAdminForProject(db, who, workspace)
      ) throw new Error("session_share_admin_required")
      const selectors = [
        args.grantedToTokenIdentifier,
        args.grantedToClerkSubject,
        args.grantedToUserId,
        args.grantedToClerkOrgId,
        args.grantedToOrgId,
        args.grantedToTeamId,
        args.grantedToTeamPublicId,
      ].filter(Boolean)
      if (selectors.length !== 1) throw new Error("session_share_target_required")
      const userTarget = args.grantedToTokenIdentifier
        ? db.prepare(`SELECT token_identifier FROM users WHERE token_identifier = ?`).get(args.grantedToTokenIdentifier) as AuthorityUser | undefined
        : args.grantedToClerkSubject
          ? userBySubject(db, args.grantedToClerkSubject)
          : args.grantedToUserId
            ? db.prepare(`SELECT token_identifier FROM users WHERE public_id = ? OR token_identifier = ?`)
              .get(args.grantedToUserId, args.grantedToUserId) as AuthorityUser | undefined
            : undefined
      const orgSelector = args.grantedToOrgId ?? args.grantedToClerkOrgId
      const org = orgSelector
        ? db.prepare(`
            SELECT org_id FROM orgs WHERE deleted_at IS NULL AND (org_id = ? OR clerk_org_id = ?) LIMIT 1
          `).get(orgSelector, orgSelector) as { org_id: string } | undefined
        : undefined
      const teamSelector = args.grantedToTeamId ?? args.grantedToTeamPublicId
      const team = teamSelector
        ? db.prepare(`SELECT team_id, org_id FROM teams WHERE team_id = ? AND deleted_at IS NULL`)
          .get(teamSelector) as { team_id: string; org_id: string } | undefined
        : undefined
      if (!userTarget && !org && !team) throw new Error("session_share_target_not_found")
      if (userTarget && !authorizeWorkspaceForUser(db, workspace, userTarget, "read")) {
        throw new Error("session_participant_workspace_access_required")
      }
      if (team && team.org_id !== workspace.org_id) throw new Error("session_share_team_org_mismatch")
      if (org && workspace.org_id && org.org_id !== workspace.org_id) throw new Error("session_share_org_mismatch")
      const now = Date.now()
      const existing = db.prepare(`
        SELECT grant_id, granted_to_user_token_identifier, granted_to_org_id, granted_to_team_id
        FROM session_share_grants WHERE session_id = ? AND revoked_at IS NULL
      `).all(args.sessionId) as Array<{
        grant_id: string
        granted_to_user_token_identifier: string | null
        granted_to_org_id: string | null
        granted_to_team_id: string | null
      }>
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
      const session = db.prepare(`SELECT * FROM session_history WHERE session_id = ?`).get(args.sessionId) as SessionRow | undefined
      if (!workspace || !session || session.workspace_id !== args.workspaceId || session.deleted_at) denied()
      if (!authorizeWorkspaceForUser(db, workspace, who, "read")) denied()
      if (
        session.creator_actor_id !== who.token_identifier
        && !orgAdminForUser(db, who, workspace.org_id)
        && !teamAdminForProject(db, who, workspace)
      ) throw new Error("session_share_admin_required")
      const now = Date.now()
      let grants: Array<{
        grant_id: string
        granted_to_user_token_identifier: string | null
        granted_to_org_id: string | null
        granted_to_team_id: string | null
      }>
      if (args.grantId) {
        grants = db.prepare(`
          SELECT grant_id, granted_to_user_token_identifier, granted_to_org_id, granted_to_team_id
          FROM session_share_grants
          WHERE session_id = ? AND grant_id = ? AND revoked_at IS NULL
        `).all(args.sessionId, args.grantId) as typeof grants
      } else {
        const selectors = [
          args.grantedToTokenIdentifier,
          args.grantedToClerkSubject,
          args.grantedToUserId,
          args.grantedToClerkOrgId,
          args.grantedToOrgId,
          args.grantedToTeamId,
          args.grantedToTeamPublicId,
        ].filter(Boolean)
        if (selectors.length !== 1) throw new Error("session_share_target_required")
        const userTarget = args.grantedToTokenIdentifier
          ? args.grantedToTokenIdentifier
          : args.grantedToClerkSubject
            ? userBySubject(db, args.grantedToClerkSubject)?.token_identifier
            : args.grantedToUserId
              ? (db.prepare(`SELECT token_identifier FROM users WHERE public_id = ? OR token_identifier = ?`)
                .get(args.grantedToUserId, args.grantedToUserId) as { token_identifier: string } | undefined)?.token_identifier
              : undefined
        const orgSelector = args.grantedToOrgId ?? args.grantedToClerkOrgId
        const orgId = orgSelector
          ? (db.prepare(`SELECT org_id FROM orgs WHERE deleted_at IS NULL AND (org_id = ? OR clerk_org_id = ?) LIMIT 1`)
            .get(orgSelector, orgSelector) as { org_id: string } | undefined)?.org_id
          : undefined
        const teamId = args.grantedToTeamId ?? args.grantedToTeamPublicId
        grants = db.prepare(`
          SELECT grant_id, granted_to_user_token_identifier, granted_to_org_id, granted_to_team_id
          FROM session_share_grants WHERE session_id = ? AND revoked_at IS NULL
        `).all(args.sessionId).filter((grant: any) => {
          if (userTarget) return grant.granted_to_user_token_identifier === userTarget
          if (teamId) return grant.granted_to_team_id === teamId
          if (orgId) return grant.granted_to_org_id === orgId
          return false
        }) as typeof grants
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
          for (const membership of db.prepare(`SELECT token_identifier FROM org_memberships WHERE org_id = ?`)
            .all(grant.granted_to_org_id) as Array<{ token_identifier: string }>) {
            tokenIdentifiers.add(membership.token_identifier)
          }
        }
        if (grant.granted_to_team_id) {
          for (const membership of db.prepare(`SELECT user_token_identifier FROM team_memberships WHERE team_id = ?`)
            .all(grant.granted_to_team_id) as Array<{ user_token_identifier: string }>) {
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
      const session = db.prepare(`SELECT * FROM session_history WHERE session_id = ?`).get(args.sessionId) as SessionRow | undefined
      if (!workspace || !session || session.workspace_id !== args.workspaceId || session.deleted_at) {
        throw new Error("Session not found")
      }
      const workspaceRole = authorizeWorkspaceForUser(db, workspace, who, "read")
      if (!workspaceRole) throw new Error("session_share_admin_required")
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
      const grants = db.prepare(`
        SELECT grant_id, session_id, workspace_id, granted_to_user_token_identifier AS granted_to_user_id,
          granted_to_org_id, granted_to_team_id, created_by_token_identifier AS created_by_user_id,
          created_at, revoked_at
        FROM session_share_grants
        WHERE session_id = ? AND revoked_at IS NULL
        ORDER BY created_at ASC
      `).all(args.sessionId) as Array<Record<string, unknown>>
      const participants = db.prepare(`
        SELECT participant_actor_id AS user_id, added_by_actor_id AS added_by_user_id, created_at
        FROM session_participants
        WHERE session_id = ? AND revoked_at IS NULL
        ORDER BY created_at ASC
      `).all(args.sessionId) as Array<Record<string, unknown>>
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
    // --- runtime tokens (convex/runtimeAccessTokens.ts) ---------------------
    async recordRuntimeAccessToken(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      if (who.token_identifier !== args.actorId || who.kind !== args.actorKind) denied()
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
    },
    async recordRuntimeAccessTokenForService(args) {
      const db = database()
      const workspace = workspaceByPublicId(db, args.workspaceId)
      const who = args.principalKind === "user"
        ? db.prepare(`SELECT token_identifier, subject, kind FROM users WHERE token_identifier = ?`)
            .get(args.actorId) as AuthorityUser | undefined
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
      const token = db.prepare(`SELECT * FROM runtime_access_tokens WHERE jti = ?`).get(args.jti) as {
        workspace_id: string
        host_id: string
        minted_for_token_identifier: string | null
        principal_kind: "user" | "service"
        actor_id: string
        actor_kind: "human" | "agent"
        role: "viewer" | "editor" | "admin" | "owner"
        expires_at: number
        revoked_at: number | null
      } | undefined
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
        ? db.prepare(`SELECT token_identifier, subject, kind FROM users WHERE token_identifier = ?`)
            .get(token.actor_id) as AuthorityUser | undefined
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

    // --- agent extensions (convex/agentExtensions.ts, ...Policies.ts) -------
    async listWorkspaceAgentExtensions(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      const workspace = workspaceByPublicId(db, args.workspaceId)
      if (!workspace || !authorizeWorkspaceForUser(db, workspace, who, "read")) return []
      return listAgentExtensions(db, args.workspaceId)
    },
    async listWorkspaceAgentExtensionsForRuntime(args) {
      // In-process trust boundary: the embedded runtime IS this server, so no
      // service token exists to check (the Convex variant gates on one).
      return listAgentExtensions(database(), args.workspaceId)
    },
    async authorizeWorkspaceAgentExtensionsAdmin(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      const workspace = workspaceByPublicId(db, args.workspaceId)
      if (!workspace || !authorizeWorkspaceForUser(db, workspace, who, "admin")) denied()
    },
    async upsertWorkspaceAgentExtension(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      requireWorkspace(db, who, args.workspaceId, "admin")
      const now = Date.now()
      // Only live rows guard the source: a soft-deleted row (uninstalled, or
      // absorbed into the pinned catalog id by the install route) must not
      // block a fresh install that legitimately reuses its id — the upsert
      // below revives the row under the new source.
      const existing = db.prepare(`SELECT desired FROM agent_extension_installs WHERE workspace_id = ? AND extension_id = ? AND deleted_at IS NULL`)
        .get(args.workspaceId, args.extensionId) as { desired: string } | undefined
      if (existing) {
        const existingSource = sourceKey(object(JSON.parse(existing.desired))?.source)
        const requestedSource = sourceKey(object(args.desired)?.source)
        if (existingSource && requestedSource && existingSource !== requestedSource) {
          throw new Error("Agent Extension is already installed from a different source")
        }
      }
      db.prepare(`
        INSERT INTO agent_extension_installs (workspace_id, extension_id, package_name, desired, lock, enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (workspace_id, extension_id) DO UPDATE SET
          package_name = excluded.package_name,
          desired = excluded.desired,
          lock = excluded.lock,
          enabled = excluded.enabled,
          updated_at = excluded.updated_at,
          deleted_at = NULL
      `).run(
        args.workspaceId,
        args.extensionId,
        args.packageName,
        jsonText(args.desired),
        jsonText(args.lock),
        object(args.desired)?.enabled ? 1 : 0,
        now,
        now,
      )
      return { extension_id: args.extensionId }
    },
    async setWorkspaceAgentExtensionEnabled(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      requireWorkspace(db, who, args.workspaceId, "admin")
      const existing = db.prepare(`
        SELECT desired, deleted_at FROM agent_extension_installs WHERE workspace_id = ? AND extension_id = ?
      `).get(args.workspaceId, args.extensionId) as { desired: string; deleted_at: number | null } | undefined
      if (!existing || existing.deleted_at) throw new Error("Agent Extension not found")
      const now = Date.now()
      const desired = { ...(object(JSON.parse(existing.desired)) ?? {}), enabled: args.enabled, updated_at: now }
      db.prepare(`
        UPDATE agent_extension_installs SET enabled = ?, desired = ?, updated_at = ?
        WHERE workspace_id = ? AND extension_id = ?
      `).run(args.enabled ? 1 : 0, jsonText(desired), now, args.workspaceId, args.extensionId)
      return { extension_id: args.extensionId, enabled: args.enabled }
    },
    async deleteWorkspaceAgentExtension(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      requireWorkspace(db, who, args.workspaceId, "admin")
      db.prepare(`
        UPDATE agent_extension_installs SET deleted_at = ?, updated_at = ?
        WHERE workspace_id = ? AND extension_id = ? AND deleted_at IS NULL
      `).run(Date.now(), Date.now(), args.workspaceId, args.extensionId)
      return { ok: true }
    },
    async listAgentExtensionPolicyOverrides(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      const workspace = workspaceByPublicId(db, args.workspaceId)
      if (!workspace || !authorizeWorkspaceForUser(db, workspace, who, "read")) return []
      return policyRows(db, { workspace, userKey: who.token_identifier })
    },
    async listAgentExtensionPolicyOverridesForRuntime(args) {
      const db = database()
      const workspace = workspaceByPublicId(db, args.workspaceId)
      if (!workspace) return []
      return policyRows(db, { workspace })
    },
    async setAgentExtensionPolicyOverride(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      const workspace = requireWorkspace(db, who, args.workspaceId, "admin")
      const scopeKey = policyScopeKey(db, who, workspace, args.scope)
      const now = Date.now()
      db.prepare(`
        INSERT INTO agent_extension_policy_overrides (scope, scope_key, extension_id, enabled, reason, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (scope, scope_key, extension_id) DO UPDATE SET
          enabled = excluded.enabled,
          reason = excluded.reason,
          updated_at = excluded.updated_at,
          deleted_at = NULL
      `).run(args.scope, scopeKey, args.extensionId, args.enabled ? 1 : 0, args.reason ?? null, now, now)
      return { extension_id: args.extensionId, scope: args.scope }
    },
    async deleteAgentExtensionPolicyOverride(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      const workspace = requireWorkspace(db, who, args.workspaceId, "admin")
      const scopeKey = policyScopeKey(db, who, workspace, args.scope)
      db.prepare(`
        UPDATE agent_extension_policy_overrides SET deleted_at = ?, updated_at = ?
        WHERE scope = ? AND scope_key = ? AND extension_id = ? AND deleted_at IS NULL
      `).run(Date.now(), Date.now(), args.scope, scopeKey, args.extensionId)
      return { ok: true }
    },

    // --- audit (convex/auditEvents.ts) ---------------------------------------
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
