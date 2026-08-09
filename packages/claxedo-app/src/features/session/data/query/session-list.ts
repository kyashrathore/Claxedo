import { queryOptions } from "@tanstack/solid-query"
import { authFetch, getClaxedoServerUrl, normalizeUrl } from "@/platform/api/api"
import { centralTransportForServer } from "@/platform/runtime/transport"
import {
  sessionNavigationListUrl,
  type ControlSessionNavigationListQuery,
} from "@/platform/runtime/agent/workspace-control-routes"
import type { SessionNavigationRow } from "../../ui/navigation/session-navigation"
import { queryKeys } from "@/platform/query/keys"
import { queryClient } from "@/platform/query/query-client"

export type SessionListQuery = ControlSessionNavigationListQuery

export type SessionListResponse = {
  view: {
    scope: SessionListQuery["scope"]
    groupBy: NonNullable<SessionListQuery["groupBy"]>
    sort: "updated_desc"
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

function sessionListBaseQuery(query: SessionListQuery): SessionListQuery {
  if (!query.cursor) return query
  const { cursor: _cursor, ...base } = query
  return base
}

function mergeSessionListItems(primary: readonly SessionNavigationRow[], tail: readonly SessionNavigationRow[]) {
  const seen = new Set(primary.map((item) => item.sessionRef))
  return [
    ...primary,
    ...tail.filter((item) => {
      if (seen.has(item.sessionRef)) return false
      seen.add(item.sessionRef)
      return true
    }),
  ]
}

function mergeSessionListResponses(input: {
  current: SessionListResponse | undefined
  page: SessionListResponse
  append: boolean
}) {
  if (!input.current?.items || !input.page.items) return input.page
  const items = input.append
    ? mergeSessionListItems(input.current.items, input.page.items)
    : mergeSessionListItems(input.page.items, input.current.items)
  return {
    ...input.page,
    items,
    // Appending a freshly loaded page ("Load more") always advances to that
    // page's own cursor — including `undefined` once the server reports no
    // further pages — otherwise the cache would keep repeating the first
    // page's stale cursor forever and "Load more" would never disappear. A
    // base refetch (append=false) instead preserves the deeper cursor from
    // `current` when the merge kept an already-loaded tail beyond what this
    // fresh page covers, so refetching page one doesn't collapse pagination
    // state the user already scrolled past.
    nextCursor: input.append
      ? input.page.nextCursor
      : items.length > input.page.items.length ? input.current.nextCursor : input.page.nextCursor,
    totalKnown: Math.max(input.current.totalKnown ?? 0, input.page.totalKnown ?? 0, items.length),
  }
}

export function appendSessionListPageQueryData(input: {
  baseUrl?: string
  query: SessionListQuery
  page: SessionListResponse
}) {
  const key = queryKeys.shell.sessionList(input.baseUrl, sessionListBaseQuery(input.query))
  const next = mergeSessionListResponses({
    current: queryClient.getQueryData<SessionListResponse>(key),
    page: input.page,
    append: true,
  })
  setSessionListQueryData(key, next)
  return next
}

function setSessionListQueryData(
  key: ReturnType<typeof queryKeys.shell.sessionList>,
  value: SessionListResponse | ((current: SessionListResponse | undefined) => SessionListResponse | undefined),
) {
  queryClient.setQueryData<SessionListResponse>(key, value)
}

export function sessionListRequest(input: {
  baseUrl?: string
  request?: typeof fetch
}) {
  if (input.request) return input.request
  if (centralTransportForServer(input.baseUrl) === "loopback") return globalThis.fetch
  return authFetch
}

export function sessionListQueryOptions(input: {
  baseUrl?: string
  query: SessionListQuery
  request?: typeof fetch
}) {
  return queryOptions({
    queryKey: queryKeys.shell.sessionList(input.baseUrl, input.query),
    queryFn: async () => {
      const res = await sessionListRequest(input)(sessionNavigationListUrl({
        baseUrl: normalizeUrl(input.baseUrl) ?? getClaxedoServerUrl(),
        ...input.query,
      }), {
        headers: {
          Accept: "application/json",
          ...(input.query.directory || input.query.workspaceId || input.query.projectId ? {
            "x-opencode-directory": input.query.directory ?? `workspace:${input.query.workspaceId ?? input.query.projectId}`,
          } : {}),
        },
      })
      if (!res.ok) throw new Error((await res.text()) || `Session list request failed: ${res.status}`)
      const page = await res.json() as SessionListResponse
      if (input.query.cursor) return page
      return mergeSessionListResponses({
        current: queryClient.getQueryData<SessionListResponse>(
          queryKeys.shell.sessionList(input.baseUrl, sessionListBaseQuery(input.query)),
        ),
        page,
        append: false,
      })
    },
  })
}

// A harness/non-opencode `POST /session` only publishes a `session.lifecycle`
// "created" event; it never streams the per-directory session rows the way an
// interactive session does. The flat inventory (`GET /api/control/sessions`)
// already refetches on that event, but the paginated per-section query
// (the product-specific session-list route) that actually feeds the rendered rail rows
// does not — so the new session stays invisible until a full reload. Invalidate
// every session-list query so the active section refetches and the row appears.
export function invalidateSessionListQueries(input: { baseUrl?: string } = {}) {
  const base = input.baseUrl === undefined ? undefined : normalizedBase(input.baseUrl)
  return queryClient.invalidateQueries({
    predicate: (query) => isSessionListQueryKey(query.queryKey, base),
  })
}

// A `session.lifecycle` "created" doorbell races the server's projection write:
// the event is published before the response-tap records the row, so the
// invalidation refetch can return a list that still lacks the new session (the
// row then only shows up on the NEXT invalidation). The event carries the full
// session, so upsert the row into matching active queries directly — the
// refetch that follows stays the source of truth and reconciles any drift.
export function upsertCreatedSessionListRow(input: {
  baseUrl?: string
  row: Omit<SessionNavigationRow, "type" | "sessionRef" | "tags" | "attachments">
}) {
  const workspaceId = input.row.workspaceId
  const row: SessionNavigationRow = {
    ...input.row,
    type: "session",
    sessionRef: workspaceId
      ? `workspace:${workspaceId}:session:${input.row.sessionId}`
      : `local:${input.row.directory}:session:${input.row.sessionId}`,
    tags: [],
    attachments: [],
  }
  const base = input.baseUrl === undefined ? undefined : normalizedBase(input.baseUrl)
  for (const query of queryClient.getQueryCache().findAll({
    predicate: (query) => isSessionListQueryKey(query.queryKey, base),
  })) {
    const listQuery = sessionListQueryFromKey(query.queryKey)
    if (!listQuery || listQuery.cursor || !rowMatchesSessionListQuery(row, listQuery)) continue
    setSessionListQueryData(query.queryKey as ReturnType<typeof queryKeys.shell.sessionList>, (response) => {
      if (!response) return response
      if (response.items?.some((item) => item.sessionRef === row.sessionRef)) return response
      return {
        ...response,
        ...(response.items ? { items: [row, ...response.items] } : {}),
        totalKnown: response.totalKnown === undefined ? undefined : response.totalKnown + 1,
      }
    })
  }
}

function sessionListQueryFromKey(key: readonly unknown[]): SessionListQuery | undefined {
  const query = key[3]
  return query && typeof query === "object" ? query as SessionListQuery : undefined
}

// Mirrors the server's `rowInScope` for the unfiltered default views. Views
// with active status/environment/git filters are left to the refetch.
function rowMatchesSessionListQuery(row: SessionNavigationRow, query: SessionListQuery) {
  if (query.scope === "global") return false
  if (query.archived === "archived") return false
  if (query.status?.length || query.environment?.length || query.git?.length) return false
  if (query.scope === "project") return !query.projectId || row.projectId === query.projectId
  if (query.workspaceId && row.workspaceId === query.workspaceId) return true
  return !query.directory || row.directory === query.directory
}

export function reconcileArchivedSessionListQueryData(input: {
  baseUrl?: string
  sessionRef: string
  archivedAt: number
}) {
  const base = normalizedBase(input.baseUrl)
  for (const query of queryClient.getQueryCache().findAll({
    predicate: (query) => isSessionListQueryKey(query.queryKey, base),
  })) {
    const archiveView = sessionListArchiveView(query.queryKey)
    setSessionListQueryData(query.queryKey as ReturnType<typeof queryKeys.shell.sessionList>, (response) =>
      response ? reconcileSessionListResponseAfterArchive({
        response,
        sessionRef: input.sessionRef,
        archivedAt: input.archivedAt,
        archiveView,
      }) : response,
    )
  }
}

type SessionListUpdate = {
  sessionId: string
  directory: SessionNavigationRow["directory"]
  title?: string
  updatedAt?: number
}

export function reconcileUpdatedSessionListQueryData(input: SessionListUpdate) {
  for (const query of queryClient.getQueryCache().findAll({
    predicate: (query) => isSessionListQueryKey(query.queryKey),
  })) {
    setSessionListQueryData(query.queryKey as ReturnType<typeof queryKeys.shell.sessionList>, (response) => {
      if (!response) return response
      // `updated_desc` is the list's contract, and this reconcile can move a
      // row's `updatedAt` — so the rows have to be re-ordered, not just
      // rewritten in place. Without this an auto-titled session stayed at
      // whatever index it was first inserted at while claiming a brand-new
      // timestamp: observed live as a 30-second-old "Greeting" sitting at
      // position 6, below rows 12-29 minutes older than it.
      //
      // Guarded on the view's own sort so a list ordered some other way is
      // left exactly as the server sent it.
      const sorted = response.view?.sort === "updated_desc"
      return {
        ...response,
        ...(response.items ? { items: reorder(reconcileUpdatedSessionListRows(response.items, input), sorted) } : {}),
        ...(response.groups ? {
          groups: response.groups.map((group) => ({
            ...group,
            items: reorder(reconcileUpdatedSessionListRows(group.items, input), sorted),
          })),
        } : {}),
      }
    })
  }
}

/**
 * Re-sort newest-first, but only when the caller confirmed the view is
 * `updated_desc`. Sorted as a stable pass over a copy: rows whose `updatedAt`
 * ties keep the server's relative order, so this never reshuffles a list it
 * had no reason to touch.
 */
function reorder(rows: readonly SessionNavigationRow[], sorted: boolean) {
  if (!sorted) return rows as SessionNavigationRow[]
  return [...rows].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
}

function reconcileUpdatedSessionListRows(
  rows: readonly SessionNavigationRow[],
  input: SessionListUpdate,
) {
  return rows.map((row) => {
    if (row.sessionId !== input.sessionId || row.directory !== input.directory) return row
    return {
      ...row,
      title: input.title ?? row.title,
      updatedAt: input.updatedAt ?? row.updatedAt,
    }
  })
}

function reconcileSessionListResponseAfterArchive(input: {
  response: SessionListResponse
  sessionRef: string
  archivedAt: number
  archiveView: NonNullable<SessionListQuery["archived"]>
}): SessionListResponse {
  return {
    ...input.response,
    ...(input.response.items ? {
      items: reconcileSessionListRowsAfterArchive(input.response.items, input),
      totalKnown: reconcileSessionListTotal(input.response.totalKnown, input.response.items, input),
    } : {}),
    ...(input.response.groups ? {
      groups: input.response.groups.map((group) => ({
        ...group,
        items: reconcileSessionListRowsAfterArchive(group.items, input),
        totalKnown: reconcileSessionListTotal(group.totalKnown, group.items, input),
      })),
    } : {}),
  }
}

function reconcileSessionListRowsAfterArchive(
  rows: readonly SessionNavigationRow[],
  input: {
    sessionRef: string
    archivedAt: number
    archiveView: NonNullable<SessionListQuery["archived"]>
  },
) {
  if (input.archiveView === "active") return rows.filter((row) => !matchesSessionListRow(row, input))
  return rows.map((row) => matchesSessionListRow(row, input) ? { ...row, archivedAt: input.archivedAt } : row)
}

function reconcileSessionListTotal(
  total: number | undefined,
  rows: readonly SessionNavigationRow[],
  input: {
    sessionRef: string
    archivedAt: number
    archiveView: NonNullable<SessionListQuery["archived"]>
  },
) {
  if (input.archiveView !== "active" || total === undefined) return total
  return Math.max(0, total - rows.filter((row) => matchesSessionListRow(row, input)).length)
}

function matchesSessionListRow(
  row: SessionNavigationRow,
  input: { sessionRef: string },
) {
  return row.sessionRef === input.sessionRef
}

function sessionListArchiveView(key: readonly unknown[]): NonNullable<SessionListQuery["archived"]> {
  const query = key[3]
  if (!query || typeof query !== "object") return "active"
  const archived = (query as { archived?: unknown }).archived
  if (archived === "all" || archived === "archived") return archived
  return "active"
}

function isSessionListQueryKey(key: readonly unknown[], base?: string) {
  return key[0] === "shell" && key[2] === "sessionList" && (base === undefined || key[1] === base)
}

function normalizedBase(url: string | undefined) {
  return normalizeUrl(url) ?? "default"
}
