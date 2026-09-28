import { jsonRecord } from "@claxedo/server-core/platform/runtime/lib/json"
import { trimToUndefined } from "@claxedo/helpers/string"
import { asRecordOrEmpty } from "@claxedo/helpers/guards"
import type { SessionListSort, SessionOrderKey } from "./navigation-order"

export type { SessionListSort, SessionOrderKey } from "./navigation-order"
export type SessionListScope = "global" | "project" | "workspace"
export type SessionListArchiveMode = "active" | "all" | "archived"

export type SessionListQuery = {
  scope: SessionListScope
  projectId?: string
  workspaceId?: string
  directory?: string
  archived: SessionListArchiveMode
  status: string[]
  search?: string
  sort: SessionListSort
  limit: number
  cursor?: string
  /**
   * The order key of the last row the reader holds: the page is the rows
   * after it. A reader merging several servers' pages resumes each from the
   * merge's own position with it. `cursor` is v1's opaque form of the same
   * position and is deleted with v1.
   */
  after?: SessionOrderKey
}

export type SessionNavigationRow = {
  type: "session"
  sessionRef: string
  sessionId: string
  title: string
  directory: string
  workspaceId?: string
  projectId?: string
  createdAt: number
  updatedAt: number
  /**
   * When a human last started a turn here. `updatedAt` moves for any actor's turn —
   * a wake, a subagent, a channel message — so the session list bands on this instead.
   * Absent for a session only agents have driven, and for one that predates the field.
   */
  lastHumanTurnAt?: number
  archivedAt?: number
  tags: string[]
  attachments: Array<{ kind: string; targetId?: string }>
  /** Session creator — used for owner favicon on shared/other-user rows. */
  owner?: {
    name?: string
    avatarUrl?: string
    publicId?: string
  }
  status?: SessionRowStatus
}

/**
 * The last status the session's runtime reported, as the store that lists the
 * row last heard it. `awaitingInput` is an open permission or question.
 */
export type SessionRowStatus = {
  kind: SessionRowStatusKind
  awaitingInput: boolean
  at: number
}

export type SessionRowStatusKind = "idle" | "busy" | "retry" | "recovering"

export type SessionListResponse = {
  view: {
    scope: SessionListScope
    sort: SessionListSort
    limit: number
  }
  items: SessionNavigationRow[]
  nextCursor?: string
  /** The `after` that reads the next page; present only when more rows follow. */
  nextAfter?: string
  totalKnown?: number
}

type CursorShape = SessionOrderKey & { query: string }

/**
 * One keyset page of a query: the rows after `after` in `sort`, at most
 * `limit` of them. `limit` is one more than the page so the reader learns
 * whether another page follows without a count.
 */
export type SessionListKeysetPage = {
  sort: SessionListSort
  archived: SessionListArchiveMode
  search?: string
  limit: number
  after?: SessionOrderKey
}

export function parseSessionListQuery(url: URL): SessionListQuery {
  const scope = scopeValue(url.searchParams.get("scope"))
  return {
    scope,
    ...(trimToUndefined(url.searchParams.get("projectId")) ? { projectId: trimToUndefined(url.searchParams.get("projectId")) } : {}),
    ...(trimToUndefined(url.searchParams.get("workspaceId")) ? { workspaceId: trimToUndefined(url.searchParams.get("workspaceId")) } : {}),
    ...(trimToUndefined(url.searchParams.get("directory")) ? { directory: trimToUndefined(url.searchParams.get("directory")) } : {}),
    archived: archivedValue(url.searchParams.get("archived")),
    status: list(url.searchParams.get("status")),
    ...(trimToUndefined(url.searchParams.get("search")) ? { search: trimToUndefined(url.searchParams.get("search")) } : {}),
    sort: sortValue(url.searchParams.get("sort")),
    limit: limitValue(url.searchParams.get("limit")),
    ...(trimToUndefined(url.searchParams.get("cursor")) ? { cursor: trimToUndefined(url.searchParams.get("cursor")) } : {}),
    ...afterParam(url.searchParams.get("after"), url.searchParams.has("cursor")),
  }
}

