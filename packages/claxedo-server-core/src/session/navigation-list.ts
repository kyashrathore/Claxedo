import type { SessionMeta } from "./meta/index"

export type SessionListScope = "global" | "project" | "workspace"
export type SessionListGroupBy = "none" | "project" | "workspace"
export type SessionListArchiveMode = "active" | "all" | "archived"

export type SessionListSort = "updated_desc" | "created_desc"

export type SessionListQuery = {
  scope: SessionListScope
  projectId?: string
  workspaceId?: string
  directory?: string
  groupBy: SessionListGroupBy
  archived: SessionListArchiveMode
  status: string[]
  environment: string[]
  git: string[]
  search?: string
  sort: SessionListSort
  limit: number
  cursor?: string
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
  archivedAt?: number
  tags: string[]
  attachments: Array<{ kind: string; targetId?: string }>
  environment?: { kind?: string; driver?: string }
  git?: { repo?: string; branch?: string; remote?: string }
}

export type SessionListResponse = {
  view: {
    scope: SessionListScope
    groupBy: SessionListGroupBy
    sort: SessionListSort
    limit: number
  }
  items?: SessionNavigationRow[]
  groups?: Array<{
    id: string
    label: string
    items: SessionNavigationRow[]
    nextCursor?: string
    totalKnown?: number
  }>
  nextCursor?: string
  totalKnown?: number
}

type CursorShape = {
  query: string
  updatedAt: number
  createdAt?: number
  sessionId: string
  sessionRef?: string
}

export function parseSessionListQuery(url: URL): SessionListQuery {
  const scope = scopeValue(url.searchParams.get("scope"))
  const groupBy = groupByValue(url.searchParams.get("groupBy"))
  return {
    scope,
    ...(text(url.searchParams.get("projectId")) ? { projectId: text(url.searchParams.get("projectId")) } : {}),
    ...(text(url.searchParams.get("workspaceId")) ? { workspaceId: text(url.searchParams.get("workspaceId")) } : {}),
    ...(text(url.searchParams.get("directory")) ? { directory: text(url.searchParams.get("directory")) } : {}),
    groupBy,
    archived: archivedValue(url.searchParams.get("archived")),
    status: list(url.searchParams.get("status") ?? url.searchParams.get("filter.status")),
    environment: list(url.searchParams.get("environment") ?? url.searchParams.get("filter.environment")),
    git: list(url.searchParams.get("git") ?? url.searchParams.get("filter.git")),
    ...(text(url.searchParams.get("search")) ? { search: text(url.searchParams.get("search")) } : {}),
    sort: sortValue(url.searchParams.get("sort")),
    limit: limitValue(url.searchParams.get("limit")),
    ...(text(url.searchParams.get("cursor")) ? { cursor: text(url.searchParams.get("cursor")) } : {}),
  }
}

export function buildSessionListResponse(input: {
  query: SessionListQuery
  sessions: readonly unknown[]
  cursorApplied?: boolean
}): SessionListResponse {
  const rows = input.sessions
    .map(sessionNavigationRow)
    .filter((row): row is SessionNavigationRow => !!row)
    .filter((row) => rowInScope(row, input.query))
    .filter((row) => rowMatchesArchive(row, input.query.archived))
    .filter((row) => valuesMatch(input.query.status, rowStatusValues(row)))
    .filter((row) => valuesMatch(input.query.environment, rowEnvironmentValues(row)))
    .filter((row) => valuesMatch(input.query.git, rowGitValues(row)))
    .filter((row) => !input.query.search || row.title.toLowerCase().includes(input.query.search.toLowerCase()))
    .sort((a, b) => compareRows(a, b, input.query.sort))

  if (input.query.groupBy !== "none") {
    return groupedResponse(input.query, rows)
  }

  const page = pageRows(input.query, rows, input.cursorApplied)
  return {
    view: view(input.query),
    items: page.items,
    totalKnown: rows.length,
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
  }
}

export function sessionListStoreFilter(query: SessionListQuery) {
  return {
    ...(query.scope === "workspace" && query.workspaceId ? { workspaceID: query.workspaceId } : {}),
    ...(query.scope === "workspace" && query.directory ? { directory: query.directory } : {}),
    includeArchived: query.archived !== "active",
  }
}

