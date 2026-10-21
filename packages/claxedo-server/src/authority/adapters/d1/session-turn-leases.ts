import type { D1Database, D1PreparedStatement, D1Result } from "@cloudflare/workers-types"
import type { PrivateSessionActor, PrivateSessionRuntimePrincipal } from "@claxedo/server-core/platform/auth/private-session-authority"
import {
  SessionTurnConflictError,
  SessionTurnGrantError,
  SessionTurnLeaseLostError,
  normalizeGrantSessionTurnInput,
  sessionTurnGrantRefusal,
  type AcquireSessionTurnInput,
  type GrantSessionTurnInput,
  type OwnedSessionTurnInput,
  type RevokeSessionTurnGrantsInput,
  type SessionTurnGrant,
  type SessionTurnLease,
} from "@claxedo/server-core/platform/auth/session-turn-authority"
import { SESSION_TURN_LEASE_TTL_MS } from "@claxedo/workspace-relay-protocol"
import { maySql, type AuthorizationPrincipal } from "./authorization"
import { D1SessionAuthorityError, isDenied, optionalText, positiveFence, requireText } from "./session-input"
import { turnGrantJson, turnLeaseJson, type TurnGrantRow, type TurnLeaseRow } from "./session-rows"
import { SESSION_STATUS_STAMP_SQL, sessionStatusStampBindings } from "./session-status-notices"

export type TurnLeaseActor = PrivateSessionActor & AuthorizationPrincipal & { userId: string }

/** What the session authority lends its turn leases: its database, clocks and the actor and access checks every turn goes through. */
export type SessionTurnLeaseDeps = {
  database: D1Database
  now(): number
  randomId(prefix: "assert" | "turn" | "grant"): string
  turnLeaseTtlMs?: number
  requireRuntimeActor(input: PrivateSessionRuntimePrincipal): Promise<TurnLeaseActor>
  requireTurnAccess(actor: TurnLeaseActor, sessionId: string, workspaceId: string): Promise<unknown>
  guardedBatch(statements: D1PreparedStatement[], message: string): Promise<D1Result[]>
  deleteAssertion(assertionId: string): D1PreparedStatement
}

type TurnAdmission = {
  actor: TurnLeaseActor
  sessionId: string
  workspaceId: string
  turnId: string
  leaseId: string
  now: number
  expiresAt: number
}

/** The one turn a session runs at a time: its lease, acquired, renewed, released or refused, and the deferred grants a later turn redeems. */
export class D1SessionTurnLeases {
  private readonly ttlMs: number

  constructor(private readonly deps: SessionTurnLeaseDeps) {
    this.ttlMs = boundedTurnLeaseTtl(deps.turnLeaseTtlMs)
  }

  /**
   * Atomically claims the single active turn row for this session. The INSERT
   * source repeats current private-session authorization, so a revocation race
   * cannot acquire after the preceding diagnostic read. Exact retries observe
   * the same lease; only release/expiry permits replacement, which increments
   * the fence in the same statement.
   */
  async acquireSessionTurn(input: AcquireSessionTurnInput): Promise<SessionTurnLease> {
    const actor = await this.deps.requireRuntimeActor(input)
    const sessionId = requireText(input.sessionId, "sessionId")
    const workspaceId = requireText(input.workspaceId, "workspaceId")
    const turnId = requireText(input.turnId, "turnId", 512)
    const grantId = optionalText(input.grantId, "grantId")
    await this.deps.requireTurnAccess(actor, sessionId, workspaceId)
    const now = this.deps.now()
    const expiresAt = now + this.ttlMs
    const leaseId = this.deps.randomId("turn")
    const admission = { actor, sessionId, workspaceId, turnId, leaseId, now, expiresAt }
    if (grantId === undefined) await this.turnLeaseInsert(admission).run()
    else await this.redeemTurnGrant(admission, grantId)
    const row = await this.lease(sessionId)
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
    await this.deps.requireTurnAccess(actor, sessionId, workspaceId)
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
    return this.deps.database
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
    const assertionId = this.deps.randomId("assert")
    try {
      await this.deps.guardedBatch(
        [
          this.turnLeaseInsert(input, { grantId }),
          this.deps.database
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
          this.deps.database
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
          this.deps.deleteAssertion(assertionId),
        ],
        "Session turn grant redemption was refused",
      )
    } catch (error) {
      if (!(error instanceof D1SessionAuthorityError && error.code === "resource_conflict")) throw error
      const lease = await this.lease(input.sessionId)
      const live = lease && lease.released_at === null && lease.expires_at > input.now
        ? { turnId: lease.turn_id, actorId: lease.actor_id }
        : undefined
      const refusal = sessionTurnGrantRefusal(
        turnGrantJson(await this.grant(grantId)),
        { actorId: input.actor.actorId, sessionId: input.sessionId, workspaceId: input.workspaceId, turnId: input.turnId, now: input.now },
        live,
      )
      if (refusal) throw refusal
    }
  }

