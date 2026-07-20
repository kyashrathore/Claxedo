import { queryOptions } from "@tanstack/solid-query"
import { authFetch, getClaxedoServerUrl, normalizeUrl } from "@/platform/api/api"
import { centralTransportForServer } from "@/platform/runtime/transport"
import {
  controlSessionNavigationListUrl,
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
      const res = await sessionListRequest(input)(controlSessionNavigationListUrl({
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
// (`GET /api/control/session-list`) that actually feeds the rendered rail rows
// does not — so the new session stays invisible until a full reload. Invalidate
// every session-list query so the active section refetches and the row appears.
export function invalidateSessionListQueries(input: { baseUrl?: string } = {}) {
  const base = input.baseUrl === undefined ? undefined : normalizedBase(input.baseUrl)
  return queryClient.invalidateQueries({
    predicate: (query) => isSessionListQueryKey(query.queryKey, base),
  })
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
      return {
        ...response,
        ...(response.items ? { items: reconcileUpdatedSessionListRows(response.items, input) } : {}),
        ...(response.groups ? {
          groups: response.groups.map((group) => ({
            ...group,
            items: reconcileUpdatedSessionListRows(group.items, input),
          })),
        } : {}),
      }
    })
  }
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