export function sessionListStorePageFilter(query: SessionListQuery) {
  const cursor = query.cursor ? decodeCursor(query.cursor) : undefined
  if (cursor && cursor.query !== querySignature(query)) {
    throw new Error("invalid_session_list_cursor")
  }
  return {
    ...(query.scope === "project" && query.projectId ? { projectID: query.projectId } : {}),
    ...(query.scope === "workspace" && query.workspaceId ? { workspaceID: query.workspaceId } : {}),
    ...(query.scope === "workspace" && query.directory ? { directory: query.directory } : {}),
    global: query.scope === "global",
    archived: query.archived,
    status: query.status,
    search: query.search,
    limit: query.limit + 1,
    sort: query.sort,
    ...(cursor ? {
      cursor: {
        updatedAt: cursor.updatedAt,
        ...(cursor.createdAt !== undefined ? { createdAt: cursor.createdAt } : {}),
        sessionID: cursor.sessionId,
        sessionRef: cursor.sessionRef,
      },
    } : {}),
  }
}

function groupedResponse(query: SessionListQuery, rows: SessionNavigationRow[]): SessionListResponse {
  return {
    view: view(query),
    groups: [...groupRows(rows, query.groupBy).entries()].map(([id, items]) => {
      const page = pageRows(query, items)
      return {
        id,
        label: id,
        items: page.items,
        totalKnown: items.length,
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      }
    }),
  }
}

function pageRows(query: SessionListQuery, rows: SessionNavigationRow[], cursorApplied?: boolean) {
  const cursor = query.cursor ? decodeCursor(query.cursor) : undefined
  if (cursor && cursor.query !== querySignature(query)) {
    throw new Error("invalid_session_list_cursor")
  }
  const window = cursor && !cursorApplied
    ? rows.filter((row) => {
      const key = query.sort === "created_desc" ? row.createdAt : row.updatedAt
      const cursorKey = query.sort === "created_desc"
        ? (cursor.createdAt ?? cursor.updatedAt)
        : cursor.updatedAt
      return key < cursorKey || (key === cursorKey && row.sessionRef < (cursor.sessionRef ?? cursor.sessionId))
    })
    : rows
  const items = window.slice(0, query.limit)
  const last = items[items.length - 1]
  return {
    items,
    nextCursor: items.length < window.length && last ? encodeCursor(query, last) : undefined,
  }
}

function view(query: SessionListQuery) {
  return {
    scope: query.scope,
    groupBy: query.groupBy,
    sort: query.sort,
    limit: query.limit,
  }
}

function groupRows(rows: SessionNavigationRow[], groupBy: SessionListGroupBy) {
  const groups = new Map<string, SessionNavigationRow[]>()
  for (const row of rows) {
    const id = groupBy === "project" ? row.projectId ?? row.directory : row.workspaceId ?? row.directory
    groups.set(id, [...(groups.get(id) ?? []), row])
  }
  return new Map([...groups.entries()].sort(([a], [b]) => a.localeCompare(b)))
}

function sessionNavigationRow(session: unknown): SessionNavigationRow | undefined {
  const item = record(session)
  const sessionId = stringValue(item.sessionID) ?? stringValue(item.session_id) ?? stringValue(item.id)
  if (!sessionId) return
  const workspaceId = stringValue(item.workspaceID) ?? stringValue(item.workspace_id)
  const projectId = stringValue(item.projectID) ?? stringValue(item.project_id)
  const host = item.host === "central" ? "central" : "workspace"
  const directory = stringValue(item.directory) ?? workspaceId ?? "global"
  const createdAt = numberValue(item.createdAt) ?? numberValue(item.created_at) ?? 0
  const updatedAt = numberValue(item.updatedAt) ?? numberValue(item.updated_at) ?? createdAt
  const archivedAt = numberValue(item.archived) ?? numberValue(item.archived_at)
  const environment = record(item.environment)
  const git = record(item.git)
  return {
    type: "session",
    sessionRef: stringValue(item.sessionRef) ?? stringValue(item.session_ref) ?? sessionRef({ sessionId, workspaceId, directory, host }),
    sessionId,
    title: stringValue(item.title) ?? "Untitled session",
    directory,
    ...(workspaceId ? { workspaceId } : {}),
    ...(projectId ? { projectId } : {}),
    createdAt,
    updatedAt,
    ...(archivedAt ? { archivedAt } : {}),
    tags: stringArray(item.tags),
    attachments: arrayValue(item.attachments).flatMap((attachment) => {
      const row = record(attachment)
      const kind = stringValue(row.kind)
      if (!kind) return []
      return [{
        kind,
        targetId: stringValue(row.targetID) ?? stringValue(row.target_id),
      }]
    }),
    ...(Object.keys(environment).length ? { environment: {
      ...(stringValue(environment.kind) ? { kind: stringValue(environment.kind) } : {}),
      ...(stringValue(environment.driver) ? { driver: stringValue(environment.driver) } : {}),
    } } : {}),
    ...(Object.keys(git).length ? { git: {
      ...(stringValue(git.repo) ? { repo: stringValue(git.repo) } : {}),
      ...(stringValue(git.branch) ? { branch: stringValue(git.branch) } : {}),
      ...(stringValue(git.remote) ? { remote: stringValue(git.remote) } : {}),
    } } : {}),
  }
}

