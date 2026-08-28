import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types"
import { AgentMessagePageError } from "@claxedo/agent-sdk-runtime/message-page"
import { ControlPlaneAuthError, type SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { ProjectRole, WorkspaceAuthority, WorkspaceVisibility } from "@claxedo/server-core/platform/auth/authority"
import type {
  PrivateSessionActor,
  PrivateSessionAuthority,
  PrivateSessionRegistrationState,
  PrivateSessionRuntimePrincipal,
  ReservePrivateSessionInput,
  TransitionPrivateSessionRegistrationInput,
} from "@claxedo/server-core/platform/auth/private-session-authority"
import {
  SessionTurnConflictError,
  SessionTurnLeaseLostError,
  type AcquireSessionTurnInput,
  type OwnedSessionTurnInput,
  type SessionTurnAuthority,
  type SessionTurnLease,
} from "@claxedo/server-core/platform/auth/session-turn-authority"
import { SESSION_TURN_LEASE_TTL_MS } from "@claxedo/workspace-relay-protocol"

export const D1_SESSION_AUTHORITY_METHODS = [
  "authorizeSessionRead",
  "listSessions",
  "resolveSession",
  "readSessionMessages",
  "syncSessionMessages",
  "upsertSessionVisibility",
  "replaceSessionVisibility",
  "deleteSessionVisibility",
] as const satisfies readonly (keyof WorkspaceAuthority)[]

export const D1_SESSION_TURN_AUTHORITY_METHODS = [
  "acquireSessionTurn",
  "renewSessionTurn",
  "releaseSessionTurn",
] as const satisfies readonly (keyof SessionTurnAuthority)[]

export type D1SessionAuthorityPort = Pick<WorkspaceAuthority, (typeof D1_SESSION_AUTHORITY_METHODS)[number]>

export type D1SessionAuthorityOptions = {
  deploymentId: string
  now?: () => number
  randomId?: (prefix: "assert" | "snapshot" | "turn") => string
  turnLeaseTtlMs?: number
}

export type SessionRegistrationState = PrivateSessionRegistrationState
export type ReserveSessionInput = ReservePrivateSessionInput
export type RuntimeSessionActor = PrivateSessionRuntimePrincipal

type Principal = PrivateSessionActor & { userId: string }

type PrincipalRow = {
  user_id: string
  user_state: "active" | "suspended" | "deleted"
  actor_id: string
  actor_kind: "human" | "agent"
  actor_state: "active" | "suspended" | "revoked"
  unlinked_at: number | null
}

type ActorRow = {
  actor_id: string
  actor_kind: "human" | "agent"
  actor_state: "active" | "suspended" | "revoked"
  user_id: string | null
  user_state: "active" | "suspended" | "deleted" | null
}

type WorkspaceAccessRow = {
  workspace_id: string
  org_id: string
  project_id: string
  role_rank: number
}

type SessionRow = {
  session_id: string
  operation_id: string
  workspace_id: string
  org_id: string
  project_id: string
  creator_actor_id: string
  lifecycle_generation: number
  title: string | null
  created_at: number
  updated_at: number
  deleted_at: number | null
  max_event_ordinal: number
  snapshot_generation: number
  snapshot_hash: string | null
}

type RegistrationRow = {
  operation_id: string
  session_id: string
  workspace_id: string
  org_id: string
  project_id: string
  creator_actor_id: string
  operation_kind: "create" | "fork"
  parent_session_id: string | null
  requested_title: string | null
  state: SessionRegistrationState
  state_reason: string | null
  created_at: number
  updated_at: number
}

type MessageRow = {
  ordinal: number
  data_json: string
  author_actor_id: string | null
  author_kind: "human" | "agent" | null
}

type TurnLeaseRow = {
  session_id: string
  workspace_id: string
  org_id: string
  project_id: string
  turn_id: string
  lease_id: string
  fencing_token: number
  actor_id: string
  acquired_at: number
  expires_at: number
  released_at: number | null
}

type CanonicalMessage = {
  id: string
  role: string
  ordinal: number
  dataJson: string
  authorActorId: string | null
}

const MESSAGE_PAGE_CURSOR_PREFIX = "d1sm1:"
const MAX_MESSAGE_PAGE_LIMIT = 500
const MAX_SNAPSHOT_MESSAGES = 500
const MAX_MESSAGE_BYTES = 256 * 1024
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024
const MAX_VISIBILITY_ROWS = 500

export class D1SessionAuthorityError extends Error {
  constructor(
    public readonly code:
      "invalid_input" | "resource_conflict" | "registration_transition_denied" | "actor_authorization_denied",
    message: string,
  ) {
    super(message)
    this.name = "D1SessionAuthorityError"
  }
}

/**
 * D1 private-session capability. Unknown transcripts never create sessions:
 * callers must reserve an immutable create/fork intent and the runtime must
 * register that exact reservation before visibility or message writes begin.
 */
export class D1SessionAuthority implements D1SessionAuthorityPort, PrivateSessionAuthority, SessionTurnAuthority {
  private readonly now: () => number
  private readonly randomId: NonNullable<D1SessionAuthorityOptions["randomId"]>
  private readonly turnLeaseTtlMs: number

  constructor(
    private readonly database: D1Database,
    private readonly options: D1SessionAuthorityOptions,
  ) {
    requireText(options.deploymentId, "deploymentId")
    this.now = options.now ?? Date.now
    this.randomId = options.randomId ?? ((prefix) => `${prefix}_${crypto.randomUUID()}`)
    this.turnLeaseTtlMs = boundedTurnLeaseTtl(options.turnLeaseTtlMs)
  }

  async reserveSession(auth: SignedControlPlaneAuth, input: ReserveSessionInput) {
    const who = await this.requirePrincipal(auth)
    const intent = normalizeReservation(input)
    const workspace = await this.requireWorkspaceAccess(who, intent.workspaceId, "write")
    if (intent.kind === "fork") {
      await this.requireSessionAccess(who, intent.parentSessionId!, intent.workspaceId, "read")
    }

    const existing = await this.registration(intent.operationId)
    if (existing) {
      requireSameRegistration(existing, intent, workspace, who.actorId)
      return registrationResult(existing, false)
    }

    const now = this.now()
    const assertionId = this.randomId("assert")
    await this.guardedBatch(
      [
        this.database
          .prepare(
            `
        insert into session_registration_operations (
          operation_id, session_id, workspace_id, org_id, project_id, creator_actor_id,
          operation_kind, parent_session_id, requested_title, state, state_reason, created_at, updated_at
        )
        select ?, ?, w.workspace_id, w.org_id, w.project_id, ?, ?, ?, ?, 'reserved', null, ?, ?
        from workspaces w
        where w.workspace_id = ? and w.org_id = ? and w.project_id = ? and w.deleted_at is null
          and ${actorWorkspaceAccessSql("?", "w", 2)}
          and (? = 'create' or exists (
            select 1 from sessions parent
            where parent.session_id = ? and parent.workspace_id = w.workspace_id and parent.deleted_at is null
              and ${actorSessionAccessSql("?", "parent", 1)}
          ))
        on conflict do nothing
      `,
          )
          .bind(
            intent.operationId,
            intent.sessionId,
            who.actorId,
            intent.kind,
            intent.parentSessionId ?? null,
            intent.title ?? null,
            now,
            now,
            workspace.workspace_id,
            workspace.org_id,
            workspace.project_id,
            ...repeat(who.actorId, 7),
            intent.kind,
            intent.parentSessionId ?? null,
            ...repeat(who.actorId, 10),
          ),
        this.registrationAssertion(assertionId, intent, workspace, who.actorId, "reserved"),
        this.deleteAssertion(assertionId),
      ],
      "Session reservation collided or authority changed",
    )
    return registrationResult((await this.registration(intent.operationId))!, true)
  }

  /** Runtime registration succeeds only for a prior durable reservation. */
  async registerRuntimeSession(
    input: RuntimeSessionActor & {
      operationId: string
      sessionId: string
      workspaceId: string
      title?: string
    },
  ) {
    const actor = await this.requireRuntimeActor(input)
    const operationId = requireText(input.operationId, "operationId")
    const sessionId = requireText(input.sessionId, "sessionId")
    const workspaceId = requireText(input.workspaceId, "workspaceId")
    const title = optionalText(input.title, "title", 2_000)
    const result = await this.database
      .prepare(
        `
      select * from session_registration_operations
      where operation_id = ? and session_id = ? and workspace_id = ? and creator_actor_id = ?
    `,
      )
      .bind(operationId, sessionId, workspaceId, actor.actorId)
      .first<RegistrationRow>()
    if (!result)
      throw new D1SessionAuthorityError("registration_transition_denied", "A matching session reservation is required")
    if (result.requested_title !== (title ?? null)) {
      throw new D1SessionAuthorityError(
        "resource_conflict",
        "Runtime registration title does not match the reservation",
      )
    }
    return await this.registerReservation(actor, result)
  }

  async markSessionRegistrationAmbiguous(input: TransitionPrivateSessionRegistrationInput) {
    return await this.transitionRegistration(input, ["reserved", "compensation_pending"], "reconciliation_required")
  }

  async beginSessionCompensation(input: TransitionPrivateSessionRegistrationInput) {
    return await this.transitionRegistration(input, ["reserved", "reconciliation_required"], "compensation_pending")
  }

  async completeSessionCompensation(input: TransitionPrivateSessionRegistrationInput) {
    return await this.transitionRegistration(input, ["compensation_pending"], "compensated")
  }

  async authorizeSessionRead(auth: SignedControlPlaneAuth, args: { sessionId: string; workspaceId: string }) {
    await this.requireSessionAccess(
      await this.requirePrincipal(auth),
      requireText(args.sessionId, "sessionId"),
      requireText(args.workspaceId, "workspaceId"),
      "read",
    )
  }

  async authorizeSessionWrite(auth: SignedControlPlaneAuth, args: { sessionId: string; workspaceId: string }) {
    await this.requireSessionAccess(
      await this.requirePrincipal(auth),
      requireText(args.sessionId, "sessionId"),
      requireText(args.workspaceId, "workspaceId"),
      "write",
    )
  }

  async authorizeRuntimeSession(
    input: RuntimeSessionActor & {
      sessionId: string
      workspaceId: string
      action: "read" | "write"
    },
  ) {
    const actor = await this.requireRuntimeActor(input)
    await this.requireSessionAccess(
      actor,
      requireText(input.sessionId, "sessionId"),
      requireText(input.workspaceId, "workspaceId"),
      input.action,
    )
  }

  /**
   * Atomically claims the single active turn row for this session. The INSERT
   * source repeats current private-session authorization, so a revocation race
   * cannot acquire after the preceding diagnostic read. Exact retries observe
   * the same lease; only release/expiry permits replacement, which increments
   * the fence in the same statement.
   */
  async acquireSessionTurn(input: AcquireSessionTurnInput): Promise<SessionTurnLease> {
    const actor = await this.requireRuntimeActor(input)
    const sessionId = requireText(input.sessionId, "sessionId")
    const workspaceId = requireText(input.workspaceId, "workspaceId")
    const turnId = requireText(input.turnId, "turnId", 512)
    await this.requireSessionAccess(actor, sessionId, workspaceId, "write")
    const now = this.now()
    const expiresAt = now + this.turnLeaseTtlMs
    const leaseId = this.randomId("turn")
    await this.database
      .prepare(
        `
      insert into session_turn_leases (
        session_id, workspace_id, org_id, project_id, turn_id, lease_id,
        fencing_token, actor_id, acquired_at, expires_at, released_at
      )
      select s.session_id, s.workspace_id, s.org_id, s.project_id, ?, ?,
        1, ?, ?, ?, null
      from sessions s
      where s.session_id = ? and s.workspace_id = ? and s.deleted_at is null
        and ${actorSessionAccessSql("?", "s", 2)}
      on conflict (session_id) do update set
        turn_id = excluded.turn_id,
        lease_id = excluded.lease_id,
        fencing_token = session_turn_leases.fencing_token + 1,
        actor_id = excluded.actor_id,
        acquired_at = excluded.acquired_at,
        expires_at = excluded.expires_at,
        released_at = null
      where session_turn_leases.released_at is not null
        or session_turn_leases.expires_at <= ?
    `,
      )
      .bind(
        turnId,
        leaseId,
        actor.actorId,
        now,
        expiresAt,
        sessionId,
        workspaceId,
        ...repeat(actor.actorId, 10),
        now,
      )
      .run()
    const row = await this.turnLease(sessionId)
    if (
      row
      && row.workspace_id === workspaceId
      && row.turn_id === turnId
      && row.actor_id === actor.actorId
      && row.released_at === null
      && row.expires_at > now
    ) return turnLeaseJson(row)

    // Recheck after the conditional write so a current denial never leaks the
    // competing turn's expiry. Only an authorized contender gets a 409.
    await this.requireSessionAccess(actor, sessionId, workspaceId, "write")
    throw new SessionTurnConflictError(sessionId, row?.expires_at)
  }

  async renewSessionTurn(input: OwnedSessionTurnInput): Promise<SessionTurnLease> {
    const actor = await this.requireRuntimeActor(input)
    const sessionId = requireText(input.sessionId, "sessionId")
    const workspaceId = requireText(input.workspaceId, "workspaceId")
    const turnId = requireText(input.turnId, "turnId", 512)
    const leaseId = requireText(input.leaseId, "leaseId", 512)
    const fencingToken = positiveFence(input.fencingToken)
    await this.requireSessionAccess(actor, sessionId, workspaceId, "write")
    const now = this.now()
    const expiresAt = now + this.turnLeaseTtlMs
    await this.database
      .prepare(
        `
      update session_turn_leases set expires_at = ?
      where session_id = ? and workspace_id = ? and turn_id = ? and lease_id = ?
        and fencing_token = ? and actor_id = ? and released_at is null and expires_at > ?
        and exists (
          select 1 from sessions s
          where s.session_id = session_turn_leases.session_id
            and s.workspace_id = session_turn_leases.workspace_id
            and s.deleted_at is null
            and ${actorSessionAccessSql("?", "s", 2)}
        )
    `,
      )
      .bind(
        expiresAt,
        sessionId,
        workspaceId,
        turnId,
        leaseId,
        fencingToken,
        actor.actorId,
        now,
        ...repeat(actor.actorId, 10),
      )
      .run()
    const row = await this.turnLease(sessionId)
    if (
      row
      && row.workspace_id === workspaceId
      && row.turn_id === turnId
      && row.lease_id === leaseId
      && row.fencing_token === fencingToken
      && row.actor_id === actor.actorId
      && row.released_at === null
      && row.expires_at > now
    ) return turnLeaseJson(row)
    throw new SessionTurnLeaseLostError(sessionId)
  }

  async releaseSessionTurn(input: OwnedSessionTurnInput) {
    const actor = await this.requireRuntimeActor(input)
    const sessionId = requireText(input.sessionId, "sessionId")
    const workspaceId = requireText(input.workspaceId, "workspaceId")
    const turnId = requireText(input.turnId, "turnId", 512)
    const leaseId = requireText(input.leaseId, "leaseId", 512)
    const fencingToken = positiveFence(input.fencingToken)
    const now = this.now()
    await this.database
      .prepare(
        `
      update session_turn_leases set released_at = ?
      where session_id = ? and workspace_id = ? and turn_id = ? and lease_id = ?
        and fencing_token = ? and actor_id = ? and released_at is null
    `,
      )
      .bind(now, sessionId, workspaceId, turnId, leaseId, fencingToken, actor.actorId)
      .run()
    const row = await this.turnLease(sessionId)
    return {
      released: Boolean(
        row
        && row.workspace_id === workspaceId
        && row.turn_id === turnId
        && row.lease_id === leaseId
        && row.fencing_token === fencingToken
        && row.actor_id === actor.actorId
        && row.released_at !== null
      ),
      sessionId,
      turnId,
      fencingToken,
    }
  }

  async grantSessionParticipant(
    auth: SignedControlPlaneAuth,
    args: { sessionId: string; workspaceId: string; participantActorId: string },
  ) {
    const administrator = await this.requirePrincipal(auth)
    const sessionId = requireText(args.sessionId, "sessionId")
    const workspaceId = requireText(args.workspaceId, "workspaceId")
    const participant = await this.requireRuntimeActor({
      principalKind: "user",
      actorId: requireText(args.participantActorId, "participantActorId"),
      actorKind: "human",
    })
    const session = await this.requireParticipantAdministrator(administrator, sessionId, workspaceId)
    await this.requireWorkspaceAccess(participant, workspaceId, "read")
    const now = this.now()
    const assertionId = this.randomId("assert")
    await this.guardedBatch(
      [
        this.database
          .prepare(
            `
        insert into session_participants (
          session_id, workspace_id, org_id, project_id, actor_id,
          granted_by_actor_id, role, granted_at, revoked_at
        ) values (?, ?, ?, ?, ?, ?, 'participant', ?, null)
        on conflict (session_id, actor_id) do update set
          granted_by_actor_id = excluded.granted_by_actor_id,
          revoked_at = null
      `,
          )
          .bind(
            session.session_id,
            session.workspace_id,
            session.org_id,
            session.project_id,
            participant.actorId,
            administrator.actorId,
            now,
          ),
        this.database
          .prepare(
            `
        insert into authority_batch_assertions (assertion_id, passed)
        values (?, case when
          exists (
            select 1 from sessions s where s.session_id = ? and s.workspace_id = ? and s.deleted_at is null
              and ${participantAdministratorSql("?", "s")}
          )
          and exists (
            select 1 from workspaces w where w.workspace_id = ? and w.deleted_at is null
              and ${actorWorkspaceAccessSql("?", "w", 1)}
          )
          and exists (
            select 1 from session_participants p
            where p.session_id = ? and p.actor_id = ? and p.revoked_at is null
          )
        then 1 else 0 end)
      `,
          )
          .bind(
            assertionId,
            sessionId,
            workspaceId,
            ...repeat(administrator.actorId, 9),
            workspaceId,
            ...repeat(participant.actorId, 7),
            sessionId,
            participant.actorId,
          ),
        this.deleteAssertion(assertionId),
      ],
      "Session participant grant raced with an authority change",
    )
    return { participant_id: participant.actorId }
  }

  async revokeSessionParticipant(
    auth: SignedControlPlaneAuth,
    args: { sessionId: string; workspaceId: string; participantActorId: string },
  ) {
    const administrator = await this.requirePrincipal(auth)
    const sessionId = requireText(args.sessionId, "sessionId")
    const workspaceId = requireText(args.workspaceId, "workspaceId")
    const participantActorId = requireText(args.participantActorId, "participantActorId")
    const session = await this.requireParticipantAdministrator(administrator, sessionId, workspaceId)
    if (participantActorId === session.creator_actor_id) return { removed: false }
    const existing = await this.database
      .prepare(
        `
      select 1 from session_participants where session_id = ? and actor_id = ? and revoked_at is null
    `,
      )
      .bind(sessionId, participantActorId)
      .first()
    if (!existing) return { removed: false }
    const now = this.now()
    const assertionId = this.randomId("assert")
    await this.guardedBatch(
      [
        this.database
          .prepare(
            `
        update session_participants set revoked_at = ?
        where session_id = ? and actor_id = ? and revoked_at is null
      `,
          )
          .bind(now, sessionId, participantActorId),
        this.database
          .prepare(
            `
        insert into authority_batch_assertions (assertion_id, passed)
        values (?, case when exists (
          select 1 from sessions s where s.session_id = ? and s.workspace_id = ? and s.deleted_at is null
            and ${participantAdministratorSql("?", "s")}
        ) and exists (
          select 1 from session_participants where session_id = ? and actor_id = ? and revoked_at = ?
        ) then 1 else 0 end)
      `,
          )
          .bind(
            assertionId,
            sessionId,
            workspaceId,
            ...repeat(administrator.actorId, 9),
            sessionId,
            participantActorId,
            now,
          ),
        this.deleteAssertion(assertionId),
      ],
      "Session participant revocation raced with an authority change",
    )
    return { removed: true }
  }

  async listSessions(auth: SignedControlPlaneAuth, args: { workspaceId: string }) {
    const who = await this.requirePrincipal(auth)
    const workspaceId = requireText(args.workspaceId, "workspaceId")
    try {
      await this.requireWorkspaceAccess(who, workspaceId, "read")
    } catch (error) {
      if (isDenied(error)) return []
      throw error
    }
    const result = await this.database
      .prepare(
        `
      select s.* from sessions s
      where s.workspace_id = ? and s.deleted_at is null
        and ${actorSessionAccessSql("?", "s", 1)}
      order by s.updated_at desc, s.session_id
    `,
      )
      .bind(workspaceId, ...repeat(who.actorId, 10))
      .all<SessionRow>()
    return result.results.map(sessionJson)
  }

  async resolveSession(auth: SignedControlPlaneAuth, args: { sessionId: string }) {
    const who = await this.requirePrincipal(auth)
    const sessionId = requireText(args.sessionId, "sessionId")
    const session = await this.session(sessionId)
    if (!session || session.deleted_at !== null) return null
    try {
      await this.requireSessionAccess(who, sessionId, session.workspace_id, "read")
    } catch (error) {
      if (isDenied(error)) return null
      throw error
    }
    return { ...sessionJson(session), workspace_id: session.workspace_id }
  }

  async readSessionMessages(
    auth: SignedControlPlaneAuth,
    args: { sessionId: string; workspaceId: string; limit?: number; before?: string },
  ) {
    const who = await this.requirePrincipal(auth)
    const sessionId = requireText(args.sessionId, "sessionId")
    const workspaceId = requireText(args.workspaceId, "workspaceId")
    if (args.before !== undefined && args.limit === undefined) {
      throw new AgentMessagePageError(400, "Message page limit is required with a cursor")
    }
    if (
      args.limit !== undefined &&
      (!Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > MAX_MESSAGE_PAGE_LIMIT)
    ) {
      throw new AgentMessagePageError(400, `Message page limit must be between 1 and ${MAX_MESSAGE_PAGE_LIMIT}`)
    }
    let access: SessionRow & { role_rank: number }
    try {
      access = await this.requireSessionAccess(who, sessionId, workspaceId, "read")
    } catch (error) {
      if (isDenied(error)) return { allowed: false, messages: [] }
      throw error
    }
    const beforeOrdinal = args.before === undefined ? undefined : decodeMessagePageCursor(sessionId, args.before)
    const limit = args.limit
    const query = this.database.prepare(`
      select m.ordinal, m.data_json, m.author_actor_id, a.kind as author_kind
      from session_messages m
      left join actors a on a.actor_id = m.author_actor_id and a.state = 'active'
      where m.session_id = ? and m.workspace_id = ? and (? is null or m.ordinal < ?)
      order by m.ordinal ${limit === undefined ? "asc" : "desc"}
      ${limit === undefined ? "" : "limit ?"}
    `)
    const result =
      limit === undefined
        ? await query.bind(sessionId, workspaceId, beforeOrdinal ?? null, beforeOrdinal ?? null).all<MessageRow>()
        : await query
            .bind(sessionId, workspaceId, beforeOrdinal ?? null, beforeOrdinal ?? null, limit + 1)
            .all<MessageRow>()
    const rows = limit === undefined ? result.results : result.results.slice(0, limit).reverse()
    const hasMore = limit !== undefined && result.results.length > limit
    return {
      allowed: true,
      role: rankRole(access.role_rank),
      messages: rows.map(publicMessage),
      ...(hasMore && rows[0] ? { nextCursor: encodeMessagePageCursor(sessionId, rows[0].ordinal) } : {}),
    }
  }

  async syncSessionMessages(
    auth: SignedControlPlaneAuth,
    args: {
      sessionId: string
      workspaceId: string
      messages: unknown[]
      intakeReady?: boolean
      maxEventOrdinal?: number
    },
  ) {
    const who = await this.requirePrincipal(auth)
    const sessionId = requireText(args.sessionId, "sessionId")
    const workspaceId = requireText(args.workspaceId, "workspaceId")
    await this.requireSessionAccess(who, sessionId, workspaceId, "write")
    if (args.intakeReady) {
      throw new D1SessionAuthorityError("invalid_input", "Session intake is not owned by the D1 session authority")
    }
    const maxEventOrdinal = optionalOrdinal(args.maxEventOrdinal)
    const messages = canonicalMessages(args.messages, who.actorId)
    const snapshotJson = JSON.stringify(messages)
    if (byteLength(snapshotJson) > MAX_SNAPSHOT_BYTES) {
      throw new D1SessionAuthorityError("invalid_input", `Session snapshot exceeds ${MAX_SNAPSHOT_BYTES} bytes`)
    }
    const snapshotHash = await sha256(snapshotJson)
    const current = await this.session(sessionId)
    if (!current || current.workspace_id !== workspaceId || current.deleted_at !== null) throw denied()
    if (maxEventOrdinal !== undefined && maxEventOrdinal < current.max_event_ordinal) {
      return { ok: true, applied: false, maxEventOrdinal: current.max_event_ordinal }
    }
    if (
      maxEventOrdinal !== undefined &&
      maxEventOrdinal === current.max_event_ordinal &&
      current.snapshot_hash !== null
    ) {
      if (current.snapshot_hash !== snapshotHash) {
        throw new D1SessionAuthorityError("resource_conflict", "Equal session event ordinals carry different snapshots")
      }
      return { ok: true, applied: false, maxEventOrdinal: current.max_event_ordinal }
    }

    const now = this.now()
    const snapshotToken = this.randomId("snapshot")
    const assertionId = this.randomId("assert")
    const eventGuard =
      maxEventOrdinal === undefined
        ? "1 = 1"
        : "(max_event_ordinal < ? or (max_event_ordinal = ? and snapshot_hash is null))"
    const eventBindings = maxEventOrdinal === undefined ? [] : [maxEventOrdinal, maxEventOrdinal]
    try {
      await this.guardedBatch(
        [
          this.database
            .prepare(
              `
          update sessions set
            snapshot_generation = snapshot_generation + 1,
            snapshot_hash = ?,
            snapshot_token = ?,
            max_event_ordinal = coalesce(?, max_event_ordinal),
            updated_at = ?
          where session_id = ? and workspace_id = ? and deleted_at is null
            and ${eventGuard}
            and ${actorSessionAccessSql("?", "sessions", 2)}
        `,
            )
            .bind(
              snapshotHash,
              snapshotToken,
              maxEventOrdinal ?? null,
              now,
              sessionId,
              workspaceId,
              ...eventBindings,
              ...repeat(who.actorId, 10),
            ),
          this.database
            .prepare(
              `
          insert into session_messages (
            session_id, workspace_id, org_id, project_id, message_id, author_actor_id,
            role, ordinal, data_json, snapshot_generation, created_at, updated_at
          )
          select s.session_id, s.workspace_id, s.org_id, s.project_id,
            json_extract(j.value, '$.id'),
            json_extract(j.value, '$.authorActorId'),
            json_extract(j.value, '$.role'),
            json_extract(j.value, '$.ordinal'),
            json_extract(j.value, '$.dataJson'),
            s.snapshot_generation,
            ?, ?
          from sessions s, json_each(?) j
          where s.session_id = ? and s.snapshot_token = ?
          on conflict (session_id, message_id) do update set
            author_actor_id = case when excluded.role = 'user'
              then coalesce(session_messages.author_actor_id, excluded.author_actor_id)
              else null end,
            role = excluded.role,
            ordinal = excluded.ordinal,
            data_json = excluded.data_json,
            snapshot_generation = excluded.snapshot_generation,
            updated_at = excluded.updated_at
        `,
            )
            .bind(now, now, snapshotJson, sessionId, snapshotToken),
          this.database
            .prepare(
              `
          delete from session_messages
          where session_id = ? and snapshot_generation < (
            select snapshot_generation from sessions where session_id = ? and snapshot_token = ?
          )
        `,
            )
            .bind(sessionId, sessionId, snapshotToken),
          this.database
            .prepare(
              `
          insert into authority_batch_assertions (assertion_id, passed)
          values (?, case when exists (
            select 1 from sessions s where s.session_id = ? and s.workspace_id = ?
              and s.snapshot_token = ? and s.snapshot_hash = ? and s.deleted_at is null
              and ${actorSessionAccessSql("?", "s", 2)}
          ) then 1 else 0 end)
        `,
            )
            .bind(assertionId, sessionId, workspaceId, snapshotToken, snapshotHash, ...repeat(who.actorId, 10)),
          this.deleteAssertion(assertionId),
        ],
        "Session snapshot raced with another write or authority change",
      )
    } catch (error) {
      const latest = await this.session(sessionId)
      if (
        error instanceof D1SessionAuthorityError &&
        error.code === "resource_conflict" &&
        maxEventOrdinal !== undefined &&
        latest?.max_event_ordinal === maxEventOrdinal &&
        latest.snapshot_hash === snapshotHash
      )
        return { ok: true, applied: false, maxEventOrdinal }
      throw error
    }
    return { ok: true, applied: true, maxEventOrdinal: maxEventOrdinal ?? current.max_event_ordinal }
  }

  async upsertSessionVisibility(
    auth: SignedControlPlaneAuth,
    args: { workspaceId: string; sessions: WorkspaceVisibility[] },
  ) {
    await this.writeVisibility(auth, args, false)
    return { ok: true }
  }

  async replaceSessionVisibility(
    auth: SignedControlPlaneAuth,
    args: { workspaceId: string; sessions: WorkspaceVisibility[] },
  ) {
    await this.writeVisibility(auth, args, true)
    return { ok: true }
  }

  async deleteSessionVisibility(auth: SignedControlPlaneAuth, args: { sessionId: string; workspaceId: string }) {
    const who = await this.requirePrincipal(auth)
    const sessionId = requireText(args.sessionId, "sessionId")
    const workspaceId = requireText(args.workspaceId, "workspaceId")
    await this.requireSessionAccess(who, sessionId, workspaceId, "write")
    const now = this.now()
    const assertionId = this.randomId("assert")
    await this.guardedBatch(
      [
        this.database
          .prepare(
            `
        update sessions set deleted_at = ?, updated_at = ?
        where session_id = ? and workspace_id = ? and deleted_at is null
          and ${actorSessionAccessSql("?", "sessions", 2)}
      `,
          )
          .bind(now, now, sessionId, workspaceId, ...repeat(who.actorId, 10)),
        this.database.prepare(`delete from session_messages where session_id = ?`).bind(sessionId),
        this.database
          .prepare(
            `
        insert into authority_batch_assertions (assertion_id, passed)
        values (?, case when exists (
          select 1 from sessions where session_id = ? and workspace_id = ? and deleted_at = ?
        ) then 1 else 0 end)
      `,
          )
          .bind(assertionId, sessionId, workspaceId, now),
        this.deleteAssertion(assertionId),
      ],
      "Session deletion raced with an authority change",
    )
    return { ok: true }
  }

  private async registerReservation(actor: Principal, registration: RegistrationRow) {
    await this.requireWorkspaceAccess(actor, registration.workspace_id, "write")
    if (registration.state === "registered") {
      const existing = await this.session(registration.session_id)
      if (
        !existing ||
        existing.creator_actor_id !== actor.actorId ||
        existing.operation_id !== registration.operation_id
      ) {
        throw new D1SessionAuthorityError("resource_conflict", "Registered session projection is incomplete")
      }
      return { registered: false, session: sessionJson(existing) }
    }
    if (registration.state !== "reserved" && registration.state !== "reconciliation_required") {
      throw new D1SessionAuthorityError(
        "registration_transition_denied",
        `Cannot register a ${registration.state} reservation`,
      )
    }
    if (registration.creator_actor_id !== actor.actorId) {
      throw new D1SessionAuthorityError("actor_authorization_denied", "Session creator does not match the reservation")
    }
    const now = this.now()
    const assertionId = this.randomId("assert")
    await this.guardedBatch(
      [
        this.database
          .prepare(
            `
        update session_registration_operations
        set state = 'registered', state_reason = null, updated_at = ?
        where operation_id = ? and creator_actor_id = ? and state in ('reserved', 'reconciliation_required')
          and exists (
            select 1 from workspaces w
            where w.workspace_id = session_registration_operations.workspace_id
              and w.org_id = session_registration_operations.org_id
              and w.project_id = session_registration_operations.project_id
              and w.deleted_at is null and ${actorWorkspaceAccessSql("?", "w", 2)}
          )
      `,
          )
          .bind(now, registration.operation_id, actor.actorId, ...repeat(actor.actorId, 7)),
        this.database
          .prepare(
            `
        insert into sessions (
          session_id, operation_id, workspace_id, org_id, project_id, creator_actor_id,
          lifecycle_generation, title, created_at, updated_at, deleted_at,
          max_event_ordinal, snapshot_generation, snapshot_hash, snapshot_token
        )
        select session_id, operation_id, workspace_id, org_id, project_id, creator_actor_id,
          1, requested_title, ?, ?, null, 0, 0, null, null
        from session_registration_operations
        where operation_id = ? and creator_actor_id = ? and state = 'registered'
        on conflict do nothing
      `,
          )
          .bind(now, now, registration.operation_id, actor.actorId),
        this.database
          .prepare(
            `
        insert into session_participants (
          session_id, workspace_id, org_id, project_id, actor_id,
          granted_by_actor_id, role, granted_at, revoked_at
        )
        select s.session_id, s.workspace_id, s.org_id, s.project_id,
          s.creator_actor_id, s.creator_actor_id, 'participant', ?, null
        from sessions s where s.operation_id = ? and s.creator_actor_id = ?
        on conflict (session_id, actor_id) do update set revoked_at = null
      `,
          )
          .bind(now, registration.operation_id, actor.actorId),
        this.database
          .prepare(
            `
        insert into authority_batch_assertions (assertion_id, passed)
        values (?, case when exists (
          select 1 from session_registration_operations r
          join sessions s on s.operation_id = r.operation_id and s.session_id = r.session_id
          join session_participants p on p.session_id = s.session_id and p.actor_id = s.creator_actor_id
          where r.operation_id = ? and r.state = 'registered' and s.creator_actor_id = ?
            and s.deleted_at is null and p.revoked_at is null
            and ${actorSessionAccessSql("?", "s", 2)}
        ) then 1 else 0 end)
      `,
          )
          .bind(assertionId, registration.operation_id, actor.actorId, ...repeat(actor.actorId, 10)),
        this.deleteAssertion(assertionId),
      ],
      "Session registration raced with an authority change",
    )
    return { registered: true, session: sessionJson((await this.session(registration.session_id))!) }
  }

  private async transitionRegistration(
    input: TransitionPrivateSessionRegistrationInput,
    from: SessionRegistrationState[],
    to: SessionRegistrationState,
  ) {
    const actor = await this.requireRuntimeActor(input)
    const operationId = requireText(input.operationId, "operationId")
    const sessionId = requireText(input.sessionId, "sessionId")
    const workspaceId = requireText(input.workspaceId, "workspaceId")
    const reason = requireText(input.reason, "reason", 2_000)
    const registration = await this.registration(operationId)
    if (
      !registration
      || registration.creator_actor_id !== actor.actorId
      || registration.session_id !== sessionId
      || registration.workspace_id !== workspaceId
    ) {
      throw new D1SessionAuthorityError("actor_authorization_denied", "Session registration actor was denied")
    }
    if (registration.state === to) return registrationResult(registration, false)
    if (!from.includes(registration.state)) {
      throw new D1SessionAuthorityError("registration_transition_denied", `Cannot move ${registration.state} to ${to}`)
    }
    if (registration.state === "registered" || (await this.session(registration.session_id))) {
      throw new D1SessionAuthorityError("registration_transition_denied", "Registered sessions must roll forward")
    }
    const now = this.now()
    const assertionId = this.randomId("assert")
    const placeholders = from.map(() => "?").join(", ")
    await this.guardedBatch(
      [
        this.database
          .prepare(
            `
        update session_registration_operations set state = ?, state_reason = ?, updated_at = ?
        where operation_id = ? and creator_actor_id = ? and state in (${placeholders})
          and not exists (select 1 from sessions where operation_id = ?)
      `,
          )
          .bind(to, reason, now, operationId, actor.actorId, ...from, operationId),
        this.database
          .prepare(
            `
        insert into authority_batch_assertions (assertion_id, passed)
        values (?, case when exists (
          select 1 from session_registration_operations
          where operation_id = ? and creator_actor_id = ? and state = ? and state_reason = ?
        ) and not exists (select 1 from sessions where operation_id = ?)
        then 1 else 0 end)
      `,
          )
          .bind(assertionId, operationId, actor.actorId, to, reason, operationId),
        this.deleteAssertion(assertionId),
      ],
      "Session registration state changed concurrently",
    )
    return registrationResult((await this.registration(operationId))!, true)
  }

  private async writeVisibility(
    auth: SignedControlPlaneAuth,
    args: { workspaceId: string; sessions: WorkspaceVisibility[] },
    replace: boolean,
  ) {
    const who = await this.requirePrincipal(auth)
    const workspaceId = requireText(args.workspaceId, "workspaceId")
    await this.requireWorkspaceAccess(who, workspaceId, "write")
    const rows = visibilityRows(args.sessions)
    for (const row of rows) {
      const existing = await this.requireSessionAccess(who, row.sessionId, workspaceId, "write")
      if (row.createdAt !== undefined && row.createdAt !== existing.created_at) {
        throw new D1SessionAuthorityError("resource_conflict", "Session creation time is owned by registration")
      }
    }
    const now = this.now()
    const assertionId = this.randomId("assert")
    const statements: D1PreparedStatement[] = rows.map((row) =>
      this.database
        .prepare(
          `
      update sessions set
        title = coalesce(?, title),
        updated_at = max(updated_at, coalesce(?, ?)),
        deleted_at = null
      where session_id = ? and workspace_id = ? and deleted_at is null
        and ${actorSessionAccessSql("?", "sessions", 2)}
    `,
        )
        .bind(row.title ?? null, row.updatedAt ?? null, now, row.sessionId, workspaceId, ...repeat(who.actorId, 10)),
    )
    if (replace) {
      statements.push(
        this.database
          .prepare(
            `
        update sessions set deleted_at = ?, updated_at = ?
        where workspace_id = ? and creator_actor_id = ? and deleted_at is null
          and not exists (select 1 from json_each(?) incoming where incoming.value = sessions.session_id)
          and ${actorSessionAccessSql("?", "sessions", 2)}
      `,
          )
          .bind(
            now,
            now,
            workspaceId,
            who.actorId,
            JSON.stringify(rows.map((row) => row.sessionId)),
            ...repeat(who.actorId, 10),
          ),
      )
      statements.push(
        this.database
          .prepare(
            `
        delete from session_messages where session_id in (
          select session_id from sessions where workspace_id = ? and creator_actor_id = ? and deleted_at = ?
        )
      `,
          )
          .bind(workspaceId, who.actorId, now),
      )
    }
    statements.push(
      this.database
        .prepare(
          `
      insert into authority_batch_assertions (assertion_id, passed)
      values (?, case when
        not exists (
          select 1 from json_each(?) requested
          left join sessions s on s.session_id = requested.value and s.workspace_id = ? and s.deleted_at is null
          where s.session_id is null or not (${actorSessionAccessSql("?", "s", 2)})
        )
      then 1 else 0 end)
    `,
        )
        .bind(assertionId, JSON.stringify(rows.map((row) => row.sessionId)), workspaceId, ...repeat(who.actorId, 10)),
    )
    statements.push(this.deleteAssertion(assertionId))
    await this.guardedBatch(statements, "Session visibility raced with an authority change")
  }

  private async requireParticipantAdministrator(actor: Principal, sessionId: string, workspaceId: string) {
    const session = await this.requireSessionAccess(actor, sessionId, workspaceId, "read")
    const allowed = await this.database
      .prepare(
        `
      select 1 from sessions s where s.session_id = ? and s.workspace_id = ? and s.deleted_at is null
        and ${participantAdministratorSql("?", "s")}
    `,
      )
      .bind(sessionId, workspaceId, ...repeat(actor.actorId, 9))
      .first()
    if (!allowed) throw denied("Session participant administration was denied")
    return session
  }

  private async requireSessionAccess(
    actor: Principal,
    sessionId: string,
    workspaceId: string,
    action: "read" | "write",
  ) {
    const session = await this.database
      .prepare(
        `
      select s.*,
        ${actorWorkspaceRoleRankSql("?", "w")} as role_rank
      from sessions s
      join workspaces w on w.workspace_id = s.workspace_id and w.org_id = s.org_id and w.project_id = s.project_id
      where s.session_id = ? and s.workspace_id = ? and s.deleted_at is null and w.deleted_at is null
        and ${actorSessionAccessSql("?", "s", action === "read" ? 1 : 2)}
    `,
      )
      .bind(...repeat(actor.actorId, 6), sessionId, workspaceId, ...repeat(actor.actorId, 10))
      .first<SessionRow & { role_rank: number }>()
    if (!session) throw denied()
    return session
  }

  private async requireWorkspaceAccess(actor: Principal, workspaceId: string, action: "read" | "write") {
    const row = await this.database
      .prepare(
        `
      select w.workspace_id, w.org_id, w.project_id,
        ${actorWorkspaceRoleRankSql("?", "w")} as role_rank
      from workspaces w
      where w.workspace_id = ? and w.deleted_at is null
        and ${actorWorkspaceAccessSql("?", "w", action === "read" ? 1 : 2)}
    `,
      )
      .bind(...repeat(actor.actorId, 6), workspaceId, ...repeat(actor.actorId, 7))
      .first<WorkspaceAccessRow>()
    if (!row) throw denied()
    return row
  }

  private async requirePrincipal(auth: SignedControlPlaneAuth): Promise<Principal> {
    const principal = auth.principal
    if (!principal)
      throw new ControlPlaneAuthError(503, "identity_provisioning", "Canonical application identity is required")
    if (principal.deploymentId !== this.options.deploymentId || principal.actorKind !== "human") {
      throw new ControlPlaneAuthError(
        401,
        "invalid_bearer_token",
        "Application principal belongs to another authority domain",
      )
    }
    const row = await this.database
      .prepare(
        `
      select ai.user_id, u.state as user_state, a.actor_id, a.kind as actor_kind,
        a.state as actor_state, ai.unlinked_at
      from auth_identities ai
      join users u on u.user_id = ai.user_id
      join actors a on a.actor_id = ? and a.user_id = u.user_id
      where ai.adapter = ? and ai.issuer = ? and ai.subject = ?
    `,
      )
      .bind(principal.actorId, principal.identity.adapter, principal.identity.issuer, principal.identity.subject)
      .first<PrincipalRow>()
    if (
      !row ||
      row.unlinked_at !== null ||
      row.user_id !== principal.userId ||
      row.actor_id !== principal.actorId ||
      row.actor_kind !== "human"
    )
      throw new ControlPlaneAuthError(401, "invalid_bearer_token", "Application principal is stale or unlinked")
    if (row.user_state === "deleted")
      throw new ControlPlaneAuthError(403, "account_deleted", "Application account is deleted")
    if (row.user_state !== "active" || row.actor_state !== "active") {
      throw new ControlPlaneAuthError(403, "account_suspended", "Application account is suspended")
    }
    return { userId: row.user_id, actorId: row.actor_id, actorKind: "human" }
  }

  private async requireRuntimeActor(input: RuntimeSessionActor): Promise<Principal> {
    const actorId = requireText(input.actorId, "actorId")
    if (
      (input.principalKind !== "user" && input.principalKind !== "service") ||
      (input.actorKind !== "human" && input.actorKind !== "agent") ||
      (input.principalKind === "user" && input.actorKind !== "human") ||
      (input.principalKind === "service" && input.actorKind !== "agent")
    ) {
      throw new D1SessionAuthorityError("invalid_input", "Canonical runtime principal kind is required")
    }
    const row = await this.database
      .prepare(
        `
      select a.actor_id, a.kind as actor_kind, a.state as actor_state,
        a.user_id, u.state as user_state
      from actors a left join users u on u.user_id = a.user_id
      where a.actor_id = ?
    `,
      )
      .bind(actorId)
      .first<ActorRow>()
    if (
      !row ||
      row.actor_kind !== input.actorKind ||
      row.actor_state !== "active" ||
      !row.user_id ||
      row.user_state !== "active"
    ) {
      throw new D1SessionAuthorityError("actor_authorization_denied", "Canonical active session actor is required")
    }
    return { actorId, actorKind: row.actor_kind, userId: row.user_id }
  }

  private async registration(operationId: string) {
    return await this.database
      .prepare(
        `
      select * from session_registration_operations where operation_id = ?
    `,
      )
      .bind(operationId)
      .first<RegistrationRow>()
  }

  private async session(sessionId: string) {
    return await this.database
      .prepare(`select * from sessions where session_id = ?`)
      .bind(sessionId)
      .first<SessionRow>()
  }

  private async turnLease(sessionId: string) {
    return await this.database
      .prepare(`select * from session_turn_leases where session_id = ?`)
      .bind(sessionId)
      .first<TurnLeaseRow>()
  }

  private registrationAssertion(
    assertionId: string,
    intent: ReturnType<typeof normalizeReservation>,
    workspace: WorkspaceAccessRow,
    actorId: string,
    state: SessionRegistrationState,
  ) {
    return this.database
      .prepare(
        `
      insert into authority_batch_assertions (assertion_id, passed)
      values (?, case when exists (
        select 1 from session_registration_operations
        where operation_id = ? and session_id = ? and workspace_id = ? and org_id = ? and project_id = ?
          and creator_actor_id = ? and operation_kind = ? and parent_session_id is ?
          and requested_title is ? and state = ?
      ) then 1 else 0 end)
    `,
      )
      .bind(
        assertionId,
        intent.operationId,
        intent.sessionId,
        workspace.workspace_id,
        workspace.org_id,
        workspace.project_id,
        actorId,
        intent.kind,
        intent.parentSessionId ?? null,
        intent.title ?? null,
        state,
      )
  }

  private deleteAssertion(assertionId: string) {
    return this.database.prepare(`delete from authority_batch_assertions where assertion_id = ?`).bind(assertionId)
  }

  private async guardedBatch(statements: D1PreparedStatement[], message: string) {
    try {
      return await this.database.batch(statements)
    } catch (error) {
      if (
        String(error).includes("authority_batch_assertions.passed") ||
        String(error).includes("CHECK constraint failed")
      ) {
        throw new D1SessionAuthorityError("resource_conflict", message)
      }
      throw error
    }
  }
}

function actorWorkspaceRoleRankSql(actorExpression: string, workspaceAlias: string) {
  return `max(
    case when ${workspaceAlias}.owner_user_id = a.user_id then 4 else 0 end,
    coalesce((select case wm.role when 'viewer' then 1 when 'editor' then 2 when 'admin' then 3 when 'owner' then 4 end
      from workspace_memberships wm
      where wm.workspace_id = ${workspaceAlias}.workspace_id and wm.user_id = a.user_id and wm.revoked_at is null), 0),
    coalesce((select case pm.role when 'viewer' then 1 when 'editor' then 2 when 'admin' then 3 when 'owner' then 4 end
      from project_memberships pm
      where pm.project_id = ${workspaceAlias}.project_id and pm.user_id = a.user_id and pm.revoked_at is null), 0),
    case when o.owner_user_id = a.user_id then 3
      when om.role in ('owner', 'admin') then 3
      when om.role = 'member' then 1 else 0 end
  )`
    .replaceAll("a.user_id", `(select user_id from actors where actor_id = ${actorExpression})`)
    .replaceAll(
      "o.owner_user_id",
      `(select owner_user_id from orgs where org_id = ${workspaceAlias}.org_id and deleted_at is null)`,
    )
    .replaceAll(
      "om.role",
      `(select role from org_memberships where org_id = ${workspaceAlias}.org_id and user_id = (select user_id from actors where actor_id = ${actorExpression}) and revoked_at is null)`,
    )
}

function actorWorkspaceAccessSql(actorExpression: string, workspaceAlias: string, rank: 1 | 2) {
  return `exists (
    select 1 from actors aa join users au on au.user_id = aa.user_id and au.state = 'active'
    where aa.actor_id = ${actorExpression} and aa.state = 'active'
      and exists (
        select 1 from orgs ao
        left join org_memberships aom
          on aom.org_id = ao.org_id and aom.user_id = au.user_id and aom.revoked_at is null
        where ao.org_id = ${workspaceAlias}.org_id and ao.deleted_at is null
          and (ao.owner_user_id = au.user_id or aom.user_id is not null)
      )
      and exists (
        select 1 from projects ap
        where ap.project_id = ${workspaceAlias}.project_id
          and ap.org_id = ${workspaceAlias}.org_id
          and ap.deleted_at is null
      )
      and ${actorWorkspaceRoleRankSql(actorExpression, workspaceAlias)} >= ${rank}
  )`
}

function actorSessionAccessSql(actorExpression: string, sessionAlias: string, rank: 1 | 2) {
  return `exists (
    select 1 from workspaces session_workspace
    where session_workspace.workspace_id = ${sessionAlias}.workspace_id
      and session_workspace.org_id = ${sessionAlias}.org_id
      and session_workspace.project_id = ${sessionAlias}.project_id
      and session_workspace.deleted_at is null
      and ${actorWorkspaceAccessSql(actorExpression, "session_workspace", rank)}
  ) and (
    ${sessionAlias}.creator_actor_id = ${actorExpression}
    or exists (
      select 1 from session_participants sap
      where sap.session_id = ${sessionAlias}.session_id and sap.actor_id = ${actorExpression} and sap.revoked_at is null
    )
    or ${organizationAdministratorSql(actorExpression, `${sessionAlias}.org_id`)}
  )`
}

function participantAdministratorSql(actorExpression: string, sessionAlias: string) {
  return `exists (
    select 1 from workspaces participant_workspace
    where participant_workspace.workspace_id = ${sessionAlias}.workspace_id
      and participant_workspace.org_id = ${sessionAlias}.org_id
      and participant_workspace.project_id = ${sessionAlias}.project_id
      and participant_workspace.deleted_at is null
      and ${actorWorkspaceAccessSql(actorExpression, "participant_workspace", 1)}
  ) and (
    ${sessionAlias}.creator_actor_id = ${actorExpression}
    or ${organizationAdministratorSql(actorExpression, `${sessionAlias}.org_id`)}
  )`
}

function organizationAdministratorSql(actorExpression: string, orgExpression: string) {
  return `exists (
    select 1 from actors oa
    join users ou on ou.user_id = oa.user_id and ou.state = 'active'
    join orgs oo on oo.org_id = ${orgExpression} and oo.deleted_at is null
    left join org_memberships oom
      on oom.org_id = oo.org_id and oom.user_id = ou.user_id and oom.revoked_at is null
    where oa.actor_id = ${actorExpression} and oa.state = 'active'
      and (oo.owner_user_id = ou.user_id or oom.role in ('owner', 'admin'))
  )`
}

function normalizeReservation(input: ReserveSessionInput) {
  const kind = input.kind
  if (kind !== "create" && kind !== "fork")
    throw new D1SessionAuthorityError("invalid_input", "Unknown reservation kind")
  const parentSessionId = optionalText(input.parentSessionId, "parentSessionId")
  if ((kind === "fork") !== !!parentSessionId) {
    throw new D1SessionAuthorityError("invalid_input", "Fork reservations require exactly one parent session")
  }
  return {
    operationId: requireText(input.operationId, "operationId"),
    sessionId: requireText(input.sessionId, "sessionId"),
    workspaceId: requireText(input.workspaceId, "workspaceId"),
    kind,
    parentSessionId,
    title: optionalText(input.title, "title", 2_000),
  }
}

function requireSameRegistration(
  row: RegistrationRow,
  intent: ReturnType<typeof normalizeReservation>,
  workspace: WorkspaceAccessRow,
  actorId: string,
) {
  if (
    row.session_id !== intent.sessionId ||
    row.workspace_id !== workspace.workspace_id ||
    row.org_id !== workspace.org_id ||
    row.project_id !== workspace.project_id ||
    row.creator_actor_id !== actorId ||
    row.operation_kind !== intent.kind ||
    row.parent_session_id !== (intent.parentSessionId ?? null) ||
    row.requested_title !== (intent.title ?? null)
  )
    throw new D1SessionAuthorityError("resource_conflict", "Reservation retry changed immutable intent")
}

function registrationResult(row: RegistrationRow, changed: boolean) {
  return {
    changed,
    operationId: row.operation_id,
    sessionId: row.session_id,
    workspaceId: row.workspace_id,
    state: row.state,
  }
}

function sessionJson(row: SessionRow) {
  return {
    session_id: row.session_id,
    project_id: row.project_id,
    ...(row.title === null ? {} : { title: row.title }),
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function visibilityRows(input: WorkspaceVisibility[]) {
  if (!Array.isArray(input) || input.length > MAX_VISIBILITY_ROWS) {
    throw new D1SessionAuthorityError("invalid_input", `Session visibility accepts at most ${MAX_VISIBILITY_ROWS} rows`)
  }
  const seen = new Set<string>()
  return input.map((value) => {
    const sessionId = requireText(value.sessionId, "sessionId")
    if (seen.has(sessionId))
      throw new D1SessionAuthorityError("invalid_input", "Session visibility contains duplicate identifiers")
    seen.add(sessionId)
    return {
      sessionId,
      title: optionalText(value.title, "title", 2_000),
      createdAt: optionalTimestamp(value.createdAt, "createdAt"),
      updatedAt: optionalTimestamp(value.updatedAt, "updatedAt"),
    }
  })
}

function canonicalMessages(input: unknown[], producerActorId: string): CanonicalMessage[] {
  if (!Array.isArray(input) || input.length > MAX_SNAPSHOT_MESSAGES) {
    throw new D1SessionAuthorityError(
      "invalid_input",
      `Session snapshots accept at most ${MAX_SNAPSHOT_MESSAGES} messages`,
    )
  }
  const ids = new Set<string>()
  return input.map((message, ordinal) => {
    const row = record(message)
    const info = record(row?.info)
    const id = optionalText(
      typeof row?.id === "string" ? row.id : typeof info?.id === "string" ? info.id : undefined,
      "message.id",
    )
    const role = optionalText(
      typeof row?.role === "string" ? row.role : typeof info?.role === "string" ? info.role : undefined,
      "message.role",
      100,
    )
    if (!id || !role)
      throw new D1SessionAuthorityError("invalid_input", "Every session message requires a canonical id and role")
    if (ids.has(id))
      throw new D1SessionAuthorityError("invalid_input", "Session snapshots contain duplicate message identifiers")
    ids.add(id)
    let dataJson: string
    try {
      dataJson = JSON.stringify(message)
    } catch {
      throw new D1SessionAuthorityError("invalid_input", "Session message must be JSON serializable")
    }
    if (dataJson === undefined || byteLength(dataJson) > MAX_MESSAGE_BYTES) {
      throw new D1SessionAuthorityError("invalid_input", `Session message exceeds ${MAX_MESSAGE_BYTES} bytes`)
    }
    const author = record(record(info?.claxedo)?.author)
    const claimedActorId = typeof author?.id === "string" ? author.id.trim() : ""
    return {
      id,
      role,
      ordinal,
      dataJson,
      authorActorId: role === "user" && claimedActorId === producerActorId ? producerActorId : null,
    }
  })
}

function publicMessage(row: MessageRow) {
  const parsed = JSON.parse(row.data_json) as unknown
  const message = record(parsed)
  if (!message) return parsed
  const info = record(message.info) ?? {}
  const claxedo = record(info.claxedo) ?? {}
  const { author: _untrustedAuthor, ...safeClaxedo } = claxedo
  const { claxedo: _untrustedClaxedo, ...safeInfo } = info
  const canonicalClaxedo =
    row.author_actor_id && row.author_kind && (message.role === "user" || info.role === "user")
      ? { ...safeClaxedo, author: { id: row.author_actor_id, kind: row.author_kind } }
      : safeClaxedo
  return {
    ...message,
    info: {
      ...safeInfo,
      ...(Object.keys(canonicalClaxedo).length > 0 ? { claxedo: canonicalClaxedo } : {}),
    },
  }
}

function encodeMessagePageCursor(sessionId: string, ordinal: number) {
  return `${MESSAGE_PAGE_CURSOR_PREFIX}${encodeURIComponent(JSON.stringify({ sessionId, ordinal }))}`
}

function decodeMessagePageCursor(sessionId: string, input: string) {
  try {
    if (!input.startsWith(MESSAGE_PAGE_CURSOR_PREFIX)) throw new Error("unexpected cursor version")
    const value = JSON.parse(decodeURIComponent(input.slice(MESSAGE_PAGE_CURSOR_PREFIX.length))) as {
      sessionId?: unknown
      ordinal?: unknown
    }
    if (value.sessionId !== sessionId || !Number.isSafeInteger(value.ordinal) || (value.ordinal as number) < 0) {
      throw new Error("invalid cursor payload")
    }
    return value.ordinal as number
  } catch {
    throw new AgentMessagePageError(400, "Invalid message page cursor")
  }
}

function rankRole(rank: number): ProjectRole {
  return rank >= 4 ? "owner" : rank >= 3 ? "admin" : rank >= 2 ? "editor" : "viewer"
}

function optionalOrdinal(value: number | undefined) {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new D1SessionAuthorityError("invalid_input", "maxEventOrdinal must be a non-negative safe integer")
  }
  return value
}

function boundedTurnLeaseTtl(value: number | undefined) {
  const ttl = value ?? SESSION_TURN_LEASE_TTL_MS
  if (!Number.isSafeInteger(ttl) || ttl < 5_000 || ttl > 15 * 60_000) {
    throw new TypeError("turnLeaseTtlMs must be an integer between 5000 and 900000")
  }
  return ttl
}

function positiveFence(value: number) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new D1SessionAuthorityError("invalid_input", "fencingToken must be a positive safe integer")
  }
  return value
}

