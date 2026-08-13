import { ControlPlaneAuthError, type SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { AgentMessagePageError } from "@claxedo/agent-sdk-runtime/message-page"
import type { HostEnrollment, OrgId, ProjectAction, ProjectRoleResult, WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
import { randomToken } from "@claxedo/server-core/platform/auth/web-crypto"
import {
  authorizeProjectForUser,
  authorizeWorkspaceForUser,
  ensurePersonalOrg,
  ensureProject,
  openAuthorityDb,
  projectByPublicId,
  projectRoleForUser,
  sqliteRepoKey,
  upsertUser,
  userBySubject,
  workspaceByPublicId,
  workspaceRoleForUser,
  type AuthorityUser,
  type ProjectRow,
  type SqliteAuthorityDb,
  type SqliteWorkspaceAuthorityOptions,
  type WorkspaceAction,
  type WorkspaceRow,
} from "./workspace-authority-store"

// Claxedo's LOCAL workspace-authority adapter: the full `WorkspaceAuthority`
// port backed by a local SQLite database instead of Convex. This is the
// self-host enabler — a deployment with NO Convex/Clerk env composes this
// authority so `requireAuthority` never fails 503 and workspace/session
// features work out of the box. Per-method semantics mirror the Convex
// backend functions (convex/workspaces.ts, convex/localHostLinks.ts, ...).
// Node-only (better-sqlite3 via the store): hosted/Worker compositions must
// never import this module (worker.import-graph guard).

// Mirrors convex/localHostLinks.ts TTL policy.
const DEFAULT_TTL_MS = 60_000
const MAX_TTL_MS = 5 * 60_000
const CHALLENGE_TTL_MS = 60_000
const MESSAGE_PAGE_CURSOR_PREFIX = "sawmp1:"
const MAX_MESSAGE_PAGE_LIMIT = 500

function encodeMessagePageCursor(sessionId: string, ordinal: number) {
  return `${MESSAGE_PAGE_CURSOR_PREFIX}${Buffer.from(JSON.stringify({ sessionId, ordinal })).toString("base64url")}`
}

function decodeMessagePageCursor(sessionId: string, input: string) {
  try {
    if (!input.startsWith(MESSAGE_PAGE_CURSOR_PREFIX)) throw new Error("unexpected cursor version")
    const value = JSON.parse(Buffer.from(input.slice(MESSAGE_PAGE_CURSOR_PREFIX.length), "base64url").toString("utf8")) as {
      sessionId?: unknown
      ordinal?: unknown
    }
    if (
      value.sessionId !== sessionId
      || typeof value.ordinal !== "number"
      || !Number.isSafeInteger(value.ordinal)
      || value.ordinal < 0
    ) throw new Error("invalid cursor payload")
    return value.ordinal
  } catch {
    throw new AgentMessagePageError(400, "Invalid message page cursor")
  }
}

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

function ttl(input?: number) {
  if (!input || !Number.isFinite(input)) return DEFAULT_TTL_MS
  return Math.max(5_000, Math.min(input, MAX_TTL_MS))
}

function base64url(bytes: Uint8Array) {
  return Buffer.from(bytes).toString("base64url")
}

function registrationPayload(input: {
  workspace_id: string
  host_id: string
  challenge_id: string
  nonce: string
}) {
  return [
    "claxedo.local-host-link.register.v1",
    `workspace_id=${input.workspace_id}`,
    `host_id=${input.host_id}`,
    `challenge_id=${input.challenge_id}`,
    `nonce=${input.nonce}`,
  ].join("\n")
}

function enrollmentPayload(input: { host_id: string; request_id: string; nonce: string }) {
  // A distinct v1 prefix from the local-host-link payloads above. Payload
  // domains must not overlap: a signature captured from one flow being
  // replayable in the other is exactly what a prefix prevents.
  return [
    "claxedo.host-enrollment.enroll.v1",
    `host_id=${input.host_id}`,
    `request_id=${input.request_id}`,
    `nonce=${input.nonce}`,
  ].join("\n")
}

function heartbeatEnrollmentPayload(input: { host_id: string; ttl_ms?: number }) {
  return [
    "claxedo.host-enrollment.heartbeat.v1",
    `host_id=${input.host_id}`,
    `ttl_ms=${input.ttl_ms ?? ""}`,
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

function heartbeatPayload(input: {
  workspace_id: string
  host_id: string
  ttl_ms?: number
}) {
  return [
    "claxedo.local-host-link.heartbeat.v1",
    `workspace_id=${input.workspace_id}`,
    `host_id=${input.host_id}`,
    `ttl_ms=${input.ttl_ms ?? ""}`,
  ].join("\n")
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

function jsonText(input: unknown) {
  try {
    return JSON.stringify(input) ?? "null"
  } catch {
    return "null"
  }
}

function messageWithPublicAuthor(input: unknown, user?: {
  public_id: string | null
  name: string | null
  image_url: string | null
  kind: string | null
}) {
  const row = object(input)
  const info = object(row?.info)
  if (!row || !info || info.role !== "user" || !user?.public_id) return input
  return {
    ...row,
    info: {
      ...info,
      claxedo: {
        author: {
          id: user.public_id,
          name: user.name ?? (user.kind === "agent" ? "Agent" : "User"),
          kind: user.kind === "agent" ? "agent" : "human",
          ...(user.image_url ? { avatarUrl: user.image_url } : {}),
        },
      },
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

type HostLinkRow = {
  workspace_id: string
  host_id: string
  public_key: string
  display_name: string | null
  second_device_open_at: number | null
  last_seen_at: number
  expires_at: number
  paused_at: number | null
  revoked_at: number | null
}

type SessionVisibility = {
  sessionId: string
  title?: string
  createdAt?: number
  updatedAt?: number
}

export function createSqliteWorkspaceAuthority(
  options: SqliteWorkspaceAuthorityOptions = {},
): WorkspaceAuthority & { close(): void } {
  const database = openAuthorityDb(options)

  const user = (auth: SignedControlPlaneAuth): AuthorityUser => {
    const db = database()
    return upsertUser(db, {
      token_identifier: auth.user.tokenIdentifier,
      subject: auth.user.subject,
      issuer: auth.user.issuer,
      kind: auth.tokenKind === "cli" ? "agent" : "human",
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
        WHERE workspace_id = ? AND minted_for_token_identifier = ? AND revoked_at IS NULL
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
    created_by_token_identifier: string
    deleted_at: number | null
  }

  const sessionRole = (
    db: SqliteAuthorityDb,
    workspace: WorkspaceRow,
    session: SessionRow,
    who: AuthorityUser,
    action: WorkspaceAction,
  ) => {
    const role = authorizeWorkspaceForUser(db, workspace, who, action)
    if (!role) return
    if (session.created_by_token_identifier === who.token_identifier) return role
    const participant = db.prepare(`
      SELECT revoked_at FROM session_participants WHERE session_id = ? AND actor_token_identifier = ?
    `).get(session.session_id, who.token_identifier) as { revoked_at: number | null } | undefined
    if (participant && !participant.revoked_at) return role
    if (!workspace.org_id) return
    const membership = db.prepare(`
      SELECT role FROM org_memberships WHERE org_id = ? AND token_identifier = ?
    `).get(workspace.org_id, who.token_identifier) as { role: string } | undefined
    if (membership?.role === "admin" || membership?.role === "owner") return role
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

  const upsertVisibilityRows = (db: SqliteAuthorityDb, input: {
    who: AuthorityUser
    workspace: WorkspaceRow
    sessions: SessionVisibility[]
  }) => {
    for (const session of input.sessions) {
      const now = Date.now()
      const existing = db.prepare(`SELECT * FROM session_history WHERE session_id = ?`)
        .get(session.sessionId) as SessionRow | undefined
      if (existing && existing.workspace_id !== input.workspace.workspace_id) throw new Error("Session not found")
      if (existing && !sessionRole(db, input.workspace, existing, input.who, "write")) denied()
      if (existing) {
        db.prepare(`
          UPDATE session_history SET title = ?, updated_at = ?, deleted_at = NULL WHERE session_id = ?
        `).run(session.title ?? null, session.updatedAt ?? now, session.sessionId)
        continue
      }
      db.prepare(`
        INSERT INTO session_history (session_id, workspace_id, created_by_token_identifier, title, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        session.sessionId,
        input.workspace.workspace_id,
        input.who.token_identifier,
        session.title ?? null,
        session.createdAt ?? now,
        session.updatedAt ?? now,
      )
      db.prepare(`
        INSERT INTO session_participants (
          session_id, workspace_id, actor_token_identifier, added_by_token_identifier, created_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (session_id, actor_token_identifier) DO NOTHING
      `).run(
        session.sessionId,
        input.workspace.workspace_id,
        input.who.token_identifier,
        input.who.token_identifier,
        now,
      )
    }
  }

  const deleteMessageRows = (db: SqliteAuthorityDb, sessionId: string, workspaceId: string) => {
    db.prepare(`DELETE FROM session_messages WHERE session_id = ? AND workspace_id = ?`).run(sessionId, workspaceId)
  }

  return {
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
        actor_kind: auth.tokenKind === "cli" ? "agent" as const : "human" as const,
        actor_public_id: who.public_id,
        actor_name: who.name ?? (auth.tokenKind === "cli" ? "Agent" : "User"),
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
      if (!args.grantedToTokenIdentifier && !args.grantedToClerkSubject && !args.grantedToClerkOrgId) {
        throw new Error("Share target not found")
      }
      const grantId = `grant_${randomToken()}`
      db.prepare(`
        INSERT INTO workspace_share_grants (
          grant_id, workspace_id, granted_to_token_identifier, granted_to_subject, granted_to_org_id,
          role, created_by_token_identifier, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        grantId,
        args.workspaceId,
        args.grantedToTokenIdentifier ?? null,
        args.grantedToClerkSubject ?? null,
        args.grantedToClerkOrgId ?? null,
        args.role,
        who.token_identifier,
        Date.now(),
      )
      return grantId
    },
    async revokeWorkspaceShare(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      requireWorkspace(db, who, args.workspaceId, "admin")
      const grants = db.prepare(`SELECT * FROM workspace_share_grants WHERE workspace_id = ?`)
        .all(args.workspaceId) as Array<{
          grant_id: string
          granted_to_token_identifier: string | null
          granted_to_subject: string | null
          granted_to_org_id: string | null
          revoked_at: number | null
        }>
      const grant = grants.find((item) => {
        if (args.grantId) return item.grant_id === args.grantId
        if (args.grantedToTokenIdentifier) return item.granted_to_token_identifier === args.grantedToTokenIdentifier
        if (args.grantedToClerkSubject) return item.granted_to_subject === args.grantedToClerkSubject
        if (args.grantedToClerkOrgId) return item.granted_to_org_id === args.grantedToClerkOrgId
        return false
      })
      if (!grant || grant.revoked_at) return { revoked: false }
      db.prepare(`UPDATE workspace_share_grants SET revoked_at = ? WHERE grant_id = ?`).run(Date.now(), grant.grant_id)
      const tokenIdentifiers = grant.granted_to_token_identifier
        ? [grant.granted_to_token_identifier]
        : grant.granted_to_subject
          ? [userBySubject(db, grant.granted_to_subject)?.token_identifier].filter((item): item is string => !!item)
          : grant.granted_to_org_id
            ? (db.prepare(`SELECT token_identifier FROM org_memberships WHERE org_id = ?`)
              .all(grant.granted_to_org_id) as Array<{ token_identifier: string }>)
              .map((item) => item.token_identifier)
            : []
      return {
        revoked: true,
        runtime_tokens_revoked: revokeRuntimeTokensForUsers(db, args.workspaceId, tokenIdentifiers),
      }
    },

    // --- machine-wide enrollment (Unit 6) -----------------------------------
    //
    // The local-host-link methods below do the same four things per WORKSPACE.
    // These do them per MACHINE, and every difference between the two blocks is
    // the removal of workspace handling: no ownership check against a workspace
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
      await verifyHostSignature({
        public_key: row.public_key,
        payload: heartbeatEnrollmentPayload({ host_id: args.hostId, ttl_ms: args.ttlMs }),
        signature: args.signature,
      })
      const now = Date.now()
      const expiresAt = now + ttl(args.ttlMs)
      db.prepare(`
        UPDATE host_enrollments SET last_seen_at = ?, expires_at = ?, updated_at = ?
        WHERE owner_token_identifier = ? AND host_id = ?
      `).run(now, expiresAt, now, who.token_identifier, args.hostId)
      return { expires_at: expiresAt, last_seen_at: now }
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

    // --- local host links (convex/localHostLinks.ts) ------------------------
    async createLocalHostLinkChallenge(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      const workspace = workspaceByPublicId(db, args.workspaceId)
      // A never-registered workspaceId may take a challenge; ownership is
      // established at register (after host proof). When the row EXISTS, the
      // admin/backing checks apply.
      if (workspace) {
        if (!authorizeWorkspaceForUser(db, workspace, who, "admin")) throw new Error("Workspace not found")
        refuseCloudWorkspace(workspace)
      }
      const now = Date.now()
      const nonce = base64url(crypto.getRandomValues(new Uint8Array(32)))
      const challengeId = base64url(crypto.getRandomValues(new Uint8Array(16)))
      db.prepare(`
        INSERT INTO host_attestation_challenges (challenge_id, workspace_id, owner_token_identifier, host_id, nonce, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(challengeId, args.workspaceId, who.token_identifier, args.hostId, nonce, now + CHALLENGE_TTL_MS, now)
      return { challenge_id: challengeId, nonce, expires_at: now + CHALLENGE_TTL_MS }
    },
    async registerLocalHostLink(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      const existingWorkspace = workspaceByPublicId(db, args.workspaceId)
      if (existingWorkspace) {
        if (!authorizeWorkspaceForUser(db, existingWorkspace, who, "admin")) throw new Error("Workspace not found")
        refuseCloudWorkspace(existingWorkspace)
      }
      const now = Date.now()
      const challenge = db.prepare(`SELECT * FROM host_attestation_challenges WHERE challenge_id = ?`)
        .get(args.challengeId) as {
          workspace_id: string
          owner_token_identifier: string
          host_id: string
          nonce: string
          expires_at: number
          used_at: number | null
        } | undefined
      if (
        !challenge
        || challenge.workspace_id !== args.workspaceId
        || challenge.owner_token_identifier !== who.token_identifier
        || challenge.host_id !== args.hostId
        || challenge.used_at
        || challenge.expires_at <= now
      ) {
        throw new Error("Invalid host attestation challenge")
      }
      await verifyHostSignature({
        public_key: args.publicKey,
        payload: registrationPayload({
          workspace_id: args.workspaceId,
          host_id: args.hostId,
          challenge_id: args.challengeId,
          nonce: challenge.nonce,
        }),
        signature: args.signature,
      })
      return db.transaction(() => {
        const claimedAt = Date.now()
        const claimed = db.prepare(`
          UPDATE host_attestation_challenges SET used_at = ?
          WHERE challenge_id = ? AND used_at IS NULL AND expires_at > ?
        `).run(claimedAt, args.challengeId, claimedAt)
        if (claimed.changes !== 1) throw new Error("Invalid host attestation challenge")

        const currentWorkspace = workspaceByPublicId(db, args.workspaceId)
        if (currentWorkspace) {
          if (!authorizeWorkspaceForUser(db, currentWorkspace, who, "admin")) throw new Error("Workspace not found")
          refuseCloudWorkspace(currentWorkspace)
        } else {
          const { orgId, projectId } = ownedProject(db, who, { workspaceId: args.workspaceId })
          db.prepare(`
            INSERT INTO workspaces (
              workspace_id, org_id, project_id, owner_token_identifier, backing, access, display_name, created_at, updated_at
            ) VALUES (?, ?, ?, ?, 'local-worktree', 'user-hosted', ?, ?, ?)
          `).run(
            args.workspaceId,
            orgId,
            projectId,
            who.token_identifier,
            args.displayName ?? args.workspaceId,
            claimedAt,
            claimedAt,
          )
        }
        const workspace = currentWorkspace ?? workspaceByPublicId(db, args.workspaceId)!
        const expiresAt = claimedAt + ttl(args.ttlMs)
        db.prepare(`
          INSERT INTO local_host_links (
            workspace_id, host_id, owner_token_identifier, public_key, display_name,
            last_seen_at, expires_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (workspace_id, host_id) DO UPDATE SET
            public_key = excluded.public_key,
            display_name = excluded.display_name,
            last_seen_at = excluded.last_seen_at,
            expires_at = excluded.expires_at,
            paused_at = NULL,
            paused_by = NULL,
            paused_reason = NULL,
            revoked_at = NULL,
            updated_at = excluded.updated_at
        `).run(
          args.workspaceId,
          args.hostId,
          who.token_identifier,
          args.publicKey,
          args.displayName ?? null,
          claimedAt,
          expiresAt,
          claimedAt,
          claimedAt,
        )
        return {
          host_id: args.hostId,
          workspace_id: args.workspaceId,
          home_region: workspace.home_region ?? undefined,
          expires_at: expiresAt,
          paused: false,
        }
      })()
    },
    async heartbeatLocalHostLink(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      const workspace = requireWorkspace(db, who, args.workspaceId, "admin")
      const link = db.prepare(`SELECT * FROM local_host_links WHERE workspace_id = ? AND host_id = ?`)
        .get(args.workspaceId, args.hostId) as HostLinkRow | undefined
      if (!link || link.revoked_at) throw new Error("Local Host Link not found")
      if (!link.public_key) throw new Error("Host attestation required")
      await verifyHostSignature({
        public_key: link.public_key,
        payload: heartbeatPayload({
          workspace_id: args.workspaceId,
          host_id: args.hostId,
          ttl_ms: args.ttlMs,
        }),
        signature: args.signature,
      })
      const now = Date.now()
      const expiresAt = now + ttl(args.ttlMs)
      db.prepare(`
        UPDATE local_host_links SET last_seen_at = ?, expires_at = ?, updated_at = ?
        WHERE workspace_id = ? AND host_id = ?
      `).run(now, expiresAt, now, args.workspaceId, args.hostId)
      return {
        host_id: args.hostId,
        workspace_id: args.workspaceId,
        home_region: workspace.home_region ?? undefined,
        expires_at: expiresAt,
        paused: !!link.paused_at,
      }
    },
    async pauseLocalHostLink(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      requireWorkspace(db, who, args.workspaceId, "admin")
      const now = Date.now()
      const result = args.hostId
        ? db.prepare(`
            UPDATE local_host_links SET paused_at = ?, paused_by = ?, paused_reason = ?, updated_at = ?
            WHERE workspace_id = ? AND host_id = ?
          `).run(args.paused ? now : null, args.paused ? "user" : null, args.paused ? "user_paused" : null, now, args.workspaceId, args.hostId)
        : db.prepare(`
            UPDATE local_host_links SET paused_at = ?, paused_by = ?, paused_reason = ?, updated_at = ?
            WHERE workspace_id = ?
          `).run(args.paused ? now : null, args.paused ? "user" : null, args.paused ? "user_paused" : null, now, args.workspaceId)
      return {
        workspace_id: args.workspaceId,
        paused: args.paused,
        count: result.changes,
      }
    },
    async activeLocalHostLink(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      const workspace = workspaceByPublicId(db, args.workspaceId)
      if (!workspace || !authorizeWorkspaceForUser(db, workspace, who, "read")) return { active: false as const }
      const link = db.prepare(`
        SELECT * FROM local_host_links
        WHERE workspace_id = ? AND revoked_at IS NULL AND paused_at IS NULL AND expires_at > ?
        ORDER BY last_seen_at DESC LIMIT 1
      `).get(args.workspaceId, Date.now()) as HostLinkRow | undefined
      if (!link) return { active: false as const }
      return {
        active: true as const,
        host_id: link.host_id,
        workspace_id: args.workspaceId,
        ...(link.display_name ? { display_name: link.display_name } : {}),
        ...(link.second_device_open_at ? { second_device_open_at: link.second_device_open_at } : {}),
        expires_at: link.expires_at,
        last_seen_at: link.last_seen_at,
      }
    },
    async markSecondDeviceOpen(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      const workspace = workspaceByPublicId(db, args.workspaceId)
      if (!workspace || !authorizeWorkspaceForUser(db, workspace, who, "read")) denied()
      const now = Date.now()
      const result = db.prepare(`
        UPDATE local_host_links SET second_device_open_at = COALESCE(second_device_open_at, ?), updated_at = ?
        WHERE workspace_id = ? AND owner_token_identifier = ? AND revoked_at IS NULL
      `).run(now, now, args.workspaceId, who.token_identifier)
      return { recorded: result.changes > 0, second_device_open_at: now }
    },

    // --- sessions (convex/sessions.ts) --------------------------------------
    async authorizeSessionRead(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      const workspace = workspaceByPublicId(db, args.workspaceId)
      if (!workspace) denied()
      const session = db.prepare(`SELECT * FROM session_history WHERE session_id = ?`).get(args.sessionId) as SessionRow | undefined
      if (!session || session.workspace_id !== args.workspaceId || session.deleted_at) denied()
      if (!sessionRole(db, workspace, session, who, "read")) denied()
    },
    async authorizeSessionWrite(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      const workspace = workspaceByPublicId(db, args.workspaceId)
      const session = db.prepare(`SELECT * FROM session_history WHERE session_id = ?`).get(args.sessionId) as SessionRow | undefined
      if (!workspace || !session || session.workspace_id !== args.workspaceId || session.deleted_at) denied()
      if (!sessionRole(db, workspace, session, who, "write")) denied()
    },
    async authorizeRuntimeSession(args) {
      const db = database()
      const who = db.prepare(`SELECT * FROM users WHERE token_identifier = ?`).get(args.actorId) as AuthorityUser | undefined
      if (!who || (who.kind ?? "human") !== args.actorKind) denied()
      const workspace = workspaceByPublicId(db, args.workspaceId)
      const session = db.prepare(`SELECT * FROM session_history WHERE session_id = ?`).get(args.sessionId) as SessionRow | undefined
      if (!workspace || !session || session.workspace_id !== args.workspaceId || session.deleted_at) denied()
      if (!sessionRole(db, workspace, session, who, args.action)) denied()
    },
    async registerRuntimeSession(args) {
      const db = database()
      const who = db.prepare(`SELECT * FROM users WHERE token_identifier = ?`).get(args.actorId) as AuthorityUser | undefined
      if (!who || (who.kind ?? "human") !== args.actorKind) denied()
      const workspace = workspaceByPublicId(db, args.workspaceId)
      if (!workspace || !authorizeWorkspaceForUser(db, workspace, who, "write")) denied()
      return db.transaction(() => {
        const existing = db.prepare(`SELECT * FROM session_history WHERE session_id = ?`)
          .get(args.sessionId) as SessionRow | undefined
        if (
          existing
          && (existing.workspace_id !== args.workspaceId || existing.created_by_token_identifier !== who.token_identifier)
        ) denied()
        const now = Date.now()
        if (existing) {
          db.prepare(`
            UPDATE session_history
            SET title = COALESCE(?, title), updated_at = ?, deleted_at = NULL
            WHERE session_id = ?
          `).run(args.title ?? null, now, args.sessionId)
        } else {
          db.prepare(`
            INSERT INTO session_history (
              session_id, workspace_id, created_by_token_identifier, title, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?)
          `).run(args.sessionId, args.workspaceId, who.token_identifier, args.title ?? null, now, now)
        }
        db.prepare(`
          INSERT INTO session_participants (
            session_id, workspace_id, actor_token_identifier, added_by_token_identifier, created_at, revoked_at
          ) VALUES (?, ?, ?, ?, ?, NULL)
          ON CONFLICT (session_id, actor_token_identifier) DO UPDATE SET
            workspace_id = excluded.workspace_id,
            added_by_token_identifier = excluded.added_by_token_identifier,
            revoked_at = NULL
        `).run(args.sessionId, args.workspaceId, who.token_identifier, who.token_identifier, now)
        return { registered: !existing }
      })()
    },
    async addSessionParticipant(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      const workspace = workspaceByPublicId(db, args.workspaceId)
      const session = db.prepare(`SELECT * FROM session_history WHERE session_id = ?`).get(args.sessionId) as SessionRow | undefined
      if (!workspace || !session || session.workspace_id !== args.workspaceId || session.deleted_at) denied()
      const membership = workspace.org_id ? db.prepare(`
        SELECT role FROM org_memberships WHERE org_id = ? AND token_identifier = ?
      `).get(workspace.org_id, who.token_identifier) as { role: string } | undefined : undefined
      if (
        session.created_by_token_identifier !== who.token_identifier
        && membership?.role !== "admin"
        && membership?.role !== "owner"
      ) denied()
      const participant = db.prepare(`SELECT token_identifier, subject FROM users WHERE token_identifier = ?`)
        .get(args.participantTokenIdentifier) as AuthorityUser | undefined
      if (!participant || !authorizeWorkspaceForUser(db, workspace, participant, "read")) denied()
      const now = Date.now()
      db.prepare(`
        INSERT INTO session_participants (
          session_id, workspace_id, actor_token_identifier, added_by_token_identifier, created_at, revoked_at
        ) VALUES (?, ?, ?, ?, ?, NULL)
        ON CONFLICT (session_id, actor_token_identifier) DO UPDATE SET
          added_by_token_identifier = excluded.added_by_token_identifier,
          created_at = excluded.created_at,
          revoked_at = NULL
      `).run(args.sessionId, args.workspaceId, participant.token_identifier, who.token_identifier, now)
      return { participant_id: `${args.sessionId}:${participant.token_identifier}` }
    },
    async removeSessionParticipant(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      const workspace = workspaceByPublicId(db, args.workspaceId)
      const session = db.prepare(`SELECT * FROM session_history WHERE session_id = ?`).get(args.sessionId) as SessionRow | undefined
      if (!workspace || !session || session.workspace_id !== args.workspaceId || session.deleted_at) denied()
      const membership = workspace.org_id ? db.prepare(`
        SELECT role FROM org_memberships WHERE org_id = ? AND token_identifier = ?
      `).get(workspace.org_id, who.token_identifier) as { role: string } | undefined : undefined
      if (
        session.created_by_token_identifier !== who.token_identifier
        && membership?.role !== "admin"
        && membership?.role !== "owner"
      ) denied()
      if (args.participantTokenIdentifier === session.created_by_token_identifier) return { removed: false }
      const result = db.prepare(`
        UPDATE session_participants SET revoked_at = ?
        WHERE session_id = ? AND actor_token_identifier = ? AND revoked_at IS NULL
      `).run(Date.now(), args.sessionId, args.participantTokenIdentifier)
      return { removed: result.changes > 0 }
    },
    async listSessions(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      const workspace = workspaceByPublicId(db, args.workspaceId)
      if (!workspace || !authorizeWorkspaceForUser(db, workspace, who, "read")) return []
      const membership = workspace.org_id ? db.prepare(`
        SELECT role FROM org_memberships WHERE org_id = ? AND token_identifier = ?
      `).get(workspace.org_id, who.token_identifier) as { role: string } | undefined : undefined
      const participantSessions = new Set((db.prepare(`
        SELECT session_id FROM session_participants
        WHERE workspace_id = ? AND actor_token_identifier = ? AND revoked_at IS NULL
      `).all(args.workspaceId, who.token_identifier) as Array<{ session_id: string }>).map((row) => row.session_id))
      return (db.prepare(`
        SELECT * FROM session_history
        WHERE workspace_id = ? AND deleted_at IS NULL
        ORDER BY updated_at DESC
      `).all(args.workspaceId) as SessionRow[]).filter((session) =>
        session.created_by_token_identifier === who.token_identifier
        || membership?.role === "admin"
        || membership?.role === "owner"
        || participantSessions.has(session.session_id)
      )
    },
    async readSessionMessages(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      const workspace = workspaceByPublicId(db, args.workspaceId)
      const session = db.prepare(`SELECT * FROM session_history WHERE session_id = ?`).get(args.sessionId) as SessionRow | undefined
      const role = workspace && session && session.workspace_id === args.workspaceId && !session.deleted_at
        ? sessionRole(db, workspace, session, who, "read")
        : undefined
      if (!role) return { allowed: false, messages: [] }
      if (args.before !== undefined && args.limit === undefined) {
        throw new AgentMessagePageError(400, "Message page limit is required with a cursor")
      }
      if (args.limit !== undefined && (
        !Number.isSafeInteger(args.limit)
        || args.limit < 1
        || args.limit > MAX_MESSAGE_PAGE_LIMIT
      )) {
        throw new AgentMessagePageError(400, `Message page limit must be between 1 and ${MAX_MESSAGE_PAGE_LIMIT}`)
      }
      type MessageAuthorRow = {
        data: string
        public_id: string | null
        name: string | null
        image_url: string | null
        kind: string | null
      }
      if (args.limit === undefined) {
        const rows = db.prepare(`
          SELECT m.data, u.public_id, u.name, u.image_url, u.kind
          FROM session_messages m
          LEFT JOIN users u ON u.token_identifier = m.author_actor_id
          WHERE m.session_id = ? AND m.workspace_id = ? ORDER BY m.ordinal ASC
        `).all(args.sessionId, args.workspaceId) as MessageAuthorRow[]
        return {
          allowed: true,
          role,
          messages: rows.map((row) => messageWithPublicAuthor(JSON.parse(row.data) as unknown, row)),
        }
      }
      const beforeOrdinal = args.before === undefined
        ? undefined
        : decodeMessagePageCursor(args.sessionId, args.before)
      const rows = (beforeOrdinal === undefined
        ? db.prepare(`
            SELECT m.ordinal, m.data, u.public_id, u.name, u.image_url, u.kind
            FROM session_messages m
            LEFT JOIN users u ON u.token_identifier = m.author_actor_id
            WHERE m.session_id = ? AND m.workspace_id = ?
            ORDER BY m.ordinal DESC LIMIT ?
          `).all(args.sessionId, args.workspaceId, args.limit + 1)
        : db.prepare(`
            SELECT m.ordinal, m.data, u.public_id, u.name, u.image_url, u.kind
            FROM session_messages m
            LEFT JOIN users u ON u.token_identifier = m.author_actor_id
            WHERE m.session_id = ? AND m.workspace_id = ? AND m.ordinal < ?
            ORDER BY m.ordinal DESC LIMIT ?
          `).all(args.sessionId, args.workspaceId, beforeOrdinal, args.limit + 1)) as Array<MessageAuthorRow & { ordinal: number }>
      const hasMore = rows.length > args.limit
      const selected = rows.slice(0, args.limit).reverse()
      return {
        allowed: true,
        role,
        messages: selected.map((row) => messageWithPublicAuthor(JSON.parse(row.data) as unknown, row)),
        ...(hasMore && selected[0]
          ? { nextCursor: encodeMessagePageCursor(args.sessionId, selected[0].ordinal) }
          : {}),
      }
    },
    async syncSessionMessages(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      const workspace = requireWorkspace(db, who, args.workspaceId, "write")
      const now = Date.now()
      return db.transaction(() => {
        const existing = db.prepare(`
          SELECT session_id, workspace_id, created_by_token_identifier, deleted_at, max_event_ordinal
          FROM session_history WHERE session_id = ?
        `).get(args.sessionId) as SessionRow & {
          max_event_ordinal: number
        } | undefined
        if (existing && existing.workspace_id !== args.workspaceId) throw new Error("Session not found")
        if (existing && !sessionRole(db, workspace, existing, who, "write")) denied()
        if (args.maxEventOrdinal !== undefined && args.maxEventOrdinal < (existing?.max_event_ordinal ?? 0)) {
          return { ok: true, applied: false, maxEventOrdinal: existing?.max_event_ordinal ?? 0 }
        }
        if (args.maxEventOrdinal !== undefined && args.maxEventOrdinal === (existing?.max_event_ordinal ?? 0)) {
          const stored = db.prepare(`
            SELECT COUNT(*) AS count FROM session_messages WHERE session_id = ? AND workspace_id = ?
          `).get(args.sessionId, args.workspaceId) as { count: number }
          if (stored.count > 0 && args.messages.length <= stored.count) {
            return { ok: true, applied: false, maxEventOrdinal: existing?.max_event_ordinal ?? 0 }
          }
        }
        if (existing) {
          if (existing.deleted_at) {
            db.prepare(`UPDATE session_history SET deleted_at = NULL WHERE session_id = ?`).run(args.sessionId)
          }
          if (args.maxEventOrdinal !== undefined) {
            db.prepare(`UPDATE session_history SET max_event_ordinal = ? WHERE session_id = ?`)
              .run(args.maxEventOrdinal, args.sessionId)
          }
        } else {
          db.prepare(`
            INSERT INTO session_history (
              session_id, workspace_id, created_by_token_identifier, created_at, updated_at, max_event_ordinal
            ) VALUES (?, ?, ?, ?, ?, ?)
          `).run(args.sessionId, workspace.workspace_id, who.token_identifier, now, now, args.maxEventOrdinal ?? 0)
          db.prepare(`
            INSERT INTO session_participants (
              session_id, workspace_id, actor_token_identifier, added_by_token_identifier, created_at
            ) VALUES (?, ?, ?, ?, ?)
          `).run(args.sessionId, workspace.workspace_id, who.token_identifier, who.token_identifier, now)
        }
        const existingAuthors = new Map((db.prepare(`
          SELECT message_id, author_actor_id FROM session_messages WHERE session_id = ? AND workspace_id = ?
        `).all(args.sessionId, args.workspaceId) as Array<{ message_id: string; author_actor_id: string | null }>)
          .map((row) => [row.message_id, row.author_actor_id]))
        // Replace-all: observable read shape (ordered `data` payloads) matches
        // the Convex per-row diffing without carrying its patch bookkeeping.
        deleteMessageRows(db, args.sessionId, args.workspaceId)
        const insert = db.prepare(`
          INSERT INTO session_messages (
            session_id, workspace_id, message_id, author_actor_id, role, ordinal, data, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (session_id, message_id) DO UPDATE SET
            author_actor_id = COALESCE(session_messages.author_actor_id, excluded.author_actor_id),
            role = excluded.role, ordinal = excluded.ordinal, data = excluded.data, updated_at = excluded.updated_at
        `)
        for (let ordinal = 0; ordinal < args.messages.length; ordinal += 1) {
          const message = args.messages[ordinal]
          const row = object(message)
          const info = object(row?.info)
          const messageId = txt(row?.id) ?? txt(info?.id) ?? `${args.sessionId}:${ordinal}`
          const role = txt(row?.role) ?? txt(info?.role) ?? null
          const author = role === "user" ? existingAuthors.get(messageId) ?? who.token_identifier : null
          insert.run(args.sessionId, args.workspaceId, messageId, author, role, ordinal, jsonText(message), now, now)
        }
        return args.maxEventOrdinal === undefined
          ? { ok: true }
          : { ok: true, applied: true, maxEventOrdinal: args.maxEventOrdinal }
      })()
    },
    async upsertSessionVisibility(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      const workspace = requireWorkspace(db, who, args.workspaceId, "write")
      db.transaction(() => {
        upsertVisibilityRows(db, { who, workspace, sessions: args.sessions })
      })()
      return { ok: true }
    },
    async replaceSessionVisibility(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      const workspace = requireWorkspace(db, who, args.workspaceId, "write")
      db.transaction(() => {
        upsertVisibilityRows(db, { who, workspace, sessions: args.sessions })
        const incoming = new Set(args.sessions.map((session) => session.sessionId))
        const now = Date.now()
        const rows = db.prepare(`SELECT * FROM session_history WHERE workspace_id = ? AND deleted_at IS NULL`)
          .all(args.workspaceId) as SessionRow[]
        for (const row of rows.filter((item) =>
          item.created_by_token_identifier === who.token_identifier
          && !incoming.has(item.session_id))) {
          if (!sessionRole(db, workspace, row, who, "write")) denied()
          db.prepare(`UPDATE session_history SET deleted_at = ?, updated_at = ? WHERE session_id = ?`)
            .run(now, now, row.session_id)
          deleteMessageRows(db, row.session_id, args.workspaceId)
        }
      })()
      return { ok: true }
    },
    async deleteSessionVisibility(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      const workspace = requireWorkspace(db, who, args.workspaceId, "write")
      const session = db.prepare(`SELECT * FROM session_history WHERE session_id = ?`)
        .get(args.sessionId) as SessionRow | undefined
      if (!session || session.workspace_id !== args.workspaceId) return { ok: true }
      if (!sessionRole(db, workspace, session, who, "write")) denied()
      db.transaction(() => {
        const now = Date.now()
        db.prepare(`UPDATE session_history SET deleted_at = ?, updated_at = ? WHERE session_id = ?`)
          .run(now, now, args.sessionId)
        deleteMessageRows(db, args.sessionId, args.workspaceId)
      })()
      return { ok: true }
    },

    // --- runtime tokens (convex/runtimeAccessTokens.ts) ---------------------
    async recordRuntimeAccessToken(auth: SignedControlPlaneAuth, args) {
      const db = database()
      const who = user(auth)
      requireWorkspace(db, who, args.workspaceId, "read")
      const existing = db.prepare(`SELECT jti FROM runtime_access_tokens WHERE jti = ?`).get(args.jti)
      if (existing) throw new Error("Runtime Access Token already recorded")
      db.prepare(`
        INSERT INTO runtime_access_tokens (jti, workspace_id, host_id, minted_for_token_identifier, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(args.jti, args.workspaceId, args.hostId, who.token_identifier, args.expiresAt, Date.now())
      return { ok: true }
    },
    async recordRuntimeAccessTokenForService(args) {
      const db = database()
      const existing = db.prepare(`SELECT jti FROM runtime_access_tokens WHERE jti = ?`).get(args.jti)
      if (existing) throw new Error("Runtime Access Token already recorded")
      db.prepare(`
        INSERT INTO runtime_access_tokens (jti, workspace_id, host_id, minted_for_token_identifier, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(args.jti, args.workspaceId, args.hostId, args.subject, args.expiresAt, Date.now())
      return { ok: true }
    },
    async runtimeAccessTokenActive(args) {
      const db = database()
      const token = db.prepare(`SELECT * FROM runtime_access_tokens WHERE jti = ?`).get(args.jti) as {
        workspace_id: string
        host_id: string
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
}