export function buildSessionListResponse(input: {
  query: SessionListQuery
  sessions: readonly unknown[]
  cursorApplied?: boolean
}): SessionListResponse {
  const rows = input.sessions
    .filter((session) => !parentSessionId(session))
    .map(sessionNavigationRow)
    .filter((row): row is SessionNavigationRow => !!row)
    .filter((row) => rowInScope(row, input.query))
    .filter((row) => rowMatchesArchive(row, input.query.archived))
    .filter((row) => valuesMatch(input.query.status, rowStatusValues(row)))
    .filter((row) => !input.query.search || row.title.toLowerCase().includes(input.query.search.toLowerCase()))
    .sort((a, b) => compareRows(a, b, input.query.sort))

  const page = pageRows(input.query, rows, input.cursorApplied)
  return {
    view: view(input.query),
    items: page.items,
    totalKnown: rows.length,
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    ...(page.nextAfter ? { nextAfter: page.nextAfter } : {}),
  }
}

export function sessionListStoreFilter(query: SessionListQuery) {
  return {
    ...(query.scope === "workspace" && query.workspaceId ? { workspaceID: query.workspaceId } : {}),
    ...(query.scope === "workspace" && query.directory ? { directory: query.directory } : {}),
    includeArchived: query.archived !== "active",
  }
}

export function sessionListKeysetPage(query: SessionListQuery): SessionListKeysetPage {
  const cursor = cursorOfQuery(query)
  return {
    sort: query.sort,
    archived: query.archived,
    ...(query.search ? { search: query.search } : {}),
    limit: query.limit + 1,
    ...(cursor ? { after: sessionOrderKey(cursor) } : {}),
  }
}

export function sessionListStorePageFilter(query: SessionListQuery) {
  const page = sessionListKeysetPage(query)
  return {
    ...(query.scope === "project" && query.projectId ? { projectID: query.projectId } : {}),
    ...(query.scope === "workspace" && query.workspaceId ? { workspaceID: query.workspaceId } : {}),
    ...(query.scope === "workspace" && query.directory ? { directory: query.directory } : {}),
    global: query.scope === "global",
    archived: page.archived,
    status: query.status,
    search: page.search,
    limit: page.limit,
    sort: page.sort,
    ...(page.after ? { cursor: page.after } : {}),
  }
}

function pageRows(query: SessionListQuery, rows: SessionNavigationRow[], cursorApplied?: boolean) {
  const cursor = cursorOfQuery(query)
  const window = cursor && !cursorApplied
    ? rows.filter((row) => rowAfterCursor(row, cursor, query.sort))
    : rows
  const items = window.slice(0, query.limit)
  const last = items[items.length - 1]
  const more = items.length < window.length && last
  return {
    items,
    nextCursor: more ? encodeCursor(query, last) : undefined,
    nextAfter: more ? encodeSessionListAfter(last) : undefined,
  }
}

function view(query: SessionListQuery) {
  return {
    scope: query.scope,
    sort: query.sort,
    limit: query.limit,
  }
}

function sessionNavigationRow(session: unknown): SessionNavigationRow | undefined {
  const item = record(session)
  const sessionId = stringValue(item.sessionID) ?? stringValue(item.session_id) ?? stringValue(item.id)
  if (!sessionId) return undefined
  const workspaceId = stringValue(item.workspaceID) ?? stringValue(item.workspace_id)
  const projectId = stringValue(item.projectID) ?? stringValue(item.project_id)
  if (item.host !== undefined && item.host !== "workspace") return undefined
  const directory = stringValue(item.directory) ?? workspaceId ?? "global"
  const createdAt = numberValue(item.createdAt) ?? numberValue(item.created_at) ?? 0
  const updatedAt = numberValue(item.updatedAt) ?? numberValue(item.updated_at) ?? createdAt
  const lastHumanTurnAt = numberValue(item.lastHumanTurnAt) ?? numberValue(item.last_human_turn_at)
  const archivedAt = numberValue(item.archived) ?? numberValue(item.archived_at)
  return {
    type: "session",
    sessionRef: stringValue(item.sessionRef) ?? stringValue(item.session_ref) ?? sessionRef({ sessionId, workspaceId, directory }),
    sessionId,
    title: trimToUndefined(item.title) ?? "Untitled session",
    directory,
    ...(workspaceId ? { workspaceId } : {}),
    ...(projectId ? { projectId } : {}),
    createdAt,
    updatedAt,
    ...(lastHumanTurnAt !== undefined ? { lastHumanTurnAt } : {}),
    ...(archivedAt ? { archivedAt } : {}),
    tags: stringArray(item.tags),
    attachments: arrayValue(item.attachments).flatMap((attachment) => {
      const row = asRecordOrEmpty(attachment)
      const kind = trimToUndefined(row.kind)
      if (!kind) return []
      return [{
        kind,
        targetId: trimToUndefined(row.targetID) ?? trimToUndefined(row.target_id),
      }]
    }),
    ...ownerFromSession(item),
    ...statusFromSession(item),
  }
}