function turnLeaseJson(row: TurnLeaseRow): SessionTurnLease {
  return {
    sessionId: row.session_id,
    workspaceId: row.workspace_id,
    turnId: row.turn_id,
    leaseId: row.lease_id,
    fencingToken: row.fencing_token,
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at,
  }
}

function optionalTimestamp(value: number | undefined, name: string) {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || value < 0)
    throw new D1SessionAuthorityError("invalid_input", `${name} is invalid`)
  return value
}

function optionalText(value: string | undefined, name: string, max = 512) {
  if (value === undefined) return undefined
  return requireText(value, name, max)
}

function requireText(value: string, name: string, max = 512) {
  const result = value.trim()
  if (!result || result.length > max) {
    throw new D1SessionAuthorityError(
      "invalid_input",
      `${name} must be a non-empty string of at most ${max} characters`,
    )
  }
  return result
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function denied(message = "Session authorization was denied") {
  return new ControlPlaneAuthError(403, "workspace_authorization_denied", message)
}

function isDenied(error: unknown) {
  return error instanceof ControlPlaneAuthError && error.status === 403
}

function byteLength(value: string) {
  return new TextEncoder().encode(value).byteLength
}

async function sha256(value: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

function repeat<T>(value: T, count: number) {
  return Array.from({ length: count }, () => value)
}
