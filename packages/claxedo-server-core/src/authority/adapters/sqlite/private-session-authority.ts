import { AgentMessagePageError } from "@claxedo/agent-sdk-runtime/message-page"
import { ControlPlaneAuthError, type SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type {
  PrivateSessionAuthority,
  PrivateSessionRegistrationResult,
  PrivateSessionRuntimePrincipal,
  ReservePrivateSessionInput,
  TransitionPrivateSessionRegistrationInput,
} from "@claxedo/server-core/platform/auth/private-session-authority"
import {
  authorizeWorkspaceForUser,
  workspaceByPublicId,
  type AuthorityUser,
  type SqliteAuthorityDb,
  type WorkspaceAction,
  type WorkspaceRow,
} from "./workspace-authority-store"

const MESSAGE_PAGE_CURSOR_PREFIX = "sawmp1:"
const MAX_MESSAGE_PAGE_LIMIT = 500

type RegistrationState = PrivateSessionRegistrationResult["state"]
type RegistrationRow = {
  operation_id: string
  session_id: string
  workspace_id: string
  creator_actor_id: string
  operation_kind: "create" | "fork"
  parent_session_id: string | null
  requested_title: string | null
  state: RegistrationState
  state_reason: string | null
}
type SessionRow = {
  session_id: string
  workspace_id: string
  creator_actor_id: string
  operation_id: string
  title: string | null
  created_at: number
  updated_at: number
  max_event_ordinal: number
  deleted_at: number | null
}
type MessageRow = {
  ordinal: number
  data: string
  author_actor_id: string | null
  author_kind: "human" | "agent" | null
}

export class SqlitePrivateSessionAuthorityError extends Error {
  constructor(
    public readonly code:
      | "invalid_input"
      | "resource_conflict"
      | "registration_transition_denied"
      | "actor_authorization_denied",
    message: string,
  ) {
    super(message)
    this.name = "SqlitePrivateSessionAuthorityError"
  }
}

export function createSqlitePrivateSessionAuthority(input: {
  database: () => SqliteAuthorityDb
  principal(auth: SignedControlPlaneAuth): AuthorityUser
  now?: () => number
}): PrivateSessionAuthority {
  const now = input.now ?? Date.now
  const actorForAuth = (auth: SignedControlPlaneAuth) => input.principal(auth)

  const workspaceAccess = (
    db: SqliteAuthorityDb,
    actor: AuthorityUser,
    workspaceId: string,
    action: WorkspaceAction,
  ) => {
    const workspace = workspaceByPublicId(db, workspaceId)
    if (!workspace || workspace.deleted_at || !authorizeWorkspaceForUser(db, workspace, actor, action)) denied()
    return workspace
  }

  const runtimeActor = (db: SqliteAuthorityDb, principal: PrivateSessionRuntimePrincipal) => {
    if (
      (principal.principalKind === "user" && principal.actorKind !== "human")
      || (principal.principalKind === "service" && principal.actorKind !== "agent")
    ) throw new SqlitePrivateSessionAuthorityError("actor_authorization_denied", "Runtime principal kind is inconsistent")
    const actor = db.prepare(`SELECT token_identifier, subject, kind FROM users WHERE token_identifier = ?`)
      .get(required(principal.actorId, "actorId")) as (AuthorityUser & { kind: string }) | undefined
    if (!actor || actor.kind !== principal.actorKind) {
      throw new SqlitePrivateSessionAuthorityError("actor_authorization_denied", "Canonical active session actor is required")
    }
    return actor
  }

  const registration = (db: SqliteAuthorityDb, operationId: string) => db.prepare(`
    SELECT * FROM session_registration_operations WHERE operation_id = ?
  `).get(operationId) as RegistrationRow | undefined

  const session = (db: SqliteAuthorityDb, sessionId: string) => db.prepare(`
    SELECT * FROM session_history WHERE session_id = ?
  `).get(sessionId) as SessionRow | undefined

  const isOrgAdmin = (db: SqliteAuthorityDb, actorId: string, workspace: WorkspaceRow) => {
    if (!workspace.org_id) return false
    const row = db.prepare(`
      SELECT o.owner_token_identifier, m.role
      FROM orgs o
      LEFT JOIN org_memberships m ON m.org_id = o.org_id AND m.token_identifier = ?
      WHERE o.org_id = ? AND o.deleted_at IS NULL
    `).get(actorId, workspace.org_id) as { owner_token_identifier: string | null; role: string | null } | undefined
    return row?.owner_token_identifier === actorId || row?.role === "owner" || row?.role === "admin"
  }

  const hasPrivateAccess = (db: SqliteAuthorityDb, actorId: string, row: SessionRow, workspace: WorkspaceRow) => {
    if (row.creator_actor_id === actorId || isOrgAdmin(db, actorId, workspace)) return true
    const participant = db.prepare(`
      SELECT 1 FROM session_participants
      WHERE session_id = ? AND workspace_id = ? AND participant_actor_id = ? AND revoked_at IS NULL
    `).get(row.session_id, row.workspace_id, actorId)
    return !!participant
  }

  const requireSessionAccess = (
    db: SqliteAuthorityDb,
    actor: AuthorityUser,
    sessionId: string,
    workspaceId: string,
    action: "read" | "write",
  ) => {
    const workspace = workspaceAccess(db, actor, workspaceId, action)
    const row = session(db, required(sessionId, "sessionId"))
    if (!row || row.workspace_id !== workspaceId || row.deleted_at || !hasPrivateAccess(db, actor.token_identifier, row, workspace)) denied()
    return { row, workspace }
  }

  const participantAdministrator = (
    db: SqliteAuthorityDb,
    actor: AuthorityUser,
    sessionId: string,
    workspaceId: string,
  ) => {
    const current = requireSessionAccess(db, actor, sessionId, workspaceId, "read")
    if (current.row.creator_actor_id !== actor.token_identifier && !isOrgAdmin(db, actor.token_identifier, current.workspace)) {
      throw new SqlitePrivateSessionAuthorityError("actor_authorization_denied", "Session participant administration was denied")
    }
    return current
  }

  const transition = (
    principal: TransitionPrivateSessionRegistrationInput,
    from: readonly RegistrationState[],
    to: RegistrationState,
  ) => {
    const db = input.database()
    const actor = runtimeActor(db, principal)
    const operationId = required(principal.operationId, "operationId")
    const sessionId = required(principal.sessionId, "sessionId")
    const workspaceId = required(principal.workspaceId, "workspaceId")
    const reason = required(principal.reason, "reason")
    return db.transaction(() => {
      const row = registration(db, operationId)
      if (
        !row
        || row.creator_actor_id !== actor.token_identifier
        || row.session_id !== sessionId
        || row.workspace_id !== workspaceId
      ) {
        throw new SqlitePrivateSessionAuthorityError("actor_authorization_denied", "Session registration actor was denied")
      }
      if (row.state === to) return result(row, false)
      if (!from.includes(row.state)) {
        throw new SqlitePrivateSessionAuthorityError("registration_transition_denied", `Cannot transition ${row.state} to ${to}`)
      }
      db.prepare(`
        UPDATE session_registration_operations SET state = ?, state_reason = ?, updated_at = ?
        WHERE operation_id = ? AND creator_actor_id = ? AND state = ?
      `).run(to, reason, now(), operationId, actor.token_identifier, row.state)
      return result(registration(db, operationId)!, true)
    })()
  }

  const reserveSession = async (auth: SignedControlPlaneAuth, value: ReservePrivateSessionInput) => {
    const db = input.database()
    const actor = actorForAuth(auth)
    const intent = reserveIntent(value)
    workspaceAccess(db, actor, intent.workspaceId, "write")
    if (intent.kind === "fork") {
      requireSessionAccess(db, actor, intent.parentSessionId!, intent.workspaceId, "read")
    }
    return db.transaction(() => {
      const existing = registration(db, intent.operationId)
      if (existing) {
        sameRegistration(existing, intent, actor.token_identifier)
        return result(existing, false)
      }
      const sessionCollision = db.prepare(`SELECT operation_id FROM session_registration_operations WHERE session_id = ?`)
        .get(intent.sessionId)
      if (sessionCollision || session(db, intent.sessionId)) {
        throw new SqlitePrivateSessionAuthorityError("resource_conflict", "Session registration identifier is already owned")
      }
      const at = now()
      db.prepare(`
        INSERT INTO session_registration_operations (
          operation_id, session_id, workspace_id, creator_actor_id, operation_kind,
          parent_session_id, requested_title, state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?)
      `).run(
        intent.operationId,
        intent.sessionId,
        intent.workspaceId,
        actor.token_identifier,
        intent.kind,
        intent.parentSessionId ?? null,
        intent.title ?? null,
        at,
        at,
      )
      return result(registration(db, intent.operationId)!, true)
    })()
  }

  return {
    reserveSession,
    async registerRuntimeSession(value) {
      const db = input.database()
      const actor = runtimeActor(db, value)
      const operationId = required(value.operationId, "operationId")
      const sessionId = required(value.sessionId, "sessionId")
      const workspaceId = required(value.workspaceId, "workspaceId")
      const title = optional(value.title)
      return db.transaction(() => {
        const row = registration(db, operationId)
        if (!row) throw new SqlitePrivateSessionAuthorityError("registration_transition_denied", "A matching session reservation is required")
        sameRegistration(row, { operationId, sessionId, workspaceId, kind: row.operation_kind, parentSessionId: row.parent_session_id ?? undefined, title }, actor.token_identifier)
        if (row.state === "registered") return result(row, false)
        if (row.state !== "reserved" && row.state !== "reconciliation_required") {
          throw new SqlitePrivateSessionAuthorityError("registration_transition_denied", `Cannot register a ${row.state} reservation`)
        }
        workspaceAccess(db, actor, workspaceId, "write")
        const at = now()
        db.prepare(`
          INSERT INTO session_history (
            session_id, workspace_id, creator_actor_id, operation_id, title, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(sessionId, workspaceId, actor.token_identifier, operationId, title ?? null, at, at)
        db.prepare(`
          INSERT INTO session_participants (
            session_id, workspace_id, participant_actor_id, added_by_actor_id, created_at
          ) VALUES (?, ?, ?, ?, ?)
        `).run(sessionId, workspaceId, actor.token_identifier, actor.token_identifier, at)
        db.prepare(`
          UPDATE session_registration_operations
          SET state = 'registered', state_reason = NULL, updated_at = ?
          WHERE operation_id = ? AND creator_actor_id = ? AND state IN ('reserved', 'reconciliation_required')
        `).run(at, operationId, actor.token_identifier)
        return result(registration(db, operationId)!, true)
      })()
    },
    async markSessionRegistrationAmbiguous(value) {
      return transition(value, ["reserved"], "reconciliation_required")
    },
    async beginSessionCompensation(value) {
      return transition(value, ["reserved", "reconciliation_required"], "compensation_pending")
    },
    async completeSessionCompensation(value) {
      return transition(value, ["compensation_pending"], "compensated")
    },
    async authorizeSessionRead(auth, value) {
      requireSessionAccess(input.database(), actorForAuth(auth), value.sessionId, value.workspaceId, "read")
    },
    async authorizeSessionWrite(auth, value) {
      requireSessionAccess(input.database(), actorForAuth(auth), value.sessionId, value.workspaceId, "write")
    },
    async authorizeRuntimeSession(value) {
      const db = input.database()
      const actor = runtimeActor(db, value)
      requireSessionAccess(db, actor, value.sessionId, value.workspaceId, value.action)
    },
    async grantSessionParticipant(auth, value) {
      const db = input.database()
      const actor = actorForAuth(auth)
      participantAdministrator(db, actor, value.sessionId, value.workspaceId)
      const participantId = required(value.participantActorId, "participantActorId")
      if (!db.prepare(`SELECT 1 FROM users WHERE token_identifier = ?`).get(participantId)) {
        throw new SqlitePrivateSessionAuthorityError("invalid_input", "Participant actor does not exist")
      }
      const at = now()
      db.prepare(`
        INSERT INTO session_participants (
          session_id, workspace_id, participant_actor_id, added_by_actor_id, created_at, revoked_at
        ) VALUES (?, ?, ?, ?, ?, NULL)
        ON CONFLICT (session_id, participant_actor_id) DO UPDATE SET
          workspace_id = excluded.workspace_id,
          added_by_actor_id = excluded.added_by_actor_id,
          created_at = excluded.created_at,
          revoked_at = NULL
      `).run(value.sessionId, value.workspaceId, participantId, actor.token_identifier, at)
      return { participant_id: participantId }
    },
    async revokeSessionParticipant(auth, value) {
      const db = input.database()
      const actor = actorForAuth(auth)
      const current = participantAdministrator(db, actor, value.sessionId, value.workspaceId)
      const participantId = required(value.participantActorId, "participantActorId")
      if (participantId === current.row.creator_actor_id) {
        throw new SqlitePrivateSessionAuthorityError("actor_authorization_denied", "Session creator cannot be revoked")
      }
      const at = now()
      const removed = db.prepare(`
        UPDATE session_participants SET revoked_at = ?
        WHERE session_id = ? AND workspace_id = ? AND participant_actor_id = ? AND revoked_at IS NULL
      `).run(at, value.sessionId, value.workspaceId, participantId).changes > 0
      if (removed) {
        db.prepare(`
          UPDATE runtime_access_tokens SET revoked_at = ?
          WHERE workspace_id = ? AND actor_id = ? AND revoked_at IS NULL
        `).run(at, value.workspaceId, participantId)
      }
      return { removed }
    },
    async listSessions(auth, value) {
      const db = input.database()
      const actor = actorForAuth(auth)
      const workspace = workspaceAccess(db, actor, value.workspaceId, "read")
      const rows = db.prepare(`
        SELECT * FROM session_history WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC
      `).all(value.workspaceId) as SessionRow[]
      return rows.filter((row) => hasPrivateAccess(db, actor.token_identifier, row, workspace)).map(publicSession)
    },
    async resolveSession(auth, value) {
      const db = input.database()
      const actor = actorForAuth(auth)
      const row = session(db, value.sessionId)
      if (!row || row.deleted_at) return null
      try {
        requireSessionAccess(db, actor, row.session_id, row.workspace_id, "read")
      } catch (error) {
        if (error instanceof ControlPlaneAuthError) return null
        throw error
      }
      return { ...publicSession(row), workspace_id: row.workspace_id }
    },
    async readSessionMessages(auth, value) {
      const db = input.database()
      const actor = actorForAuth(auth)
      let role: string | undefined
      try {
        const current = requireSessionAccess(db, actor, value.sessionId, value.workspaceId, "read")
        role = authorizeWorkspaceForUser(db, current.workspace, actor, "read")
      } catch (error) {
        if (error instanceof ControlPlaneAuthError) return { allowed: false, messages: [] }
        throw error
      }
      validatePage(value.limit, value.before)
      const before = value.before === undefined ? undefined : decodeCursor(value.sessionId, value.before)
      const query = value.limit === undefined
        ? db.prepare(`
            SELECT m.ordinal, m.data, m.author_actor_id, u.kind AS author_kind
            FROM session_messages m LEFT JOIN users u ON u.token_identifier = m.author_actor_id
            WHERE m.session_id = ? AND m.workspace_id = ? ORDER BY m.ordinal ASC
          `)
        : before === undefined
          ? db.prepare(`
              SELECT m.ordinal, m.data, m.author_actor_id, u.kind AS author_kind
              FROM session_messages m LEFT JOIN users u ON u.token_identifier = m.author_actor_id
              WHERE m.session_id = ? AND m.workspace_id = ? ORDER BY m.ordinal DESC LIMIT ?
            `)
          : db.prepare(`
              SELECT m.ordinal, m.data, m.author_actor_id, u.kind AS author_kind
              FROM session_messages m LEFT JOIN users u ON u.token_identifier = m.author_actor_id
              WHERE m.session_id = ? AND m.workspace_id = ? AND m.ordinal < ? ORDER BY m.ordinal DESC LIMIT ?
            `)
      const rows = (value.limit === undefined
        ? query.all(value.sessionId, value.workspaceId)
        : before === undefined
          ? query.all(value.sessionId, value.workspaceId, value.limit + 1)
          : query.all(value.sessionId, value.workspaceId, before, value.limit + 1)) as MessageRow[]
      if (value.limit === undefined) return { allowed: true, role, messages: rows.map(publicMessage) }
      const selected = rows.slice(0, value.limit).reverse()
      return {
        allowed: true,
        role,
        messages: selected.map(publicMessage),
        ...(rows.length > value.limit && selected[0]
          ? { nextCursor: encodeCursor(value.sessionId, selected[0].ordinal) }
          : {}),
      }
    },
    async syncSessionMessages(auth, value) {
      const db = input.database()
      const actor = actorForAuth(auth)
      const current = requireSessionAccess(db, actor, value.sessionId, value.workspaceId, "write")
      return db.transaction(() => {
        if (value.maxEventOrdinal !== undefined && value.maxEventOrdinal < current.row.max_event_ordinal) {
          return { ok: true, applied: false, maxEventOrdinal: current.row.max_event_ordinal }
        }
        if (value.maxEventOrdinal !== undefined && value.maxEventOrdinal === current.row.max_event_ordinal) {
          const count = db.prepare(`SELECT COUNT(*) AS count FROM session_messages WHERE session_id = ?`)
            .get(value.sessionId) as { count: number }
          if (count.count > 0 && value.messages.length <= count.count) {
            return { ok: true, applied: false, maxEventOrdinal: current.row.max_event_ordinal }
          }
        }
        const existing = new Map((db.prepare(`
          SELECT message_id, author_actor_id FROM session_messages WHERE session_id = ? AND workspace_id = ?
        `).all(value.sessionId, value.workspaceId) as Array<{ message_id: string; author_actor_id: string | null }>)
          .map((row) => [row.message_id, row.author_actor_id]))
        db.prepare(`DELETE FROM session_messages WHERE session_id = ? AND workspace_id = ?`)
          .run(value.sessionId, value.workspaceId)
        const insert = db.prepare(`
          INSERT INTO session_messages (
            session_id, workspace_id, message_id, author_actor_id, role, ordinal, data, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        const at = now()
        for (let ordinal = 0; ordinal < value.messages.length; ordinal += 1) {
          const message = value.messages[ordinal]
          const id = messageId(message, value.sessionId, ordinal)
          const role = messageRole(message)
          const claimed = messageAuthorId(message)
          const authorId = existing.get(id) ?? (role === "user" && claimed === actor.token_identifier ? actor.token_identifier : null)
          insert.run(value.sessionId, value.workspaceId, id, authorId, role, ordinal, json(message), at, at)
        }
        db.prepare(`
          UPDATE session_history SET max_event_ordinal = COALESCE(?, max_event_ordinal), updated_at = ?
          WHERE session_id = ? AND workspace_id = ?
        `).run(value.maxEventOrdinal ?? null, at, value.sessionId, value.workspaceId)
        return value.maxEventOrdinal === undefined
          ? { ok: true }
          : { ok: true, applied: true, maxEventOrdinal: value.maxEventOrdinal }
      })()
    },
    async upsertSessionVisibility(auth, value) {
      writeVisibility(input.database(), actorForAuth(auth), value.workspaceId, value.sessions, false)
      return { ok: true }
    },
    async replaceSessionVisibility(auth, value) {
      writeVisibility(input.database(), actorForAuth(auth), value.workspaceId, value.sessions, true)
      return { ok: true }
    },
    async deleteSessionVisibility(auth, value) {
      const db = input.database()
      const actor = actorForAuth(auth)
      requireSessionAccess(db, actor, value.sessionId, value.workspaceId, "write")
      const at = now()
      db.transaction(() => {
        db.prepare(`UPDATE session_history SET deleted_at = ?, updated_at = ? WHERE session_id = ? AND workspace_id = ?`)
          .run(at, at, value.sessionId, value.workspaceId)
        db.prepare(`DELETE FROM session_messages WHERE session_id = ? AND workspace_id = ?`)
          .run(value.sessionId, value.workspaceId)
      })()
      return { ok: true }
    },
  }

  function writeVisibility(
    db: SqliteAuthorityDb,
    actor: AuthorityUser,
    workspaceId: string,
    rows: Array<{ sessionId: string; title?: string; createdAt?: number; updatedAt?: number }>,
    replace: boolean,
  ) {
    workspaceAccess(db, actor, workspaceId, "write")
    db.transaction(() => {
      const incoming = new Set<string>()
      for (const value of rows) {
        const current = requireSessionAccess(db, actor, value.sessionId, workspaceId, "write")
        if (value.createdAt !== undefined && value.createdAt !== current.row.created_at) {
          throw new SqlitePrivateSessionAuthorityError("resource_conflict", "Session creation time is owned by registration")
        }
        incoming.add(value.sessionId)
        db.prepare(`
          UPDATE session_history SET title = COALESCE(?, title), updated_at = MAX(updated_at, COALESCE(?, ?))
          WHERE session_id = ? AND workspace_id = ? AND deleted_at IS NULL
        `).run(value.title ?? null, value.updatedAt ?? null, now(), value.sessionId, workspaceId)
      }
      if (!replace) return
      const owned = db.prepare(`
        SELECT session_id FROM session_history
        WHERE workspace_id = ? AND creator_actor_id = ? AND deleted_at IS NULL
      `).all(workspaceId, actor.token_identifier) as Array<{ session_id: string }>
      const at = now()
      for (const row of owned) {
        if (incoming.has(row.session_id)) continue
        db.prepare(`UPDATE session_history SET deleted_at = ?, updated_at = ? WHERE session_id = ?`)
          .run(at, at, row.session_id)
        db.prepare(`DELETE FROM session_messages WHERE session_id = ?`).run(row.session_id)
      }
    })()
  }
}

function reserveIntent(value: ReservePrivateSessionInput) {
  const kind = value.kind
  const parentSessionId = optional(value.parentSessionId)
  if (kind === "fork" && !parentSessionId) {
    throw new SqlitePrivateSessionAuthorityError("invalid_input", "Fork reservation requires parentSessionId")
  }
  if (kind === "create" && parentSessionId) {
    throw new SqlitePrivateSessionAuthorityError("invalid_input", "Create reservation cannot name parentSessionId")
  }
  return {
    operationId: required(value.operationId, "operationId"),
    sessionId: required(value.sessionId, "sessionId"),
    workspaceId: required(value.workspaceId, "workspaceId"),
    kind,
    parentSessionId,
    title: optional(value.title),
  }
}

function sameRegistration(
  row: RegistrationRow,
  value: ReturnType<typeof reserveIntent>,
  actorId: string,
) {
  if (
    row.session_id !== value.sessionId
    || row.workspace_id !== value.workspaceId
    || row.creator_actor_id !== actorId
    || row.operation_kind !== value.kind
    || row.parent_session_id !== (value.parentSessionId ?? null)
    || row.requested_title !== (value.title ?? null)
  ) throw new SqlitePrivateSessionAuthorityError("resource_conflict", "Session registration retry changed its canonical input")
}

function result(row: RegistrationRow, changed: boolean): PrivateSessionRegistrationResult {
  return {
    changed,
    operationId: row.operation_id,
    sessionId: row.session_id,
    workspaceId: row.workspace_id,
    state: row.state,
  }
}

function publicSession(row: SessionRow) {
  return {
    session_id: row.session_id,
    title: row.title ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function messageId(value: unknown, sessionId: string, ordinal: number) {
  const row = record(value)
  const info = record(row?.info)
  return optional(row?.id) ?? optional(info?.id) ?? `${sessionId}:${ordinal}`
}

function messageRole(value: unknown) {
  const row = record(value)
  const info = record(row?.info)
  return optional(row?.role) ?? optional(info?.role) ?? null
}

function messageAuthorId(value: unknown) {
  const info = record(record(value)?.info)
  const claxedo = record(info?.claxedo)
  return optional(record(claxedo?.author)?.id)
}

function publicMessage(row: MessageRow) {
  const value = JSON.parse(row.data) as unknown
  const message = record(value)
  if (!message) return value
  const info = record(message.info) ?? {}
  const claxedo = record(info.claxedo) ?? {}
  const { author: _author, ...safeClaxedo } = claxedo
  const { claxedo: _claxedo, ...safeInfo } = info
  const canonical = row.author_actor_id && (row.author_kind === "human" || row.author_kind === "agent")
    ? { ...safeClaxedo, author: { id: row.author_actor_id, kind: row.author_kind } }
    : safeClaxedo
  return {
    ...message,
    info: {
      ...safeInfo,
      ...(Object.keys(canonical).length ? { claxedo: canonical } : {}),
    },
  }
}

function validatePage(limit: number | undefined, before: string | undefined) {
  if (before !== undefined && limit === undefined) throw new AgentMessagePageError(400, "Message page limit is required with a cursor")
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_MESSAGE_PAGE_LIMIT)) {
    throw new AgentMessagePageError(400, `Message page limit must be between 1 and ${MAX_MESSAGE_PAGE_LIMIT}`)
  }
}

function encodeCursor(sessionId: string, ordinal: number) {
  return `${MESSAGE_PAGE_CURSOR_PREFIX}${Buffer.from(JSON.stringify({ sessionId, ordinal })).toString("base64url")}`
}

function decodeCursor(sessionId: string, value: string) {
  try {
    if (!value.startsWith(MESSAGE_PAGE_CURSOR_PREFIX)) throw new Error()
    const parsed = JSON.parse(Buffer.from(value.slice(MESSAGE_PAGE_CURSOR_PREFIX.length), "base64url").toString("utf8")) as {
      sessionId?: unknown
      ordinal?: unknown
    }
    if (parsed.sessionId !== sessionId || !Number.isSafeInteger(parsed.ordinal) || Number(parsed.ordinal) < 0) throw new Error()
    return Number(parsed.ordinal)
  } catch {
    throw new AgentMessagePageError(400, "Invalid message page cursor")
  }
}

function required(value: unknown, name: string) {
  const text = optional(value)
  if (!text) throw new SqlitePrivateSessionAuthorityError("invalid_input", `${name} is required`)
  return text
}

function optional(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function json(value: unknown) {
  try {
    return JSON.stringify(value) ?? "null"
  } catch {
    throw new SqlitePrivateSessionAuthorityError("invalid_input", "Session message must be JSON serializable")
  }
}

function denied(): never {
  throw new ControlPlaneAuthError(403, "workspace_authorization_denied", "Private session authority denied access")
}
