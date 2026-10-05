import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types"
import { ControlPlaneAuthError, type SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { WorkspaceAuthority, WorkspaceVisibility } from "@claxedo/server-core/platform/auth/authority"
import {
  SESSION_ADOPTION_OPERATION_PREFIX,
  sessionAccessQuestion,
  sessionAdoptionOperationId,
  type AuthorizeRuntimeSessionStartInput,
  type PrivateSessionActor,
  type PrivateSessionAuthority,
  type PrivateSessionRegistrationState,
  type PrivateSessionRuntimePrincipal,
  type ReservePrivateSessionInput,
  type SessionAccessQuestion,
  type SessionPageQuery,
  type SessionWriteClass,
  type TransitionPrivateSessionRegistrationInput,
  requireRuntimeSessionTime,
  requireRuntimeSessionTimes,
} from "@claxedo/server-core/platform/auth/private-session-authority"
import {
  SESSION_TURN_AUTHORITY_METHODS,
  SessionTurnConflictError,
  SessionTurnGrantError,
  SessionTurnLeaseLostError,
  normalizeGrantSessionTurnInput,
  sessionTurnGrantRefusal,
  type AcquireSessionTurnInput,
  type GrantSessionTurnInput,
  type OwnedSessionTurnInput,
  type RevokeSessionTurnGrantsInput,
  type SessionTurnAuthority,
  type SessionTurnGrant,
  type SessionTurnLease,
} from "@claxedo/server-core/platform/auth/session-turn-authority"
import { SESSION_TURN_LEASE_TTL_MS } from "@claxedo/workspace-relay-protocol"
import { sha256Hex } from "@claxedo/helpers/crypto"
import { maySql, type AuthorizationPrincipal, type SessionAction, type WorkspaceAction } from "./authorization"
import { requireHuman } from "./access-context"
import {
  D1SessionAuthorityError,
  MAX_SNAPSHOT_BYTES,
  byteLength,
  normalizeReservation,
  requireSameRegistration,
  type ReservationIntent,
  canonicalMessages,
  optionalOrdinal,
  optionalText,
  positiveFence,
  requireText,
  visibilityRows,
} from "./session-input"
import { D1SessionShares } from "./session-shares"
import { readD1SessionPage, readD1MessagePage, readD1LatestView, validateD1MessageRead, decodeMessagePageCursor } from "./session-read-store"
import { storedTurn, type LatestView } from "@claxedo/server-core/session/latest-view-page"
import { d1ConstraintFailure } from "../../../platform/db/d1-constraint"
import { readStoredTurnOutline } from "@claxedo/server-core/session/turn-outline"
import { readStoredPart } from "@claxedo/server-core/session/stored-part"
import type { StoredMessageQuery } from "@claxedo/server-core/session/stored-messages"
import { sessionPlacement } from "@claxedo/server-core/session/session-placement"
import { readFirstRead, readTurnPage, type TurnPageQuery, type TurnPageRequest, type TurnRead } from "@claxedo/agent-runtime-contract"
import {
  registrationResult,
  sessionJson,
  turnGrantJson,
  turnLeaseJson,
  type ActorRow,
  type RegistrationRow,
  type SessionRow,
  type TurnGrantRow,
  type TurnLeaseRow,
  type WorkspaceAccessRow,
} from "./session-rows"
import { SESSION_STATUS_STAMP_SQL, sessionStatusStampBindings } from "./session-status-notices"

export const D1_SESSION_AUTHORITY_METHODS = [
  "authorizeSessionRead",
  "grantSessionShare",
  "revokeSessionShare",
  "listSessionShares",
  "listSessions",
  "resolveSession",
  "resolveCloudTurnUsageOwner",
  "readSessionMessages",
  "readSessionFirstRead",
  "readSessionPage",
  "readSessionPart",
  "syncSessionMessages",
  "upsertSessionVisibility",
  "replaceSessionVisibility",
] as const satisfies readonly (keyof WorkspaceAuthority)[]

export const D1_SESSION_TURN_AUTHORITY_METHODS = SESSION_TURN_AUTHORITY_METHODS

export type D1SessionAuthorityPort = Pick<WorkspaceAuthority, (typeof D1_SESSION_AUTHORITY_METHODS)[number]>

export type D1SessionAuthorityOptions = {
  deploymentId: string
  now?: () => number
  randomId?: (prefix: "assert" | "snapshot" | "turn" | "share" | "grant") => string
  turnLeaseTtlMs?: number
}

export type SessionRegistrationState = PrivateSessionRegistrationState
export type ReserveSessionInput = ReservePrivateSessionInput
export type RuntimeSessionActor = PrivateSessionRuntimePrincipal

type Principal = PrivateSessionActor & AuthorizationPrincipal & { userId: string }

type ReadableSession = SessionRow & { role: "owner" | "viewer" }

/**
 * D1 private-session capability. Unknown transcripts never create sessions:
 * callers must reserve an immutable create/fork intent and the runtime must
 * register that exact reservation before visibility or message writes begin.
 */
export class D1SessionAuthority implements D1SessionAuthorityPort, PrivateSessionAuthority, SessionTurnAuthority {
  private readonly now: () => number
  private readonly randomId: NonNullable<D1SessionAuthorityOptions["randomId"]>
  private readonly turnLeaseTtlMs: number

  private readonly shares: D1SessionShares

  constructor(
    private readonly database: D1Database,
    private readonly options: D1SessionAuthorityOptions,
  ) {
    requireText(options.deploymentId, "deploymentId")
    this.now = options.now ?? Date.now
    this.randomId = options.randomId ?? ((prefix) => `${prefix}_${crypto.randomUUID()}`)
    this.turnLeaseTtlMs = boundedTurnLeaseTtl(options.turnLeaseTtlMs)
    this.shares = new D1SessionShares({
      database, now: this.now, randomId: this.randomId,
      requirePrincipal: (auth) => this.requirePrincipal(auth),
      requireSessionReader: (actor, sessionId, workspaceId) => this.requireSessionAccess({ ...actor, actorKind: "human" }, sessionId, workspaceId, "read"),
      guardedBatch: (statements, message) => this.guardedBatch(statements, message),
      deleteAssertion: (assertionId) => this.deleteAssertion(assertionId),
    })
  }

  grantSessionShare(...args: Parameters<D1SessionShares["grantSessionShare"]>) { return this.shares.grantSessionShare(...args) }

  revokeSessionShare(...args: Parameters<D1SessionShares["revokeSessionShare"]>) { return this.shares.revokeSessionShare(...args) }

  listSessionShares(...args: Parameters<D1SessionShares["listSessionShares"]>) { return this.shares.listSessionShares(...args) }

  async reserveSession(auth: SignedControlPlaneAuth, input: ReserveSessionInput) {
    return this.reserveForActor(await this.requirePrincipal(auth), input)
  }

  async reserveRuntimeSession(principal: PrivateSessionRuntimePrincipal, input: ReserveSessionInput) {
    return this.reserveForActor(await this.requireRuntimeActor(principal), input)
  }

  private async reserveForActor(who: Principal, input: ReserveSessionInput) {
    const intent = normalizeReservation(input)
    const workspace = await this.requireWorkspace(who, intent.workspaceId, "create_session")
    if (intent.kind === "fork") {
      await this.requireSessionAccess(who, intent.parentSessionId!, intent.workspaceId, "agent_turn")
    }
    const creates = maySql(who, "create_session", { kind: "workspace", alias: "w" })
    const parentSends = maySql(who, "send", { kind: "session", alias: "parent" })

    const sessionHostRoot = intent.kind === "create" && sessionPlacement({ backing: workspace.backing, harnessId: intent.harnessId ?? "" }) === "durable-object"
      ? intent.sessionId
      : null
    const existing = await this.registration(intent.operationId)
    if (existing && existing.state !== "compensated") {
      requireSameRegistration(existing, { ...intent, sessionHostRoot }, workspace, who.actorId)
      return registrationResult(existing, false)
    }

    const now = this.now()
    const assertionId = this.randomId("assert")
    await this.guardedBatch(
      [
        // The batch is one transaction, so an insert the assertion refuses
        // takes this release of a compensated row back with it.
        this.database
          .prepare(
            `
        delete from session_registration_operations
        where state = 'compensated' and (session_id = ? or operation_id = ?)
      `,
          )
          .bind(intent.sessionId, intent.operationId),
        this.database
          .prepare(
            `
        insert into session_registration_operations (
          operation_id, session_id, workspace_id, org_id, project_id, creator_actor_id,
          operation_kind, parent_session_id, requested_title, state, state_reason, created_at, updated_at, session_host_root
        )
        select ?, ?, w.workspace_id, w.org_id, w.project_id, ?, ?, ?, ?, 'reserved', null, ?, ?, ?
        from workspaces w
        where w.workspace_id = ? and w.org_id = ? and w.project_id = ? and w.deleted_at is null
          and ${creates.sql}
          and (? = 'create' or exists (
            select 1 from sessions parent
            where parent.session_id = ? and parent.workspace_id = w.workspace_id and parent.deleted_at is null
              and ${parentSends.sql}
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
            sessionHostRoot,
            workspace.workspace_id,
            workspace.org_id,
            workspace.project_id,
            ...creates.bind,
            intent.kind,
            intent.parentSessionId ?? null,
            ...parentSends.bind,
          ),
        this.registrationAssertion(assertionId, { ...intent, sessionHostRoot }, workspace, who.actorId, "reserved"),
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
      createdAt: number
      updatedAt: number
      sessionHostRoot?: string
    },
  ) {
    const actor = await this.requireRuntimeActor(input)
    const operationId = requireText(input.operationId, "operationId")
    const sessionId = requireText(input.sessionId, "sessionId")
    const workspaceId = requireText(input.workspaceId, "workspaceId")
    const title = optionalText(input.title, "title", 2_000)
    const times = requireRuntimeSessionTimes(input, (message) => new D1SessionAuthorityError("invalid_input", message))
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
    if ((optionalText(input.sessionHostRoot, "sessionHostRoot") ?? null) !== result.session_host_root) {
      throw new D1SessionAuthorityError("registration_transition_denied", "The session is placed in another host")
    }
    return await this.registerReservation(actor, result, times)
  }

  /**
   * Registers a session the host already holds, for the owner of the
   * enrollment that serves the workspace there.
   *
   * No reservation preceded it: the transcript existed on the machine before
   * remote access was turned on, so there is no intent row to match and the
   * creator cannot come from the request. It comes from
   * `host_workspace_assignments`, and only that owner is admitted, so a member
   * who reaches the machine cannot register another person's transcript as
   * their own. Both writes carry the same access predicates the ordinary
   * reservation and registration carry.
   */
  async adoptRuntimeSession(
    input: RuntimeSessionActor & {
      sessionId: string
      workspaceId: string
      hostId: string
      title?: string
      createdAt: number
      updatedAt: number
    },
  ) {
    const actor = await this.requireRuntimeActor(input)
    const sessionId = requireText(input.sessionId, "sessionId", 512 - SESSION_ADOPTION_OPERATION_PREFIX.length)
    const workspaceId = requireText(input.workspaceId, "workspaceId")
    const hostId = requireText(input.hostId, "hostId")
    const title = optionalText(input.title, "title", 2_000)
    const times = requireRuntimeSessionTimes(input, (message) => new D1SessionAuthorityError("invalid_input", message))
    const operationId = sessionAdoptionOperationId(sessionId)
    const workspace = await this.requireWorkspace(actor, workspaceId, "create_session")
    const assignment = await this.database
      .prepare(`select owner_actor_id from host_workspace_assignments where workspace_id = ? and host_id = ?`)
      .bind(workspaceId, hostId)
      .first<{ owner_actor_id: string }>()
    if (!assignment || assignment.owner_actor_id !== actor.actorId) {
      throw denied("Session adoption is reserved to the owner of the enrollment serving this workspace")
    }
    const existing = await this.session(sessionId)
    if (existing) {
      if (
        existing.workspace_id !== workspaceId ||
        existing.deleted_at !== null ||
        existing.creator_actor_id !== actor.actorId
      ) {
        throw denied("Session is already registered to another creator")
      }
      return { adopted: false }
    }
    const now = this.now()
    const assertionId = this.randomId("assert")
    const creates = maySql(actor, "create_session", { kind: "workspace", alias: "w" })
    const sends = maySql(actor, "send", { kind: "session", alias: "s" })
    await this.guardedBatch(
      [
        this.database
          .prepare(`delete from session_registration_operations where session_id = ? and state = 'compensated'`)
          .bind(sessionId),
        this.database
          .prepare(
            `
        insert into session_registration_operations (
          operation_id, session_id, workspace_id, org_id, project_id, creator_actor_id,
          operation_kind, parent_session_id, requested_title, state, state_reason, created_at, updated_at
        )
        select ?, ?, w.workspace_id, w.org_id, w.project_id, ?, 'create', null, ?, 'registered', null, ?, ?
        from workspaces w
        where w.workspace_id = ? and w.org_id = ? and w.project_id = ? and w.deleted_at is null
          and ${creates.sql}
          and exists (
            select 1 from host_workspace_assignments assignment
            where assignment.workspace_id = w.workspace_id and assignment.host_id = ? and assignment.owner_actor_id = ?
          )
        on conflict do nothing
      `,
          )
          .bind(
            operationId,
            sessionId,
            actor.actorId,
            title ?? null,
            now,
            now,
            workspace.workspace_id,
            workspace.org_id,
            workspace.project_id,
            ...creates.bind,
            hostId,
            actor.actorId,
          ),
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
          .bind(times.createdAt, times.updatedAt, operationId, actor.actorId),
        this.database
          .prepare(
            `
        insert into authority_batch_assertions (assertion_id, passed)
        values (?, case when exists (
          select 1 from session_registration_operations r
          join sessions s on s.operation_id = r.operation_id and s.session_id = r.session_id
          where r.operation_id = ? and r.state = 'registered' and s.creator_actor_id = ?
            and s.deleted_at is null
            and ${sends.sql}
        ) then 1 else 0 end)
      `,
          )
          .bind(assertionId, operationId, actor.actorId, ...sends.bind),
        this.deleteAssertion(assertionId),
      ],
      "Session adoption collided with an existing registration or an authority change",
    )
    return { adopted: true }
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
      "agent_turn",
    )
  }

  async authorizeRuntimeSessionStart(input: AuthorizeRuntimeSessionStartInput): Promise<void> {
    const actor = await this.requireRuntimeActor(input)
    const workspaceId = requireText(input.workspaceId, "workspaceId")
    const sessionId = requireText(input.sessionId, "sessionId")
    const operationId = requireText(input.registrationOperationId, "registrationOperationId")
    await this.requireWorkspace(actor, workspaceId, "create_session")
    const row = await this.registration(operationId)
    if (!row || row.workspace_id !== workspaceId || row.session_id !== sessionId || row.creator_actor_id !== actor.actorId) {
      throw denied("A matching live creator reservation is required")
    }
    if (row.state === "compensated") {
      throw new D1SessionAuthorityError("session_reservation_spent", "This session's create was undone; reserve it again to retry")
    }
    if (row.state !== "reserved" && row.state !== "reconciliation_required") throw denied("A matching live creator reservation is required")
    if (row.operation_kind === "fork") {
      await this.requireSessionAccess(actor, row.parent_session_id!, workspaceId, "agent_turn")
    }
  }

  async authorizeRuntimeSessionStartStatus(input: AuthorizeRuntimeSessionStartInput): Promise<void> {
    const actor = await this.requireRuntimeActor(input)
    const workspaceId = requireText(input.workspaceId, "workspaceId")
    const sessionId = requireText(input.sessionId, "sessionId")
    const operationId = requireText(input.registrationOperationId, "registrationOperationId")
    await this.requireWorkspace(actor, workspaceId, "open")
    const row = await this.registration(operationId)
    if (!row || row.workspace_id !== workspaceId || row.session_id !== sessionId
      || row.creator_actor_id !== actor.actorId) {
      throw denied("A matching creator reservation is required")
    }
  }

  async authorizeRuntimeSession(
    input: RuntimeSessionActor & {
      sessionId: string
      workspaceId: string
      action: "read" | "write"
      writeClass?: SessionWriteClass
    },
  ) {
    const actor = await this.requireRuntimeActor(input)
    await this.requireSessionAccess(
      actor,
      requireText(input.sessionId, "sessionId"),
      requireText(input.workspaceId, "workspaceId"),
      sessionAccessQuestion(input),
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
    const grantId = optionalText(input.grantId, "grantId")
    await this.requireSessionAccess(actor, sessionId, workspaceId, "agent_turn")
    const now = this.now()
    const expiresAt = now + this.turnLeaseTtlMs
    const leaseId = this.randomId("turn")
    const admission = { actor, sessionId, workspaceId, turnId, leaseId, now, expiresAt }
    if (grantId === undefined) await this.turnLeaseInsert(admission).run()
    else await this.redeemTurnGrant(admission, grantId)
    const row = await this.turnLease(sessionId)
    if (
      row
      && row.workspace_id === workspaceId
      && row.turn_id === turnId
      && row.actor_id === actor.actorId
      && row.released_at === null
      && row.expires_at > now
    ) {
      await this.stampAdmittedStatus(sessionId, workspaceId, row.acquired_at)
      return turnLeaseJson(row)
    }

    // Recheck after the conditional write so a current denial never leaks the
    // competing turn's expiry. Only an authorized contender gets a 409.
    await this.requireSessionAccess(actor, sessionId, workspaceId, "agent_turn")
    throw new SessionTurnConflictError(sessionId, row?.expires_at)
  }

  /**
   * The lease insert both request-driven and grant-redeemed turns share. A
   * live lease for the same turn and actor leaves the row untouched, which is
   * what makes an exact retry idempotent; only release or expiry lets the
   * `on conflict` branch replace it, advancing the fence in the same statement.
   * With `grant`, the row is written only while the grant still admits this
   * turn: unrevoked, unexpired, covering the turn id, and either unredeemed
   * or redeemed for exactly this turn while that lease is still live.
   */
  private turnLeaseInsert(
    input: TurnAdmission,
    grant?: { grantId: string },
  ) {
    const grantGuard = grant === undefined
      ? ""
      : `and exists (
          select 1 from session_turn_grants g
          where g.grant_id = ? and g.session_id = s.session_id and g.workspace_id = s.workspace_id
            and g.actor_id = ? and g.revoked_at is null and g.expires_at > ?
            and (g.turn_id = ? or (g.turn_id_prefix is not null and substr(?, 1, length(g.turn_id_prefix)) = g.turn_id_prefix))
            and (g.redeemed_at is null or (g.redeemed_turn_id = ? and exists (
              select 1 from session_turn_leases live
              where live.session_id = g.session_id and live.turn_id = ? and live.actor_id = g.actor_id
                and live.released_at is null and live.expires_at > ?
            )))
        )`
    const grantBindings = grant === undefined
      ? []
      : [grant.grantId, input.actor.actorId, input.now, input.turnId, input.turnId, input.turnId, input.turnId, input.now]
    const sends = maySql(input.actor, "send", { kind: "session", alias: "s" })
    return this.database
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
        and ${sends.sql}
        ${grantGuard}
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
        input.turnId,
        input.leaseId,
        input.actor.actorId,
        input.now,
        input.expiresAt,
        input.sessionId,
        input.workspaceId,
        ...sends.bind,
        ...grantBindings,
        input.now,
      )
  }

  /**
   * Lease insert and grant redemption in one batch: the grant is marked
   * redeemed only when the lease row now carries this batch's own `leaseId`,
   * and the batch holds only when the lease is live for this turn and actor
   * and the grant records this turn. A grant already redeemed for this turn
   * therefore admits its live retry without a second write. A rejected batch
   * is named by re-reading the grant afterwards; when the grant itself still
   * admits the turn, the caller's post-read tells share loss from a competing
   * turn the way a request-driven acquire does.
   */
  private async redeemTurnGrant(input: TurnAdmission, grantId: string) {
    const assertionId = this.randomId("assert")
    try {
      await this.guardedBatch(
        [
          this.turnLeaseInsert(input, { grantId }),
          this.database
            .prepare(
              `
          update session_turn_grants set redeemed_at = ?, redeemed_turn_id = ?
          where grant_id = ? and redeemed_at is null and exists (
            select 1 from session_turn_leases l
            where l.session_id = ? and l.workspace_id = ? and l.turn_id = ? and l.lease_id = ? and l.released_at is null
          )
        `,
            )
            .bind(input.now, input.turnId, grantId, input.sessionId, input.workspaceId, input.turnId, input.leaseId),
          this.database
            .prepare(
              `
          insert into authority_batch_assertions (assertion_id, passed)
          values (?, case when exists (
            select 1 from session_turn_leases l
            join session_turn_grants g on g.grant_id = ?
            where l.session_id = ? and l.workspace_id = ? and l.turn_id = ? and l.actor_id = ?
              and l.released_at is null and l.expires_at > ?
              and g.actor_id = l.actor_id and g.redeemed_at is not null and g.redeemed_turn_id = l.turn_id
          ) then 1 else 0 end)
        `,
            )
            .bind(assertionId, grantId, input.sessionId, input.workspaceId, input.turnId, input.actor.actorId, input.now),
          this.deleteAssertion(assertionId),
        ],
        "Session turn grant redemption was refused",
      )
    } catch (error) {
      if (!(error instanceof D1SessionAuthorityError && error.code === "resource_conflict")) throw error
      const lease = await this.turnLease(input.sessionId)
      const live = lease && lease.released_at === null && lease.expires_at > input.now
        ? { turnId: lease.turn_id, actorId: lease.actor_id }
        : undefined
      const refusal = sessionTurnGrantRefusal(
        turnGrantJson(await this.turnGrant(grantId)),
        { actorId: input.actor.actorId, sessionId: input.sessionId, workspaceId: input.workspaceId, turnId: input.turnId, now: input.now },
        live,
      )
      if (refusal) throw refusal
    }
  }

  async grantSessionTurn(input: GrantSessionTurnInput): Promise<SessionTurnGrant> {
    const actor = await this.requireRuntimeActor(input)
    const sessionId = requireText(input.sessionId, "sessionId")
    const workspaceId = requireText(input.workspaceId, "workspaceId")
    const grant = normalizeGrantSessionTurnInput(input)
    await this.requireSessionAccess(actor, sessionId, workspaceId, "agent_turn")
    const now = this.now()
    const grantId = this.randomId("grant")
    const sends = maySql(actor, "send", { kind: "session", alias: "s" })
    await this.database
      .prepare(
        `
      insert into session_turn_grants (
        grant_id, session_id, workspace_id, org_id, project_id, actor_id, intent,
        subject_session_id, turn_id, turn_id_prefix, issued_at, expires_at
      )
      select ?, s.session_id, s.workspace_id, s.org_id, s.project_id, ?, ?, ?, ?, ?, ?, ?
      from sessions s
      where s.session_id = ? and s.workspace_id = ? and s.deleted_at is null
        and ${sends.sql}
        and (? is null or exists (
          select 1 from session_registration_operations r
          where r.operation_id = ? and r.session_id = ? and r.parent_session_id = s.session_id
            and r.workspace_id = s.workspace_id and r.creator_actor_id = ?
            and r.state not in ('compensation_pending', 'compensated')
        ))
    `,
      )
      .bind(
        grantId,
        actor.actorId,
        grant.intent,
        grant.subjectSessionId ?? null,
        grant.turnId ?? null,
        grant.turnIdPrefix ?? null,
        now,
        now + grant.ttlMs,
        sessionId,
        workspaceId,
        ...sends.bind,
        grant.registrationOperationId ?? null,
        grant.registrationOperationId ?? null,
        grant.subjectSessionId ?? null,
        actor.actorId,
      )
      .run()
    const row = await this.turnGrant(grantId)
    if (row) return turnGrantJson(row)
    await this.requireSessionAccess(actor, sessionId, workspaceId, "agent_turn")
    throw new SessionTurnGrantError("session_turn_grant_mismatch", "Child registration does not name this parent and creator")
  }

  async revokeSessionTurnGrants(input: RevokeSessionTurnGrantsInput) {
    const sessionId = optionalText(input.sessionId, "sessionId")
    const subjectSessionId = optionalText(input.subjectSessionId, "subjectSessionId")
    const reason = requireText(input.reason, "reason")
    if (sessionId === undefined && subjectSessionId === undefined) {
      throw new D1SessionAuthorityError("invalid_input", "sessionId or subjectSessionId is required")
    }
    const result = await this.database
      .prepare(
        `
      update session_turn_grants set revoked_at = ?, revoke_reason = ?
      where revoked_at is null and (session_id = ? or subject_session_id = ?)
    `,
      )
      .bind(this.now(), reason, sessionId ?? null, subjectSessionId ?? null)
      .run()
    return { revoked: result.meta.changes }
  }

  /**
   * An admitted turn marks its session busy for a list nobody is watching. The
   * lease's own admission time makes an exact retry idempotent, and the stamp
   * yields to a newer status a runtime reported. The runtime stays the one
   * writer of the session's last human turn.
   */
  private async stampAdmittedStatus(sessionId: string, workspaceId: string, admittedAt: number) {
    await this.database
      .prepare(
        `
      update sessions set ${SESSION_STATUS_STAMP_SQL}
      where session_id = ? and workspace_id = ? and deleted_at is null
    `,
      )
      .bind(...sessionStatusStampBindings("busy", admittedAt), sessionId, workspaceId)
      .run()
  }

  async renewSessionTurn(input: OwnedSessionTurnInput): Promise<SessionTurnLease> {
    const actor = await this.requireRuntimeActor(input)
    const sessionId = requireText(input.sessionId, "sessionId")
    const workspaceId = requireText(input.workspaceId, "workspaceId")
    const turnId = requireText(input.turnId, "turnId", 512)
    const leaseId = requireText(input.leaseId, "leaseId", 512)
    const fencingToken = positiveFence(input.fencingToken)
    await this.requireSessionAccess(actor, sessionId, workspaceId, "agent_turn")
    const now = this.now()
    const expiresAt = now + this.turnLeaseTtlMs
    const sends = maySql(actor, "send", { kind: "session", alias: "s" })
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
            and ${sends.sql}
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
        ...sends.bind,
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
    const released = Boolean(
      row
      && row.workspace_id === workspaceId
      && row.turn_id === turnId
      && row.lease_id === leaseId
      && row.fencing_token === fencingToken
      && row.actor_id === actor.actorId
      && row.released_at !== null
    )
    if (released) {
      await this.database
        .prepare(`update sessions set ${SESSION_STATUS_STAMP_SQL} where session_id = ? and workspace_id = ? and deleted_at is null`)
        .bind(...sessionStatusStampBindings("idle", row!.released_at!), sessionId, workspaceId)
        .run()
    }
    return { released, sessionId, turnId, fencingToken }
  }

  async listSessions(auth: SignedControlPlaneAuth, args: { workspaceId: string }) {
    const who = await this.requirePrincipal(auth)
    const workspaceId = requireText(args.workspaceId, "workspaceId")
    const reads = maySql(who, "read", { kind: "session", alias: "s" })
    const result = await this.database
      .prepare(
        `
      select s.* from sessions s
      where s.workspace_id = ? and s.deleted_at is null
        and ${reads.sql}
      order by s.updated_at desc, s.session_id
    `,
      )
      .bind(workspaceId, ...reads.bind)
      .all<SessionRow>()
    return result.results.map(sessionJson)
  }

  async listSessionPage(auth: SignedControlPlaneAuth, query: SessionPageQuery) {
    const who = await this.requirePrincipal(auth)
    return await readD1SessionPage(this.database, query, maySql(who, "read", { kind: "session", alias: "s" }), who.userId, this.now())
  }

  async listOwnerSessionPage(owner: { userId: string; actorId: string }, query: SessionPageQuery) {
    return await readD1SessionPage(this.database, query, maySql(owner, "read", { kind: "session", alias: "s" }), owner.userId, this.now())
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

  async resolveCloudTurnUsageOwner(args: { sessionId: string; turnId: string }) {
    const sessionId = requireText(args.sessionId, "sessionId")
    const turnId = requireText(args.turnId, "turnId")
    // An agent actor has no account, and a deleted workspace answers for no
    // one: either leaves the usage unowned rather than guessed.
    const turn = await this.database.prepare(`
      select source.org_id, actor.user_id from session_turn_producers source
      join actors actor on actor.actor_id = source.actor_id and actor.user_id is not null
      join workspaces workspace on workspace.workspace_id = source.workspace_id
        and workspace.deleted_at is null and workspace.backing = 'cloud-vm'
      where source.session_id = ? and source.turn_id = ?
    `).bind(sessionId, turnId).first<{ org_id: string; user_id: string }>()
    return turn ?? undefined
  }

  async readSessionMessages(
    auth: SignedControlPlaneAuth,
    args: { sessionId: string; workspaceId: string; limit?: number; before?: string; view?: LatestView },
  ) {
    const who = await this.requirePrincipal(auth)
    const sessionId = requireText(args.sessionId, "sessionId")
    const workspaceId = requireText(args.workspaceId, "workspaceId")
    const before = validateD1MessageRead({ ...args, sessionId, workspaceId })
    let access: ReadableSession
    try {
      access = await this.requireSessionAccess(who, sessionId, workspaceId, "read")
    } catch (error) {
      if (isDenied(error)) return { allowed: false, messages: [] }
      throw error
    }
    return {
      allowed: true,
      role: access.role,
      maxEventOrdinal: access.max_event_ordinal,
      ...await readD1MessagePage(this.database, { ...args, sessionId, workspaceId }, before),
    }
  }

  async readSessionFirstRead(auth: SignedControlPlaneAuth, args: { sessionId: string; workspaceId: string; firstPage?: TurnPageRequest }) {
    const sessionId = requireText(args.sessionId, "sessionId")
    const workspaceId = requireText(args.workspaceId, "workspaceId")
    const access = await this.readableSession(auth, sessionId, workspaceId)
    if (!access) return undefined
    const outline = await readStoredTurnOutline(this.storedQuery, "data_json", sessionId, workspaceId)
    return await readFirstRead(sessionJson(access), outline, this.turnRead(sessionId, workspaceId), args.firstPage)
  }

  async readSessionPage(auth: SignedControlPlaneAuth, args: { sessionId: string; workspaceId: string; page: TurnPageQuery & { before: string } }) {
    const sessionId = requireText(args.sessionId, "sessionId")
    const workspaceId = requireText(args.workspaceId, "workspaceId")
    if (!(await this.readableSession(auth, sessionId, workspaceId))) return undefined
    return await readTurnPage(this.turnRead(sessionId, workspaceId), args.page)
  }

  async readSessionPart(auth: SignedControlPlaneAuth, args: { sessionId: string; workspaceId: string; messageId: string; partId: string }) {
    const at = {
      sessionId: requireText(args.sessionId, "sessionId"),
      workspaceId: requireText(args.workspaceId, "workspaceId"),
      messageId: requireText(args.messageId, "messageId"),
      partId: requireText(args.partId, "partId"),
    }
    if (!(await this.readableSession(auth, at.sessionId, at.workspaceId))) return undefined
    const part = await readStoredPart(this.storedQuery, "data_json", at)
    return part ? { part } : {}
  }

  private async readableSession(auth: SignedControlPlaneAuth, sessionId: string, workspaceId: string) {
    const who = await this.requirePrincipal(auth)
    try {
      return await this.requireSessionAccess(who, sessionId, workspaceId, "read")
    } catch (error) {
      if (isDenied(error)) return undefined
      throw error
    }
  }

  private readonly storedQuery: StoredMessageQuery = async <Row,>(sql: string, params: readonly (string | number)[]) => (await this.database.prepare(sql).bind(...params).all<Row>()).results

  private turnRead(sessionId: string, workspaceId: string): TurnRead {
    return async (before) =>
      storedTurn(await readD1LatestView(this.database, sessionId, workspaceId, "latest-turn", before === undefined ? undefined : decodeMessagePageCursor(sessionId, before)))
  }

  async syncSessionMessages(
    auth: SignedControlPlaneAuth,
    args: {
      sessionId: string
      workspaceId: string
      messages: unknown[]
      maxEventOrdinal?: number
      fencingToken?: number
      updatedAt: number
    },
  ) {
    const who = await this.requirePrincipal(auth)
    const sessionId = requireText(args.sessionId, "sessionId")
    const workspaceId = requireText(args.workspaceId, "workspaceId")
    const updatedAt = requireRuntimeSessionTime(args.updatedAt, "updatedAt", (message) => new D1SessionAuthorityError("invalid_input", message))
    await this.requireSessionAccess(who, sessionId, workspaceId, "agent_turn")
    const maxEventOrdinal = optionalOrdinal(args.maxEventOrdinal)
    const messages = canonicalMessages(args.messages)
    const hasUserMessages = messages.some((message) => message.role === "user")
    const fencingToken = args.fencingToken === undefined ? undefined : positiveFence(args.fencingToken)
    if (hasUserMessages && fencingToken === undefined) {
      throw new D1SessionAuthorityError("invalid_input", "Session snapshots with user messages require a fencing token")
    }
    const snapshotJson = JSON.stringify(messages)
    if (byteLength(snapshotJson) > MAX_SNAPSHOT_BYTES) {
      throw new D1SessionAuthorityError("invalid_input", `Session snapshot exceeds ${MAX_SNAPSHOT_BYTES} bytes`)
    }
    const snapshotHash = await sha256Hex(snapshotJson)
    const current = await this.session(sessionId)
    if (!current || current.workspace_id !== workspaceId || current.deleted_at !== null) throw denied()
    if (fencingToken !== undefined) {
      const lease = await this.turnLease(sessionId)
      if (!lease || lease.workspace_id !== workspaceId || lease.fencing_token !== fencingToken) {
        throw new D1SessionAuthorityError("resource_conflict", "Session snapshot fencing token is stale")
      }
    }
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
    const updateFenceGuard = fencingToken === undefined
      ? "1 = 1"
      : "exists (select 1 from session_turn_leases l where l.session_id = sessions.session_id and l.workspace_id = sessions.workspace_id and l.fencing_token = ?)"
    const assertionFenceGuard = fencingToken === undefined
      ? "1 = 1"
      : "exists (select 1 from session_turn_leases l where l.session_id = s.session_id and l.workspace_id = s.workspace_id and l.fencing_token = ?)"
    const fenceBindings = fencingToken === undefined ? [] : [fencingToken]
    const sendsHere = maySql(who, "send", { kind: "session", alias: "sessions" })
    const sends = maySql(who, "send", { kind: "session", alias: "s" })
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
            updated_at = max(updated_at, ?)
          where session_id = ? and workspace_id = ? and deleted_at is null
            and ${eventGuard}
            and ${updateFenceGuard}
            and ${sendsHere.sql}
        `,
            )
            .bind(
              snapshotHash,
              snapshotToken,
              maxEventOrdinal ?? null,
              updatedAt,
              sessionId,
              workspaceId,
              ...eventBindings,
              ...fenceBindings,
              ...sendsHere.bind,
            ),
          this.database
            .prepare(
              `
          insert into session_messages (
            session_id, workspace_id, org_id, project_id, message_id, author_actor_id,
            role, ordinal, turn_id, data_json, snapshot_generation, created_at, updated_at
          )
          select s.session_id, s.workspace_id, s.org_id, s.project_id,
            json_extract(j.value, '$.id'),
            case when json_extract(j.value, '$.role') = 'user' then (
              select p.actor_id from session_turn_producers p
              where p.session_id = s.session_id
                and p.workspace_id = s.workspace_id
                and p.turn_id = json_extract(j.value, '$.id')
            ) else null end,
            json_extract(j.value, '$.role'),
            json_extract(j.value, '$.ordinal'),
            json_extract(j.value, '$.turnId'),
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
            turn_id = excluded.turn_id,
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
              and ${assertionFenceGuard}
              and ${sends.sql}
              and not exists (
                select 1 from session_messages m
                where m.session_id = s.session_id
                  and m.snapshot_generation = s.snapshot_generation
                  and m.role = 'user' and m.author_actor_id is null
              )
          ) then 1 else 0 end)
        `,
            )
            .bind(
              assertionId,
              sessionId,
              workspaceId,
              snapshotToken,
              snapshotHash,
              ...fenceBindings,
              ...sends.bind,
            ),
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

  private async registerReservation(
    actor: Principal,
    registration: RegistrationRow,
    times: { createdAt: number; updatedAt: number },
  ) {
    await this.requireWorkspace(actor, registration.workspace_id, "create_session")
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
    if (registration.operation_kind === "fork") {
      await this.requireSessionAccess(actor, registration.parent_session_id!, registration.workspace_id, "agent_turn")
    }
    const now = this.now()
    const assertionId = this.randomId("assert")
    const creates = maySql(actor, "create_session", { kind: "workspace", alias: "w" })
    const parentSends = maySql(actor, "send", { kind: "session", alias: "parent" })
    const sends = maySql(actor, "send", { kind: "session", alias: "s" })
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
              and w.deleted_at is null and ${creates.sql}
          )
          and (operation_kind = 'create' or exists (
            select 1 from sessions parent
            where parent.session_id = session_registration_operations.parent_session_id
              and parent.workspace_id = session_registration_operations.workspace_id
              and parent.deleted_at is null
              and ${parentSends.sql}
          ))
      `,
          )
          .bind(now, registration.operation_id, actor.actorId, ...creates.bind, ...parentSends.bind),
        this.database
          .prepare(
            `
        insert into sessions (
          session_id, operation_id, workspace_id, org_id, project_id, creator_actor_id,
          lifecycle_generation, title, created_at, updated_at, deleted_at,
          max_event_ordinal, snapshot_generation, snapshot_hash, snapshot_token, session_host_root
        )
        select session_id, operation_id, workspace_id, org_id, project_id, creator_actor_id,
          1, requested_title, ?, ?, null, 0, 0, null, null, session_host_root
        from session_registration_operations
        where operation_id = ? and creator_actor_id = ? and state = 'registered'
        on conflict do nothing
      `,
          )
          .bind(times.createdAt, times.updatedAt, registration.operation_id, actor.actorId),
        this.database
          .prepare(
            `
        insert into authority_batch_assertions (assertion_id, passed)
        values (?, case when exists (
          select 1 from session_registration_operations r
          join sessions s on s.operation_id = r.operation_id and s.session_id = r.session_id
          where r.operation_id = ? and r.state = 'registered' and s.creator_actor_id = ?
            and s.deleted_at is null
            and ${sends.sql}
        ) then 1 else 0 end)
      `,
          )
          .bind(assertionId, registration.operation_id, actor.actorId, ...sends.bind),
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
    await this.requireWorkspace(who, workspaceId, "operate")
    const rows = visibilityRows(args.sessions)
    for (const row of rows) {
      const existing = await this.requireSessionAccess(who, row.sessionId, workspaceId, "agent_turn")
      if (row.createdAt !== undefined && row.createdAt !== existing.created_at) {
        throw new D1SessionAuthorityError("resource_conflict", "Session creation time is owned by registration")
      }
    }
    const now = this.now()
    const assertionId = this.randomId("assert")
    const sendsHere = maySql(who, "send", { kind: "session", alias: "sessions" })
    const sends = maySql(who, "send", { kind: "session", alias: "s" })
    const statements: D1PreparedStatement[] = rows.map((row) =>
      this.database
        .prepare(
          `
      update sessions set
        title = case when ?1 is null or runtime_updated_at is null or ?1 >= runtime_updated_at
          then coalesce(?2, title) else title end,
        runtime_updated_at = coalesce(max(runtime_updated_at, ?1), ?1, runtime_updated_at),
        updated_at = max(updated_at, coalesce(?1, updated_at))
      where session_id = ?3 and workspace_id = ?4 and deleted_at is null
        and ${sendsHere.sql}
    `,
        )
        .bind(row.updatedAt ?? null, row.title ?? null, row.sessionId, workspaceId, ...sendsHere.bind),
    )
    if (replace) {
      statements.push(
        this.database
          .prepare(
            `
        update sessions set deleted_at = ?
        where workspace_id = ? and creator_actor_id = ? and deleted_at is null
          and not exists (select 1 from json_each(?) incoming where incoming.value = sessions.session_id)
          and ${sendsHere.sql}
      `,
          )
          .bind(
            now,
            workspaceId,
            who.actorId,
            JSON.stringify(rows.map((row) => row.sessionId)),
            ...sendsHere.bind,
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
          where s.session_id is null or not (${sends.sql})
        )
      then 1 else 0 end)
    `,
        )
        .bind(assertionId, JSON.stringify(rows.map((row) => row.sessionId)), workspaceId, ...sends.bind),
    )
    statements.push(this.deleteAssertion(assertionId))
    await this.guardedBatch(statements, "Session visibility raced with an authority change")
  }

  /**
   * The session, when `actor` may ask `access` of it, with the reader's role:
   * `owner` for the owner of its workspace, `viewer` for a share holder.
   */
  private async requireSessionAccess(
    actor: Principal,
    sessionId: string,
    workspaceId: string,
    access: SessionAccessQuestion,
  ): Promise<ReadableSession> {
    const allowed = maySql(actor, SESSION_ACTION[access], { kind: "session", alias: "s" })
    const session = await this.database
      .prepare(
        `
      select s.*, w.owner_user_id = ? as owns
      from sessions s
      join workspaces w on w.workspace_id = s.workspace_id
      where s.session_id = ? and s.workspace_id = ? and ${allowed.sql}
    `,
      )
      .bind(actor.userId, sessionId, workspaceId, ...allowed.bind)
      .first<SessionRow & { owns: number }>()
    if (!session) throw denied()
    const { owns, ...row } = session
    return { ...row, role: owns === 1 ? "owner" : "viewer" }
  }

  private async requireWorkspace(actor: Principal, workspaceId: string, action: WorkspaceAction) {
    const allowed = maySql(actor, action, { kind: "workspace", alias: "w" })
    const row = await this.database
      .prepare(`select w.workspace_id, w.org_id, w.project_id, w.backing from workspaces w where w.workspace_id = ? and ${allowed.sql}`)
      .bind(workspaceId, ...allowed.bind)
      .first<WorkspaceAccessRow>()
    if (!row) throw denied()
    return row
  }

  private requirePrincipal(auth: SignedControlPlaneAuth): Promise<Principal> {
    return requireHuman(this.database, this.options.deploymentId, auth)
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

  private async turnGrant(grantId: string) {
    return await this.database
      .prepare(`select * from session_turn_grants where grant_id = ?`)
      .bind(grantId)
      .first<TurnGrantRow>()
  }

  private registrationAssertion(
    assertionId: string,
    intent: ReservationIntent & { sessionHostRoot: string | null },
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
          and requested_title is ? and session_host_root is ? and state = ?
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
        intent.sessionHostRoot,
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
      if (d1ConstraintFailure(error)?.kind === "check") {
        throw new D1SessionAuthorityError("resource_conflict", message)
      }
      throw error
    }
  }
}

const SESSION_ACTION: Record<SessionAccessQuestion, SessionAction> = {
  read: "read",
  agent_turn: "send",
  session_control: "control",
}

function boundedTurnLeaseTtl(value: number | undefined) {
  const ttl = value ?? SESSION_TURN_LEASE_TTL_MS
  if (!Number.isSafeInteger(ttl) || ttl < 5_000 || ttl > 15 * 60_000) {
    throw new TypeError("turnLeaseTtlMs must be an integer between 5000 and 900000")
  }
  return ttl
}

type TurnAdmission = {
  actor: Principal
  sessionId: string
  workspaceId: string
  turnId: string
  leaseId: string
  now: number
  expiresAt: number
}

function denied(message = "Session authorization was denied") {
  return new ControlPlaneAuthError(403, "workspace_authorization_denied", message)
}

function isDenied(error: unknown) {
  return error instanceof ControlPlaneAuthError && error.status === 403
}