function statusFromSession(item: Record<string, unknown>): { status?: SessionRowStatus } {
  const nested = asRecordOrEmpty(item.status)
  const kind = statusKind(nested.kind ?? item.status)
  const at = numberValue(nested.at) ?? numberValue(item.status_at)
  if (!kind || at === undefined) return {}
  const awaitingInput = nested.awaitingInput ?? item.awaiting_input
  return { status: { kind, awaitingInput: awaitingInput === true || awaitingInput === 1, at } }
}

function statusKind(input: unknown): SessionRowStatusKind | undefined {
  return input === "idle" || input === "busy" || input === "retry" || input === "recovering" ? input : undefined
}

/**
 * A child session's parent, under every spelling a producer answers with.
 *
 * `GET /session` makes root-only an opt-in `roots=true` because its full
 * snapshot is what reconciles the session-meta projection. This list has no
 * such reader — it is the rail's paginated navigation source and nothing else —
 * so a parented session is never one of its rows and the caller cannot forget
 * to ask.
 */
function parentSessionId(session: unknown) {
  const item = record(session)
  return stringValue(item.parentID) ??
    stringValue(item.parent_session_id) ??
    stringValue(item.parentSessionId)
}

function ownerFromSession(item: Record<string, unknown>): { owner?: SessionNavigationRow["owner"] } {
  const nested = asRecordOrEmpty(item.owner)
  const name = trimToUndefined(nested.name)
    ?? trimToUndefined(item.owner_name)
    ?? trimToUndefined(item.ownerName)
  const avatarUrl = trimToUndefined(nested.avatarUrl)
    ?? trimToUndefined(nested.avatar_url)
    ?? trimToUndefined(item.owner_avatar_url)
    ?? trimToUndefined(item.ownerAvatarUrl)
  const publicId = trimToUndefined(nested.publicId)
    ?? trimToUndefined(nested.public_id)
    ?? trimToUndefined(item.owner_public_id)
    ?? trimToUndefined(item.ownerPublicId)
  if (!name && !avatarUrl && !publicId) return {}
  return {
    owner: {
      ...(name ? { name } : {}),
      ...(avatarUrl ? { avatarUrl } : {}),
      ...(publicId ? { publicId } : {}),
    },
  }
}

function sessionRef(input: { sessionId: string; workspaceId?: string; directory: string }) {
  if (input.workspaceId) return `workspace:${input.workspaceId}:session:${input.sessionId}`
  return `local:${input.directory}:session:${input.sessionId}`
}

/** Substitutes `{}` for a non-object so callers can index unconditionally. */
function record(input: unknown): Record<string, unknown> {
  return jsonRecord(input) ?? {}
}

function stringValue(input: unknown) {
  return typeof input === "string" && input.trim() ? input.trim() : undefined
}

function numberValue(input: unknown) {
  return typeof input === "number" && Number.isFinite(input) ? input : undefined
}

function arrayValue(input: unknown) {
  return Array.isArray(input) ? input : []
}

function stringArray(input: unknown) {
  return arrayValue(input).filter((item): item is string => typeof item === "string")
}

function rowInScope(row: SessionNavigationRow, query: SessionListQuery) {
  if (query.scope === "global") return row.tags.includes("global:default") || row.tags.includes("global") || row.directory === "global"
  if (query.scope === "project") return !query.projectId || row.projectId === query.projectId
  if (query.workspaceId && row.workspaceId === query.workspaceId) return true
  return !query.directory || row.directory === query.directory
}

function rowMatchesArchive(row: SessionNavigationRow, archived: SessionListArchiveMode) {
  if (archived === "all") return true
  if (archived === "archived") return !!row.archivedAt
  return !row.archivedAt
}

function rowStatusValues(row: SessionNavigationRow) {
  return [
    ...row.tags,
    ...row.attachments.map((item) => item.kind),
    row.archivedAt ? "archived" : "active",
  ]
}

function valuesMatch(filters: string[], values: string[]) {
  if (!filters.length) return true
  return filters.some((filter) => values.includes(filter))
}

/**
 * A sort's key tuple for one row, most significant first. The comparator and the
 * cursor window both read it, so a page boundary cannot disagree with the order
 * it pages through. A session nobody has ever prompted keys on 0, which sorts it
 * below every session that has a human turn, where `sessionOrderSql` puts its
 * NULL.
 */
function sortKey(
  row: { createdAt: number; updatedAt: number; lastHumanTurnAt?: number },
  sort: SessionListSort,
) {
  if (sort === "human_turn_desc") return [row.lastHumanTurnAt ?? 0, row.createdAt]
  if (sort === "created_desc") return [row.createdAt]
  return [row.updatedAt]
}

