import type { SharedSession } from "@claxedo/account-contract"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { AGENT_MESSAGE_PAGE_LIMIT, AgentMessagePageError } from "@claxedo/agent-runtime-contract"
import { asRecord, numberField, parseJson } from "@claxedo/server-core/platform/json/index"
import { latestViewPage, type LatestView } from "@claxedo/server-core/session/latest-view-page"
import type { D1Database } from "@cloudflare/workers-types"
import type { SessionPageQuery } from "@claxedo/server-core/platform/auth/private-session-authority"
import { sessionOrderSql } from "@claxedo/server-core/session/navigation-order"
import { requireHuman } from "./access-context"
import { maySql, type AuthorizationPrincipal, type BoundSql } from "./authorization"
import type { D1ActorProfile } from "./workspace-authority"
import { sessionReaderSql } from "@claxedo/server-core/session/navigation-reader"
import { storedSessionAttention, storedSessionReader } from "@claxedo/server-core/session/reader-contract"
import { storedSessionTurnOutcome } from "@claxedo/server-core/session/turn-outcome-contract"
import { sessionRuntimeAvailableSql } from "./session-runtime-availability"

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
  attention_json: string | null
  last_turn_json: string | null
  reader_json: string | null
  project_name: string | null
  backing: "local-worktree" | "cloud-vm" | null
  workspace_name: string | null
  host_id: string | null
  machine_name: string | null
  owner_user_id: string
  runtime_available: number
}

const COLUMNS = {
  lastHumanTurnAt: "s.last_human_turn_at",
  createdAt: "s.created_at",
  updatedAt: "s.updated_at",
  sessionRef: "('workspace:' || s.workspace_id || ':session:' || s.session_id)",
}

/** `access` is the caller's read predicate over `s`, with the values its placeholders bind. */
function sessionPageQuery(query: SessionPageQuery, access: BoundSql, readerId: string) {
  const where = ["s.deleted_at is null", "s.parent_session_id IS NULL"]
  const params: unknown[] = [readerId]
  if (query.sessionId !== undefined) {
    where.push("s.session_id = ?")
    params.push(query.sessionId)
  }
  const reader = sessionReaderSql({ facts: "s.attention_json", reader: "r.state_json", created: "s.created_at" }, query)
  where.push(...reader.where)
  params.push(...reader.params)
  if (query.ownership === "shared") {
    where.push("EXISTS (SELECT 1 FROM workspaces owner_workspace WHERE owner_workspace.workspace_id = s.workspace_id AND owner_workspace.owner_user_id <> ?)")
    params.push(readerId)
  }
  if ("projectId" in query) {
    where.push("s.project_id = ?")
    params.push(query.projectId)
  } else if ("workspaceId" in query) {
    where.push("s.workspace_id = ?")
    params.push(query.workspaceId)
  }
  if (query.archived === "archived") where.push("s.archived_at is not null")
  if (query.archived === "active") where.push("s.archived_at is null")
  if (query.search) {
    where.push("lower(coalesce(s.title, '')) like ?")
    params.push(`%${query.search.toLowerCase()}%`)
  }
  where.push(access.sql)
  params.push(...access.bind)
  const order = sessionOrderSql(COLUMNS, query.sort, query.after)
  if (order.keyset) {
    where.push(order.keyset.sql)
    params.push(...order.keyset.params)
  }
  return { where, params, order }
}

const SESSION_PAGE_FROM = `FROM sessions s LEFT JOIN session_readers r ON r.session_id = s.session_id AND r.user_id = ?`

export async function readD1SessionPage(database: D1Database, query: SessionPageQuery, who: AuthorizationPrincipal, now: number, orgId?: string) {
  const access = maySql(who, "read", { kind: "session", alias: "s" })
  const project = maySql(who, "read", { kind: "project", alias: "p" })
  const workspace = maySql(who, "open", { kind: "workspace", alias: "w" })
  const { where, params, order } = sessionPageQuery(query, access, who.userId)
  if (orgId) { where.push("s.org_id = ?"); params.push(orgId) }
  const result = await database
    .prepare(`
      select s.session_id, s.workspace_id, s.project_id, s.title, s.created_at, s.updated_at,
        s.last_human_turn_at, s.archived_at, s.status, s.status_at, s.awaiting_input, s.attention_json, s.last_turn_json, r.state_json AS reader_json,
        p.repo_key AS project_name, w.backing, w.display_name AS workspace_name, assignment.host_id,
        ${sessionRuntimeAvailableSql(now)} AS runtime_available,
        (SELECT owner_user_id FROM workspaces owner_workspace WHERE owner_workspace.workspace_id = s.workspace_id) AS owner_user_id,
        (SELECT enrollment.display_name FROM host_enrollments enrollment
          WHERE enrollment.host_id = assignment.host_id AND enrollment.owner_user_id = w.owner_user_id
            AND enrollment.revoked_at IS NULL
          ORDER BY enrollment.created_at DESC LIMIT 1) AS machine_name
      ${SESSION_PAGE_FROM}
      LEFT JOIN projects p ON p.project_id = s.project_id AND ${project.sql}
      LEFT JOIN workspaces w ON w.workspace_id = s.workspace_id AND ${workspace.sql}
      LEFT JOIN host_workspace_assignments assignment ON assignment.workspace_id = w.workspace_id
      where ${where.join(" and ")}
      order by ${order.orderBy}
      limit ?
    `)
    .bind(params[0], ...project.bind, ...workspace.bind, ...params.slice(1), query.limit)
    .all<SessionPageRow>()
  return result.results.map((row) => pageRowJson(row, who.userId))
}

export async function countD1Sessions(database: D1Database, query: SessionPageQuery, access: BoundSql, readerId: string): Promise<number> {
  const { where, params } = sessionPageQuery({ ...query, after: undefined }, access, readerId)
  const row = await database.prepare(`SELECT COUNT(*) AS total ${SESSION_PAGE_FROM} WHERE ${where.join(" AND ")}`).bind(...params).first<{ total: number }>()
  if (!row) throw new Error("Session inventory total is unavailable")
  return row.total
}

function pageRowJson(row: SessionPageRow, readerId: string) {
  return {
    ownership: row.owner_user_id === readerId ? "owned" : "shared",
    ...(row.project_name === null ? {} : { projectName: row.project_name }),
    ...(row.backing === null ? {} : { placement: row.backing === "cloud-vm"
      ? { kind: "cloud", ...(row.workspace_name === null ? {} : { cloudName: row.workspace_name }) }
      : { kind: "machine", ...(row.host_id === null ? {} : { machineId: row.host_id }), ...(row.machine_name === null ? {} : { machineName: row.machine_name }) } }),
    attention: storedSessionAttention(row.attention_json),
    lastTurn: storedSessionTurnOutcome(row.last_turn_json),
    executionAvailability: row.runtime_available === 1 ? { status: "available" } : { status: "unavailable", message: "Session runtime is unavailable" },
    reader: storedSessionReader(row.reader_json),
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
      : { status: row.status, status_at: row.status_at, awaiting_input: row.awaiting_input === 1 }),
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

export async function readD1LatestView(database: D1Database, sessionId: string, workspaceId: string, view: LatestView, end?: number) {
  const endBound = end === undefined ? [] : [end]
  const boundary = await database
    .prepare(`select max(ordinal) as ordinal from session_messages where session_id = ? and workspace_id = ? and role = 'user'${end === undefined ? "" : " and ordinal < ?"}`)
    .bind(sessionId, workspaceId, ...endBound)
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