  async grantSessionTurn(input: GrantSessionTurnInput): Promise<SessionTurnGrant> {
    const actor = await this.deps.requireRuntimeActor(input)
    const sessionId = requireText(input.sessionId, "sessionId")
    const workspaceId = requireText(input.workspaceId, "workspaceId")
    const grant = normalizeGrantSessionTurnInput(input)
    await this.deps.requireTurnAccess(actor, sessionId, workspaceId)
    const now = this.deps.now()
    const grantId = this.deps.randomId("grant")
    const sends = maySql(actor, "send", { kind: "session", alias: "s" })
    await this.deps.database
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
    const row = await this.grant(grantId)
    if (row) return turnGrantJson(row)
    await this.deps.requireTurnAccess(actor, sessionId, workspaceId)
    throw new SessionTurnGrantError("session_turn_grant_mismatch", "Child registration does not name this parent and creator")
  }

  async revokeSessionTurnGrants(input: RevokeSessionTurnGrantsInput) {
    const sessionId = optionalText(input.sessionId, "sessionId")
    const subjectSessionId = optionalText(input.subjectSessionId, "subjectSessionId")
    const reason = requireText(input.reason, "reason")
    if (sessionId === undefined && subjectSessionId === undefined) {
      throw new D1SessionAuthorityError("invalid_input", "sessionId or subjectSessionId is required")
    }
    const result = await this.deps.database
      .prepare(
        `
      update session_turn_grants set revoked_at = ?, revoke_reason = ?
      where revoked_at is null and (session_id = ? or subject_session_id = ?)
    `,
      )
      .bind(this.deps.now(), reason, sessionId ?? null, subjectSessionId ?? null)
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
    await this.deps.database
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
    const actor = await this.deps.requireRuntimeActor(input)
    const sessionId = requireText(input.sessionId, "sessionId")
    const workspaceId = requireText(input.workspaceId, "workspaceId")
    const turnId = requireText(input.turnId, "turnId", 512)
    const leaseId = requireText(input.leaseId, "leaseId", 512)
    const fencingToken = positiveFence(input.fencingToken)
    try {
      await this.deps.requireTurnAccess(actor, sessionId, workspaceId)
    } catch (error) {
      if (isDenied(error)) await this.endRefusedLease({ sessionId, workspaceId, turnId, leaseId, fencingToken, actorId: actor.actorId })
      throw error
    }
    const now = this.deps.now()
    const expiresAt = now + this.ttlMs
    const sends = maySql(actor, "send", { kind: "session", alias: "s" })
    await this.deps.database
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
    const row = await this.lease(sessionId)
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

  /**
   * A renewal refused because its actor may no longer send on the session ends
   * the lease it named: the session admits its next turn now instead of when
   * the refused lease would have run out, and its list row reads the busy
   * stamp that lease left as interrupted.
   */
  private async endRefusedLease(lease: { sessionId: string; workspaceId: string; turnId: string; leaseId: string; fencingToken: number; actorId: string }) {
    const now = this.deps.now()
    await this.deps.database
      .prepare(
        `
      update session_turn_leases set expires_at = ?
      where session_id = ? and workspace_id = ? and turn_id = ? and lease_id = ?
        and fencing_token = ? and actor_id = ? and released_at is null and expires_at > ?
    `,
      )
      .bind(now, lease.sessionId, lease.workspaceId, lease.turnId, lease.leaseId, lease.fencingToken, lease.actorId, now)
      .run()
  }

  async releaseSessionTurn(input: OwnedSessionTurnInput) {
    const actor = await this.deps.requireRuntimeActor(input)
    const sessionId = requireText(input.sessionId, "sessionId")
    const workspaceId = requireText(input.workspaceId, "workspaceId")
    const turnId = requireText(input.turnId, "turnId", 512)
    const leaseId = requireText(input.leaseId, "leaseId", 512)
    const fencingToken = positiveFence(input.fencingToken)
    const now = this.deps.now()
    await this.deps.database
      .prepare(
        `
      update session_turn_leases set released_at = ?
      where session_id = ? and workspace_id = ? and turn_id = ? and lease_id = ?
        and fencing_token = ? and actor_id = ? and released_at is null
    `,
      )
      .bind(now, sessionId, workspaceId, turnId, leaseId, fencingToken, actor.actorId)
      .run()
    const row = await this.lease(sessionId)
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
      await this.deps.database
        .prepare(`update sessions set ${SESSION_STATUS_STAMP_SQL} where session_id = ? and workspace_id = ? and deleted_at is null`)
        .bind(...sessionStatusStampBindings("idle", row!.released_at!), sessionId, workspaceId)
        .run()
    }
    return { released, sessionId, turnId, fencingToken }
  }

  async lease(sessionId: string) {
    return await this.deps.database
      .prepare(`select * from session_turn_leases where session_id = ?`)
      .bind(sessionId)
      .first<TurnLeaseRow>()
  }

  private async grant(grantId: string) {
    return await this.deps.database
      .prepare(`select * from session_turn_grants where grant_id = ?`)
      .bind(grantId)
      .first<TurnGrantRow>()
  }
}

function boundedTurnLeaseTtl(value: number | undefined) {
  const ttl = value ?? SESSION_TURN_LEASE_TTL_MS
  if (!Number.isSafeInteger(ttl) || ttl < 5_000 || ttl > 15 * 60_000) {
    throw new TypeError("turnLeaseTtlMs must be an integer between 5000 and 900000")
  }
  return ttl
}
