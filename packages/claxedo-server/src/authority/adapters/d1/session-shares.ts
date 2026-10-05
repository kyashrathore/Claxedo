import { PublicApiError } from "@claxedo/server-core/platform/errors/public-api-error"
import type { PublicApiErrorCode } from "@claxedo/helpers/api-error"
import type { D1Database, D1PreparedStatement, D1Result } from "@cloudflare/workers-types"
import { ControlPlaneAuthError, type SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { SessionShareGrantResult, SessionShareLevel } from "@claxedo/server-core/platform/auth/authority"
import { requestedSessionShareLevel, storedSessionShareLevel } from "@claxedo/server-core/platform/auth/session-share-level"
import type { SessionShareRecipient } from "@claxedo/server-core/platform/auth/session-share-authority"
import { d1ConstraintFailure } from "../../../platform/db/d1-constraint"
import { may, maySql, type AuthorizationPrincipal } from "./authorization"
import { requireText } from "./session-input"
import type { SessionRow, SessionShareRow } from "./session-rows"

export type ShareAdministrator = AuthorizationPrincipal & { actorId: string }

/** What the session authority lends its shares: its database, clocks and the access checks every session write goes through. */
export type SessionShareDeps = {
  database: D1Database
  now(): number
  randomId(prefix: string): string
  requirePrincipal(auth: SignedControlPlaneAuth): Promise<ShareAdministrator>
  requireSessionReader(actor: ShareAdministrator, sessionId: string, workspaceId: string): Promise<Pick<SessionRow, "org_id">>
  guardedBatch(statements: D1PreparedStatement[], message: string): Promise<D1Result[]>
  deleteAssertion(assertionId: string): D1PreparedStatement
}

/** Who a session is shared with, at what level: granted, moved between levels, revoked and listed under the administrator's own predicate. */
export class D1SessionShares {
  constructor(private readonly deps: SessionShareDeps) {}

  async grantSessionShare(
    auth: SignedControlPlaneAuth,
    args: {
      sessionId: string
      workspaceId: string
      level?: SessionShareLevel
    } & SessionShareRecipient,
  ): Promise<SessionShareGrantResult> {
    const administrator = await this.deps.requirePrincipal(auth)
    const level = requestedSessionShareLevel(args.level)
    const sessionId = requireText(args.sessionId, "sessionId")
    const workspaceId = requireText(args.workspaceId, "workspaceId")
    const session = await this.requireSessionShareAdministrator(administrator, sessionId, workspaceId)
    const target = await this.resolveShareRecipient(args)
    if (!target) throw sessionShareError("session_share_target_not_found")
    const actor = await this.activeHumanActorForUser(target)
    if (!actor) throw sessionShareError("session_share_target_not_found")
    if (!(await may(this.deps.database, { userId: target }, "member", { kind: "org", orgId: session.org_id }))) {
      throw sessionShareError("session_share_target_outside_organization")
    }
    const existing = await this.activeShareForTarget(sessionId, target)
    if (existing) {
      if (storedSessionShareLevel(existing.level) !== level) {
        await this.setShareLevel(administrator, existing, sessionId, workspaceId, level)
      }
      return { grant_id: existing.grant_id, level, recipientUserId: target }
    }
    const grantId = this.deps.randomId("share")
    const assertionId = this.deps.randomId("assert")
    const now = this.deps.now()
    const manages = maySql(administrator, "manage_shares", { kind: "session", alias: "s" })
    const targetMember = maySql({ userId: target }, "member", { kind: "org", orgId: "s.org_id" })
    try {
      await this.deps.guardedBatch(
        [
          this.deps.database
            .prepare(
              `
        insert into session_share_grants (
          grant_id, session_id, workspace_id, org_id, project_id,
          target_user_id, granted_by_actor_id, granted_at, revoked_at, level
        )
        select ?, s.session_id, s.workspace_id, s.org_id, s.project_id,
          ?, ?, ?, null, ?
        from sessions s
        where s.session_id = ? and s.workspace_id = ? and s.deleted_at is null
          and ${manages.sql}
          and exists (
            select 1 from actors target_actor
            where target_actor.user_id = ? and target_actor.kind = 'human' and target_actor.state = 'active'
          ) and ${targetMember.sql}
      `,
            )
            .bind(
              grantId,
              target,
              administrator.actorId,
              now,
              level,
              sessionId,
              workspaceId,
              ...manages.bind,
              target,
              ...targetMember.bind,
            ),
          this.deps.database
            .prepare(
              `
          insert into authority_batch_assertions (assertion_id, passed)
          values (?, case when exists (
            select 1 from session_share_grants g
            join sessions s on s.session_id = g.session_id and s.workspace_id = g.workspace_id
            where g.grant_id = ? and g.session_id = ? and g.workspace_id = ? and g.revoked_at is null
              and s.deleted_at is null and ${manages.sql}
          ) then 1 else 0 end)
        `,
            )
            .bind(assertionId, grantId, sessionId, workspaceId, ...manages.bind),
          this.deps.deleteAssertion(assertionId),
        ],
        "Session share grant raced with an authority change",
      )
    } catch (error) {
      if (d1ConstraintFailure(error)?.kind === "unique") {
        await this.requireSessionShareAdministrator(administrator, sessionId, workspaceId)
        const raced = await this.activeShareForTarget(sessionId, target)
        if (raced && raced.workspace_id === workspaceId) {
          if (storedSessionShareLevel(raced.level) !== level) {
            await this.setShareLevel(administrator, raced, sessionId, workspaceId, level)
          }
          return { grant_id: raced.grant_id, level, recipientUserId: target }
        }
      }
      throw error
    }
    return { grant_id: grantId, level, recipientUserId: target }
  }

  /**
   * Moves a live grant between levels under the same administrator predicate
   * the insert carries, so a downgrade cannot outlive the caller's right to
   * make it. The recipient keeps their runtime access token: reading is still
   * granted, and the write the token no longer buys is refused at the next
   * authority call.
   */
  private async setShareLevel(
    administrator: ShareAdministrator,
    grant: SessionShareRow,
    sessionId: string,
    workspaceId: string,
    level: SessionShareLevel,
  ) {
    const assertionId = this.deps.randomId("assert")
    const manages = maySql(administrator, "manage_shares", { kind: "session", alias: "s" })
    await this.deps.guardedBatch(
      [
        this.deps.database
          .prepare(
            `
        update session_share_grants set level = ?
        where grant_id = ? and session_id = ? and workspace_id = ? and revoked_at is null
          and exists (
            select 1 from sessions s
            where s.session_id = session_share_grants.session_id
              and s.workspace_id = session_share_grants.workspace_id
              and s.deleted_at is null
              and ${manages.sql}
          )
      `,
          )
          .bind(level, grant.grant_id, sessionId, workspaceId, ...manages.bind),
        this.deps.database
          .prepare(
            `
        insert into authority_batch_assertions (assertion_id, passed)
        values (?, case when exists (
          select 1 from session_share_grants g
          where g.grant_id = ? and g.session_id = ? and g.workspace_id = ?
            and g.revoked_at is null and g.level = ?
        ) then 1 else 0 end)
      `,
          )
          .bind(assertionId, grant.grant_id, sessionId, workspaceId, level),
        this.deps.deleteAssertion(assertionId),
      ],
      "Session share level change raced with an authority change",
    )
  }

  async revokeSessionShare(
    auth: SignedControlPlaneAuth,
    args: {
      sessionId: string
      workspaceId: string
      grantId?: string
    } & SessionShareRecipient,
  ) {
    const administrator = await this.deps.requirePrincipal(auth)
    const sessionId = requireText(args.sessionId, "sessionId")
    const workspaceId = requireText(args.workspaceId, "workspaceId")
    await this.requireSessionShareAdministrator(administrator, sessionId, workspaceId)
    const selectorCount = shareSelectorCount(args)
    if ((args.grantId && selectorCount !== 0) || (!args.grantId && selectorCount !== 1)) {
      throw sessionShareError("session_share_target_required")
    }
    let grants: SessionShareRow[]
    if (args.grantId) {
      const result = await this.deps.database
        .prepare(
          `
        select * from session_share_grants
        where grant_id = ? and session_id = ? and workspace_id = ? and revoked_at is null
      `,
        )
        .bind(requireText(args.grantId, "grantId"), sessionId, workspaceId)
        .all<SessionShareRow>()
      grants = result.results
    } else {
      const target = await this.resolveShareRecipient(args, true)
      if (!target) return { revoked: false, runtime_tokens_revoked: 0, recipientUserIds: [] }
      const existing = await this.activeShareForTarget(sessionId, target)
      grants = existing && existing.workspace_id === workspaceId ? [existing] : []
    }
    if (grants.length === 0) return { revoked: false, runtime_tokens_revoked: 0, recipientUserIds: [] }
    const now = this.deps.now()
    const manages = maySql(administrator, "manage_shares", { kind: "session", alias: "s" })
    let runtimeTokensRevoked = 0
    for (const grant of grants) {
      const assertionId = this.deps.randomId("assert")
      const revokeTokens = this.deps.database
        .prepare(
          `
        update runtime_access_tokens set revoked_at = ?
        where share_grant_id = ? and revoked_at is null
          and exists (select 1 from session_share_grants g where g.grant_id = ? and g.revoked_at = ?)
      `,
        )
        .bind(now, grant.grant_id, grant.grant_id, now)
      const results = await this.deps.guardedBatch(
        [
          this.deps.database
            .prepare(
              `
            update session_share_grants set revoked_at = ?
            where grant_id = ? and session_id = ? and workspace_id = ? and revoked_at is null
              and exists (
                select 1 from sessions s
                where s.session_id = session_share_grants.session_id
                  and s.workspace_id = session_share_grants.workspace_id
                  and s.deleted_at is null
                  and ${manages.sql}
              )
          `,
            )
            .bind(now, grant.grant_id, sessionId, workspaceId, ...manages.bind),
          revokeTokens,
          this.deps.database
            .prepare(
              `
            insert into authority_batch_assertions (assertion_id, passed)
            values (?, case when exists (
              select 1 from session_share_grants g
              join sessions s on s.session_id = g.session_id and s.workspace_id = g.workspace_id
              where g.grant_id = ? and g.session_id = ? and g.workspace_id = ? and g.revoked_at = ?
                and s.deleted_at is null and ${manages.sql}
            ) then 1 else 0 end)
          `,
            )
            .bind(assertionId, grant.grant_id, sessionId, workspaceId, now, ...manages.bind),
          this.deps.deleteAssertion(assertionId),
        ],
        "Session share revocation raced with an authority change",
      )
      runtimeTokensRevoked += results[1]?.meta.changes ?? 0
    }
    return {
      revoked: true,
      runtime_tokens_revoked: runtimeTokensRevoked,
      recipientUserIds: grants.map((grant) => grant.target_user_id),
    }
  }

  async listSessionShares(auth: SignedControlPlaneAuth, args: { sessionId: string; workspaceId: string }) {
    const who = await this.deps.requirePrincipal(auth)
    const sessionId = requireText(args.sessionId, "sessionId")
    const workspaceId = requireText(args.workspaceId, "workspaceId")
    const session = await this.deps.requireSessionReader(who, sessionId, workspaceId).catch(async (err) => {
      // A session a machine created and never registered is its workspace
      // owner's, with no shares to manage. To anyone else it, an unknown
      // workspace and another person's session are the same refusal.
      if (!(err instanceof ControlPlaneAuthError)) throw err
      if (!(await may(this.deps.database, who, "open", { kind: "workspace", workspaceId }))) throw err
      return undefined
    })
    if (!session) return { can_manage_shares: false, grants: [] }
    const canManage = await may(this.deps.database, who, "manage_shares", { kind: "session", sessionId, workspaceId })
    if (!canManage) return { can_manage_shares: false, grants: [] }
    const grants = await this.deps.database
      .prepare(
        `
        select grant_id, session_id, workspace_id, level,
          target_user_id as granted_to_user_id,
          granted_by_actor_id as created_by_user_id,
          granted_at as created_at,
          revoked_at
        from session_share_grants
        where session_id = ? and workspace_id = ? and revoked_at is null
        order by granted_at, grant_id
      `,
      )
      .bind(sessionId, workspaceId)
      .all()
    return { can_manage_shares: true, grants: grants.results }
  }

  /** The active user a share names, by user id, token identifier or provider subject. */
  private async resolveShareRecipient(args: SessionShareRecipient, allowMissing = false): Promise<string | undefined> {
    if (shareSelectorCount(args) !== 1) throw sessionShareError("session_share_target_required")
    const value = requireText((args.grantedToTokenIdentifier ?? args.grantedToSubject ?? args.grantedToUserId)!, "share user target")
    const user = args.grantedToUserId
      ? await this.deps.database
          .prepare(`select user_id from users where user_id = ? and state = 'active'`)
          .bind(value)
          .first<{ user_id: string }>()
      : args.grantedToTokenIdentifier
        ? await this.deps.database
            .prepare(
              `
            select ai.user_id from auth_identities ai
            join users u on u.user_id = ai.user_id and u.state = 'active'
            where ai.issuer || '|' || ai.subject = ? and ai.unlinked_at is null
          `,
            )
            .bind(value)
            .first<{ user_id: string }>()
        : await this.deps.database
            .prepare(
              `
            select ai.user_id from auth_identities ai
            join users u on u.user_id = ai.user_id and u.state = 'active'
            where ai.subject = ? and ai.unlinked_at is null
            order by ai.linked_at, ai.adapter, ai.issuer limit 1
          `,
            )
            .bind(value)
            .first<{ user_id: string }>()
    if (!user) {
      if (allowMissing) return undefined
      throw sessionShareError("session_share_target_not_found")
    }
    return user.user_id
  }

  private async activeHumanActorForUser(userId: string): Promise<ShareAdministrator | undefined> {
    const row = await this.deps.database
      .prepare(
        `
      select a.actor_id, a.user_id from actors a join users u on u.user_id = a.user_id and u.state = 'active'
      where a.user_id = ? and a.kind = 'human' and a.state = 'active'
    `,
      )
      .bind(userId)
      .first<{ actor_id: string; user_id: string }>()
    return row ? { userId: row.user_id, actorId: row.actor_id } : undefined
  }

  private async activeShareForTarget(sessionId: string, targetUserId: string) {
    return await this.deps.database
      .prepare(`select * from session_share_grants where session_id = ? and revoked_at is null and target_user_id = ?`)
      .bind(sessionId, targetUserId)
      .first<SessionShareRow>()
  }

  private async requireSessionShareAdministrator(actor: ShareAdministrator, sessionId: string, workspaceId: string) {
    const session = await this.deps.requireSessionReader(actor, sessionId, workspaceId)
    if (!(await may(this.deps.database, actor, "manage_shares", { kind: "session", sessionId, workspaceId }))) {
      throw new ControlPlaneAuthError(403, "workspace_authorization_denied", "Session share administration was denied")
    }
    return session
  }
}

function shareSelectorCount(args: SessionShareRecipient) {
  return [args.grantedToTokenIdentifier, args.grantedToSubject, args.grantedToUserId]
    .filter((value) => typeof value === "string" && !!value.trim()).length
}

function sessionShareError(code: PublicApiErrorCode) {
  return new PublicApiError(code)
}