/**
 * Descending in `sort`, then by `sessionRef` in code-unit order, the order
 * SQLite's `<` gives the stores' keysets. `localeCompare` would disagree with
 * them on punctuation, and a merge of a store's page with a sorted one would
 * then repeat or skip the row at the boundary.
 */
export function compareSessionOrder(a: SessionOrderKey, b: SessionOrderKey, sort: SessionListSort) {
  const left = sortKey(a, sort)
  const right = sortKey(b, sort)
  for (const [index, value] of left.entries()) {
    const other = right[index] ?? 0
    if (other !== value) return other - value
  }
  if (a.sessionRef === b.sessionRef) return 0
  return a.sessionRef < b.sessionRef ? 1 : -1
}

function compareRows(a: SessionNavigationRow, b: SessionNavigationRow, sort: SessionListSort = "updated_desc") {
  return compareSessionOrder(sessionOrderKey(a), sessionOrderKey(b), sort)
}

function rowAfterCursor(row: SessionNavigationRow, cursor: SessionOrderKey, sort: SessionListSort) {
  return compareSessionOrder(sessionOrderKey(row), cursor, sort) > 0
}

export function sessionOrderKey(row: SessionOrderKey): SessionOrderKey {
  return {
    updatedAt: row.updatedAt,
    createdAt: row.createdAt,
    ...(row.lastHumanTurnAt !== undefined ? { lastHumanTurnAt: row.lastHumanTurnAt } : {}),
    sessionRef: row.sessionRef,
  }
}

function cursorOfQuery(query: SessionListQuery): SessionOrderKey | undefined {
  if (query.after) return query.after
  if (!query.cursor) return undefined
  const cursor = decodeCursor(query.cursor)
  if (cursor.query !== querySignature(query)) throw new Error("invalid_session_list_cursor")
  return cursor
}

function encodeCursor(query: SessionListQuery, row: SessionNavigationRow) {
  return Buffer.from(JSON.stringify({
    query: querySignature(query),
    ...sessionOrderKey(row),
  } satisfies CursorShape), "utf8").toString("base64url")
}

function decodeCursor(value: string): CursorShape {
  const parsed = parseCursorJson(value)
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof parsed.query !== "string" ||
    typeof parsed.updatedAt !== "number" ||
    typeof parsed.createdAt !== "number" ||
    typeof parsed.sessionRef !== "string" ||
    ("lastHumanTurnAt" in parsed && typeof parsed.lastHumanTurnAt !== "number")
  ) {
    throw new Error("invalid_session_list_cursor")
  }
  return parsed
}

export function encodeSessionListAfter(key: SessionOrderKey) {
  return Buffer.from(JSON.stringify(sessionOrderKey(key)), "utf8").toString("base64url")
}

function afterParam(value: string | null, withCursor: boolean): { after?: SessionOrderKey } {
  const raw = trimToUndefined(value)
  if (!raw) return {}
  if (withCursor) throw new Error("invalid_session_list_cursor")
  const parsed = parseCursorJson(raw)
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof parsed.updatedAt !== "number" ||
    typeof parsed.createdAt !== "number" ||
    typeof parsed.sessionRef !== "string" ||
    ("lastHumanTurnAt" in parsed && typeof parsed.lastHumanTurnAt !== "number")
  ) {
    throw new Error("invalid_session_list_cursor")
  }
  return { after: sessionOrderKey(parsed) }
}

function parseCursorJson(value: string) {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8"))
  } catch {
    throw new Error("invalid_session_list_cursor")
  }
}

function querySignature(query: SessionListQuery) {
  return JSON.stringify({
    scope: query.scope,
    projectId: query.projectId,
    workspaceId: query.workspaceId,
    directory: query.directory,
    archived: query.archived,
    status: query.status,
    search: query.search,
    sort: query.sort,
    limit: query.limit,
  })
}

function scopeValue(input: string | null): SessionListScope {
  if (input === "project" || input === "workspace") return input
  return "global"
}

function sortValue(input: string | null): SessionListSort {
  if (input === "created_desc" || input === "human_turn_desc") return input
  return "updated_desc"
}

function archivedValue(input: string | null): SessionListArchiveMode {
  if (input === "all" || input === "archived") return input
  return "active"
}

function limitValue(input: string | null) {
  const parsed = Number(input ?? 50)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return 50
  return Math.min(parsed, 100)
}

function list(input: string | null) {
  return input?.split(",").map((item) => item.trim()).filter(Boolean) ?? []
}
