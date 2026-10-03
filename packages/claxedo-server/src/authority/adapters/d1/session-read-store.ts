import type { SharedSession } from "@claxedo/account-contract"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { AGENT_MESSAGE_PAGE_LIMIT, AgentMessagePageError } from "@claxedo/agent-runtime-contract"
import { asRecord, numberField, parseJson } from "@claxedo/server-core/platform/json/index"
import { latestViewPage, type LatestView } from "@claxedo/server-core/session/latest-view-page"
import type { D1Database } from "@cloudflare/workers-types"
import type { SessionPageQuery } from "@claxedo/server-core/platform/auth/private-session-authority"
import { sessionOrderSql, unsettledSql } from "@claxedo/server-core/session/navigation-order"
import { requireHuman } from "./access-context"
import { maySql, type BoundSql } from "./authorization"
import type { D1ActorProfile } from "./workspace-authority"
import type { SessionHostPlacement } from "../../session-hosts"

type SessionPageRow = {
  session_id: string
  workspace_id: string
  project_id: string
  title: string | null
  created_at: number
  updated_at: number
  last_human_turn_at: number | null
  archived_at: number | null
  status: string | null
  status_at: number | null
  awaiting_input: number
  background_agents: number
  background_shells: number
  background_other: number
  last_turn_status: string | null
  last_turn_completed_at: number | null
  session_host_root: string | null
  seen_at: number | null
  settled_at: number | null
}

type Clauses = { readonly where: string[]; readonly params: unknown[] }

const orderColumns = (s: string) => ({
  lastHumanTurnAt: `${s}.last_human_turn_at`,
  createdAt: `${s}.created_at`,
  updatedAt: `${s}.updated_at`,
  sessionRef: `('workspace:' || ${s}.workspace_id || ':session:' || ${s}.session_id)`,
})

function pageFilters(query: SessionPageQuery, s: string, r: string): Clauses {
  const where = [`${s}.deleted_at is null`]
  const params: unknown[] = []
  if (query.archived === "archived") where.push(`${s}.archived_at is not null`)
  if (query.archived === "active") where.push(`${s}.archived_at is null`)
  if (query.settled !== "all") where.push(unsettledSql({ settledAt: `${r}.settled_at`, lastHumanTurnAt: `${s}.last_human_turn_at`, lastTurnCompletedAt: `${s}.last_turn_completed_at` }))
  if (query.search) {
    where.push(`lower(coalesce(${s}.title, '')) like ?`)
    params.push(`%${query.search.toLowerCase()}%`)
  }
  const keyset = sessionOrderSql(orderColumns(s), query.sort, query.after).keyset
  if (keyset) {
    where.push(keyset.sql)
    params.push(...keyset.params)
  }
  return { where, params }
}

/**
 * The candidates of a page of every session the reader may read: the first
 * `limit` rows of each workspace the reader owns, each read in order from
 * `sessions_by_workspace_human_turn`, and the first `limit` of the sessions
 * shared to the reader. The page is the first `limit` of their union, so its
 * sort holds at most (owned workspaces + 1) × `limit` rows. The shared arm
 * orders every active share of the reader that passes the filters, since no
 * index orders shares by their session's activity.
 */
function everyReadableCandidates(query: SessionPageQuery, readerUserId: string): Clauses {
  const owned = pageFilters(query, "o", "o_r")
  const shared = pageFilters(query, "h", "h_r")
  const ordered = (s: string) => sessionOrderSql(orderColumns(s), query.sort, undefined).orderBy
  return {
    where: [`s.session_id in (
      select c.session_id from workspaces w
        join sessions c on c.session_id in (
          select o.session_id from sessions o
            left join session_reads o_r on o_r.user_id = ? and o_r.session_id = o.session_id
          where o.workspace_id = w.workspace_id and ${owned.where.join(" and ")}
          order by ${ordered("o")} limit ?)
      where w.owner_user_id = ? and w.deleted_at is null
      union all
      select session_id from (
        select h.session_id from session_share_grants g
          join sessions h on h.session_id = g.session_id
          left join session_reads h_r on h_r.user_id = ? and h_r.session_id = h.session_id
        where g.target_user_id = ? and g.revoked_at is null and ${shared.where.join(" and ")}
        order by ${ordered("h")} limit ?))`],
    params: [readerUserId, ...owned.params, query.limit, readerUserId, readerUserId, readerUserId, ...shared.params, query.limit],
  }
}