function sessionRef(input: { sessionId: string; workspaceId?: string; directory: string; host: SessionMeta["host"] }) {
  if (input.host === "central") return `central:${input.sessionId}`
  if (input.workspaceId) return `workspace:${input.workspaceId}:session:${input.sessionId}`
  return `local:${input.directory}:session:${input.sessionId}`
}

function record(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" ? input as Record<string, unknown> : {}
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

function rowEnvironmentValues(row: SessionNavigationRow) {
  return [
    row.environment?.kind,
    row.environment?.driver ? `driver:${row.environment.driver}` : undefined,
  ].filter((item): item is string => !!item)
}

function rowGitValues(row: SessionNavigationRow) {
  return [
    row.git?.repo ? `repo:${row.git.repo}` : undefined,
    row.git?.branch ? `branch:${row.git.branch}` : undefined,
    row.git?.remote,
  ].filter((item): item is string => !!item)
}

function valuesMatch(filters: string[], values: string[]) {
  if (!filters.length) return true
  return filters.some((filter) => values.includes(filter))
}

function compareRows(a: SessionNavigationRow, b: SessionNavigationRow, sort: SessionListSort = "updated_desc") {
  if (sort === "created_desc") {
    return b.createdAt - a.createdAt || b.sessionRef.localeCompare(a.sessionRef)
  }
  return b.updatedAt - a.updatedAt || b.sessionRef.localeCompare(a.sessionRef)
}

function encodeCursor(query: SessionListQuery, row: SessionNavigationRow) {
  return Buffer.from(JSON.stringify({
    query: querySignature(query),
    updatedAt: row.updatedAt,
    createdAt: row.createdAt,
    sessionId: row.sessionId,
    sessionRef: row.sessionRef,
  } satisfies CursorShape), "utf8").toString("base64url")
}

function decodeCursor(value: string): CursorShape {
  const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"))
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof parsed.query !== "string" ||
    typeof parsed.updatedAt !== "number" ||
    typeof parsed.sessionId !== "string" ||
    ("sessionRef" in parsed && typeof parsed.sessionRef !== "string") ||
    ("createdAt" in parsed && typeof parsed.createdAt !== "number")
  ) {
    throw new Error("invalid_session_list_cursor")
  }
  return parsed
}

function querySignature(query: SessionListQuery) {
  return JSON.stringify({
    scope: query.scope,
    projectId: query.projectId,
    workspaceId: query.workspaceId,
    directory: query.directory,
    groupBy: query.groupBy,
    archived: query.archived,
    status: query.status,
    environment: query.environment,
    git: query.git,
    search: query.search,
    sort: query.sort,
    limit: query.limit,
  })
}

function scopeValue(input: string | null): SessionListScope {
  if (input === "project" || input === "workspace") return input
  return "global"
}

function groupByValue(input: string | null): SessionListGroupBy {
  if (input === "project" || input === "workspace") return input
  return "none"
}

function sortValue(input: string | null): SessionListSort {
  if (input === "created_desc") return "created_desc"
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

function text(input: string | null) {
  const value = input?.trim()
  return value ? value : undefined
}

function list(input: string | null) {
  return input?.split(",").map((item) => item.trim()).filter(Boolean) ?? []
}