function pageScope(query: SessionPageQuery, readerUserId: string): Clauses {
  if (query.sessionId) return { where: ["s.session_id = ?"], params: [query.sessionId] }
  if ("projectId" in query) return { where: ["s.project_id = ?"], params: [query.projectId] }
  if ("workspaceId" in query) return { where: ["s.workspace_id = ?"], params: [query.workspaceId] }
  return everyReadableCandidates(query, readerUserId)
}

/**
 * `access` is the caller's read predicate over `s`, with the values its
 * placeholders bind; `readerUserId` is whose seen and settled marks the rows
 * carry and the settled filter reads. A `sessionId` reads that one session,
 * whatever the scope, by its key. A `busy` stamped by a turn lease that then
 * lapsed unreleased reads as `interrupted`: the runtime holding it is gone, and
 * the lease's own expiry is the one record that says so.
 */
export async function readD1SessionPage(database: D1Database, query: SessionPageQuery, access: BoundSql, readerUserId: string, now: number) {
  const scope = pageScope(query, readerUserId)
  const filters = pageFilters(query, "s", "r")
  const result = await database
    .prepare(`
      select s.session_id, s.workspace_id, s.project_id, s.title, s.created_at, s.updated_at,
        s.last_human_turn_at, s.archived_at,
        case when s.status = 'busy' and exists (
          select 1 from session_turn_leases lapsed
          where lapsed.session_id = s.session_id and lapsed.acquired_at = s.status_at
            and lapsed.released_at is null and lapsed.expires_at <= ?
        ) then 'interrupted' else s.status end as status,
        s.status_at, s.awaiting_input,
        s.background_agents, s.background_shells, s.background_other,
        s.last_turn_status, s.last_turn_completed_at, s.session_host_root, r.seen_at, r.settled_at
      from sessions s
      left join session_reads r on r.user_id = ? and r.session_id = s.session_id
      where ${[...scope.where, ...filters.where, access.sql].join(" and ")}
      ${query.sessionId ? "" : `order by ${sessionOrderSql(orderColumns("s"), query.sort, undefined).orderBy}`}
      limit ?
    `)
    .bind(now, readerUserId, ...scope.params, ...filters.params, ...access.bind, query.limit)
    .all<SessionPageRow>()
  return result.results.map(pageRowJson)
}

function backgroundWorkJson(row: SessionPageRow) {
  const work = { agents: row.background_agents, shells: row.background_shells, other: row.background_other }
  return work.agents + work.shells + work.other > 0 ? { background_work: work } : {}
}

function pageRowJson(row: SessionPageRow) {
  return {
    session_id: row.session_id,
    workspace_id: row.workspace_id,
    project_id: row.project_id,
    ...(row.title === null ? {} : { title: row.title }),
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(row.last_human_turn_at === null ? {} : { last_human_turn_at: row.last_human_turn_at }),
    ...(row.archived_at === null ? {} : { archived_at: row.archived_at }),
    ...(row.status === null || row.status_at === null
      ? {}
      : { status: row.status, status_at: row.status_at, awaiting_input: row.awaiting_input === 1, ...backgroundWorkJson(row) }),
    ...(row.last_turn_status === null || row.last_turn_completed_at === null
      ? {}
      : { last_turn_status: row.last_turn_status, last_turn_completed_at: row.last_turn_completed_at }),
    ...(row.session_host_root === null ? {} : { session_host_root: row.session_host_root }),
    ...(row.seen_at === null ? {} : { seen_at: row.seen_at }),
    ...(row.settled_at === null ? {} : { settled_at: row.settled_at }),
  }
}

type MessageRow = {
  ordinal: number
  data_json: string
  author_actor_id: string | null
  author_kind: "human" | "agent" | null
}

const MESSAGE_PAGE_CURSOR_PREFIX = "d1sm1:"

type MessageReadInput = { sessionId: string; workspaceId: string; limit?: number; before?: string; view?: LatestView }

export function validateD1MessageRead(args: MessageReadInput) {
  if (args.view === undefined) {
    if (args.before !== undefined && args.limit === undefined) {
      throw new AgentMessagePageError(400, "Message page limit is required with a cursor")
    }
    if (
      args.limit !== undefined &&
      (!Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > AGENT_MESSAGE_PAGE_LIMIT)
    ) {
      throw new AgentMessagePageError(400, `Message page limit must be between 1 and ${AGENT_MESSAGE_PAGE_LIMIT}`)
    }
  }
  return args.before === undefined ? undefined : decodeMessagePageCursor(args.sessionId, args.before)
}

export async function readD1MessagePage(database: D1Database, args: MessageReadInput, beforeOrdinal?: number) {
  const { sessionId, workspaceId } = args
  if (args.view !== undefined) return readD1LatestView(database, sessionId, workspaceId, args.view, beforeOrdinal)
  const limit = args.limit
  const query = database.prepare(`
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
    messages: rows.map(publicMessage),
    ...(hasMore && rows[0] ? { nextCursor: encodeMessagePageCursor(sessionId, rows[0].ordinal) } : {}),
  }
}

/**
 * The newest turn whose prompts were stored before `end` starts at the first
 * prompt of the latest prompt's turn, so a prompt steered into a running turn
 * reads with the turn it joined. A prompt the runtime published with no turn
 * stands as a turn of its own.
 */
export async function readD1LatestView(database: D1Database, sessionId: string, workspaceId: string, view: LatestView, end?: number) {
  const endBound = end === undefined ? [] : [end]
  const boundary = await database
    .prepare(`
      with latest as (
        select ordinal, turn_id from session_messages
        where session_id = ? and workspace_id = ? and role = 'user'${end === undefined ? "" : " and ordinal < ?"}
        order by ordinal desc limit 1
      )
      select coalesce(
        (select min(m.ordinal) from session_messages m, latest
          where m.session_id = ? and m.workspace_id = ? and m.role = 'user' and m.turn_id = latest.turn_id),
        (select ordinal from latest)
      ) as ordinal
    `)
    .bind(sessionId, workspaceId, ...endBound, sessionId, workspaceId)
    .first<{ ordinal: number | null }>()
  if (boundary?.ordinal === null || boundary?.ordinal === undefined) return { messages: [] }
  const [turn, older] = await Promise.all([
    database.prepare(`
      select m.ordinal, m.data_json, m.author_actor_id, a.kind as author_kind
      from session_messages m
      left join actors a on a.actor_id = m.author_actor_id and a.state = 'active'
      where m.session_id = ? and m.workspace_id = ? and m.ordinal >= ?${end === undefined ? "" : " and m.ordinal < ?"}
      order by m.ordinal asc
    `).bind(sessionId, workspaceId, boundary.ordinal, ...endBound).all<MessageRow>(),
    database
      .prepare(`select 1 as found from session_messages where session_id = ? and workspace_id = ? and ordinal < ? limit 1`)
      .bind(sessionId, workspaceId, boundary.ordinal)
      .first<{ found: number }>(),
  ])
  return latestViewPage(
    view,
    turn.results.map((row) => ({ ordinal: row.ordinal, message: publicMessage(row) })),
    !!older,
    (ordinal) => encodeMessagePageCursor(sessionId, ordinal),
  )
}

function publicMessage(row: MessageRow) {
  const parsed = parseJson(row.data_json)
  const message = asRecord(parsed)
  if (!message) return parsed
  const info = asRecord(message.info) ?? {}
  const claxedo = asRecord(info.claxedo) ?? {}
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

export function decodeMessagePageCursor(sessionId: string, input: string) {
  try {
    if (!input.startsWith(MESSAGE_PAGE_CURSOR_PREFIX)) throw new Error("unexpected cursor version")
    const value = asRecord(parseJson(decodeURIComponent(input.slice(MESSAGE_PAGE_CURSOR_PREFIX.length))))
    const ordinal = numberField(value, "ordinal")
    if (value?.sessionId !== sessionId || ordinal === undefined || !Number.isSafeInteger(ordinal) || ordinal < 0) {
      throw new Error("invalid cursor payload")
    }
    return ordinal
  } catch {
    throw new AgentMessagePageError(400, "Invalid message page cursor")
  }
}

export async function listD1SharedSessions(
  database: D1Database,
  deploymentId: string,
  profile: D1ActorProfile | undefined,
  auth: SignedControlPlaneAuth,
): Promise<SharedSession[]> {
  const who = await requireHuman(database, deploymentId, auth)
  const reads = maySql(who, "read", { kind: "session", alias: "s" })
  const sends = maySql(who, "send", { kind: "session", alias: "s" })
  const issuer = auth.principal!.identity.issuer
  const rows = await database.prepare(`
      select s.session_id, s.workspace_id, s.project_id, s.title,
        case when ${sends.sql} then 'send' else 'follow' end as level,
        (select owner.subject from auth_identities owner
          where owner.user_id = w.owner_user_id and owner.unlinked_at is null
            and owner.adapter = 'better-auth' and owner.issuer = ?
          order by owner.linked_at, owner.subject limit 1) as owner_subject
      from sessions s
      join workspaces w on w.workspace_id = s.workspace_id
      where w.owner_user_id <> ? and ${reads.sql}
      order by s.updated_at desc, s.session_id
    `).bind(...sends.bind, issuer, who.userId, ...reads.bind)
    .all<Omit<SharedSession, "owner_name"> & { owner_subject: string | null }>()
  const names = new Map<string, Promise<string | null>>()
  const nameOf = (subject: string) => {
    let name = names.get(subject)
    if (!name) names.set(subject, (name = profile?.({ adapter: "better-auth", issuer, subject }).then((found) => found?.name ?? null) ?? Promise.resolve(null)))
    return name
  }
  return Promise.all(rows.results.map(async ({ owner_subject, ...row }) => ({
    ...row,
    owner_name: owner_subject ? await nameOf(owner_subject) : null,
  })))
}

export async function readD1TurnLeaseLive(
  database: D1Database,
  input: { sessionId: string; turnId: string; leaseId: string; fencingToken: number },
  now: number,
) {
  return !!await database.prepare(`
    select 1 from session_turn_leases
    where session_id = ? and turn_id = ? and lease_id = ? and fencing_token = ? and released_at is null and expires_at > ?
  `).bind(input.sessionId, input.turnId, input.leaseId, input.fencingToken, now).first()
}

/**
 * A workspace, and the session id's row and live reservation wherever they
 * are. The id is read alone and a deleted row is still read: an id held under
 * another workspace, or one a deleted session used, is never hosted here.
 */
export async function readD1SessionHostPlacement(database: D1Database, input: { workspaceId: string; sessionId: string }): Promise<SessionHostPlacement | undefined> {
  const row = await database.prepare(`
    select w.backing, w.remote_directory,
      s.workspace_id as session_workspace_id, s.session_host_root, s.deleted_at as session_deleted_at, creator.user_id as session_creator_user_id,
      r.workspace_id as reservation_workspace_id, r.session_host_root as reservation_host_root
    from workspaces w
    left join sessions s on s.session_id = ?
    left join actors creator on creator.actor_id = s.creator_actor_id
    left join session_registration_operations r on r.session_id = ? and r.state <> 'compensated'
    where w.workspace_id = ? and w.deleted_at is null
  `).bind(input.sessionId, input.sessionId, input.workspaceId).first<{
    backing: "cloud-vm" | "local-worktree"
    remote_directory: string | null
    session_workspace_id: string | null
    session_host_root: string | null
    session_deleted_at: number | null
    session_creator_user_id: string | null
    reservation_workspace_id: string | null
    reservation_host_root: string | null
  }>()
  if (!row) return undefined
  return {
    workspace: { backing: row.backing, directory: row.remote_directory },
    ...(row.session_workspace_id === null ? {} : {
      session: {
        workspaceId: row.session_workspace_id, sessionHostRoot: row.session_host_root, deleted: row.session_deleted_at !== null,
        creatorUserId: row.session_creator_user_id,
      },
    }),
    ...(row.reservation_workspace_id === null ? {} : {
      reservation: { workspaceId: row.reservation_workspace_id, sessionHostRoot: row.reservation_host_root },
    }),
  }
}
