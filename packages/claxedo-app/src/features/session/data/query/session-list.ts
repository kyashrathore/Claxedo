import { queryOptions } from "@tanstack/solid-query"
import { authFetch, getClaxedoServerUrl, normalizeUrl } from "@/platform/api/api"
import { createControlPlaneAccountFetch } from "@/platform/account/control-plane-account-fetch"
import {
  sessionNavigationListUrl,
  type ControlSessionNavigationListQuery,
} from "@/platform/runtime/agent/workspace-control-routes"
import type { SessionNavigationRow } from "../../ui/navigation/session-navigation"
import { queryKeys } from "@/platform/query/keys"
import { queryClient } from "@/platform/query/query-client"
import { sessionPerf } from "@/platform/performance/session-perf"

export type SessionListQuery = ControlSessionNavigationListQuery

export type SessionListResponse = {
  view: {
    scope: SessionListQuery["scope"]
    groupBy: NonNullable<SessionListQuery["groupBy"]>
    sort: NonNullable<SessionListQuery["sort"]>
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
  // Prefer primary's row when the same session arrives under both
  // `local:<dir>:session:<id>` and `workspace:<uuid>:session:<id>` (local
  // association ids stamped as workspaceID — open issue #14 / tier-real
  // local harness strict-mode duplicates). sessionRef-only merge kept both.
  const seenRefs = new Set(primary.map((item) => item.sessionRef))
  const seenIds = new Set(primary.map((item) => item.sessionId))
  return [
    ...primary,
    ...tail.filter((item) => {
      if (seenRefs.has(item.sessionRef) || seenIds.has(item.sessionId)) return false
      seenRefs.add(item.sessionRef)
      seenIds.add(item.sessionId)
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
  // A lower authoritative total means at least one cached row no longer
  // belongs in this view (archive, deletion, or access revocation). Which tail
  // row disappeared cannot be proven from page one, so discard the cached tail
  // and let pagination repopulate it. Keeping it would let a revoked row survive
  // a successful control-plane refetch after a cold cache restore.
  const authoritativeShrink = !input.append
    && input.page.totalKnown !== undefined
    && input.current.totalKnown !== undefined
    && input.page.totalKnown < input.current.totalKnown
  const merged = authoritativeShrink
    ? input.page.items
    : input.append
      ? mergeSessionListItems(input.current.items, input.page.items)
      : mergeSessionListItems(input.page.items, input.current.items)
  const items = reorder(
    merged,
    !input.append && input.page.view.sort === "updated_desc",
    input.page.view.sort,
  )
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
    nextCursor: authoritativeShrink
      ? input.page.nextCursor
      : input.append
      ? input.page.nextCursor
      : items.length > input.page.items.length ? input.current.nextCursor : input.page.nextCursor,
    totalKnown: authoritativeShrink
      ? input.page.totalKnown
      : Math.max(input.current.totalKnown ?? 0, input.page.totalKnown ?? 0, items.length),
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
  // Signed desktop: AccountPort via control-plane adapter. Browser / unsigned:
  // authFetch (bearer or Basic, or plain fetch when neither is configured).
  return createControlPlaneAccountFetch(authFetch)
}

export function sessionListQueryOptions(input: {
  baseUrl?: string
  query: SessionListQuery
  request?: typeof fetch
}) {
  return queryOptions({
    queryKey: queryKeys.shell.sessionList(input.baseUrl, input.query),
    queryFn: async () => {
      const span = sessionPerf.span("session.list", {
        scope: input.query.scope,
        ...(input.query.workspaceId ? { workspaceId: input.query.workspaceId } : {}),
        ...(input.query.projectId ? { projectId: input.query.projectId } : {}),
        paged: !!input.query.cursor,
      })
      const res = await sessionListRequest(input)(sessionNavigationListUrl({
        baseUrl: normalizeUrl(input.baseUrl) ?? getClaxedoServerUrl(),
        ...input.query,
      }), {
        // Scope travels in the QUERY STRING only — `sessionNavigationListUrl`
        // already carries directory / workspaceId / projectId, and every
        // server parses those, never a header. The `x-opencode-directory`
        // header this used to add was redundant, and against the hosted
        // control plane it was fatal: a header the cross-origin preflight
        // does not name is not "ignored", the browser refuses to send the
        // request at all. Every scoped rail fetch died before leaving the
        // page, with nothing logged server-side.
        headers: { Accept: "application/json" },
      })
      if (!res.ok) {
        span.end({ status: res.status, ok: false })
        throw new Error((await res.text()) || `Session list request failed: ${res.status}`)
      }
      const page = await res.json() as SessionListResponse
      span.end({ status: res.status, ok: true, rows: page.items?.length ?? page.groups?.reduce((n, g) => n + g.items.length, 0) ?? 0 })
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

/** Invalidate flat session inventory used by the rail workspace groups. */
export function invalidateSessionInventoryQueries(input: { baseUrl?: string } = {}) {
  const base = input.baseUrl === undefined ? undefined : normalizedBase(input.baseUrl)
  return queryClient.invalidateQueries({
    predicate: (query) => {
      const key = query.queryKey
      if (!Array.isArray(key) || key[0] !== "shell" || key[2] !== "sessionInventory") return false
      return base === undefined || key[1] === base
    },
  })
}

/**
 * Session-share doorbell: list APIs already include shares; refetch rail
 * session-list + inventory so Bob sees grant/revoke without navigation.
 */
export function invalidateSessionShareQueries(input: { baseUrl?: string } = {}) {
  return Promise.all([
    invalidateSessionListQueries(input),
    invalidateSessionInventoryQueries(input),
  ])
}

// A `session.lifecycle` "created" doorbell races the server's projection write:
// the event is published before the response-tap records the row, so the
// invalidation refetch can return a list that still lacks the new session (the
// row then only shows up on the NEXT invalidation). The event carries the full
// session, so upsert the row into matching active queries directly — the
// refetch that follows stays the source of truth and reconciles any drift.
function bootstrapSessionListResponse(query: SessionListQuery): SessionListResponse {
  return {
    view: {
      scope: query.scope,
      groupBy: query.groupBy ?? "none",
      sort: "updated_desc",
      limit: query.limit ?? 0,
    },
    items: [],
    totalKnown: 0,
  }
}

function prependCreatedSessionListRow(
  response: SessionListResponse | undefined,
  query: SessionListQuery,
  row: SessionNavigationRow,
): SessionListResponse {
  const current = response ?? bootstrapSessionListResponse(query)
  const existing = current.items ?? []
  // Same session can arrive once as `local:<dir>:session:<id>` and again as
  // `workspace:<uuid>:session:<id>` when a lifecycle frame carries a local
  // association id as workspaceID (open issue #14). Prefer one row keyed by
  // sessionId so the rail oracle's strict sessionId locator stays unique.
  if (existing.some((item) => item.sessionRef === row.sessionRef)) return current
  const without = existing.filter((item) => item.sessionId !== row.sessionId)
  return {
    ...current,
    items: [row, ...without],
    totalKnown: current.totalKnown === undefined
      ? without.length + 1
      : current.totalKnown - (existing.length - without.length) + 1,
  }
}

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
    if (!listQuery || listQuery.cursor) continue
    const response = query.state.data as SessionListResponse | undefined
    const scopedRow = rowForSessionListQuery(row, listQuery, response)
    if (!scopedRow || !rowMatchesSessionListQuery(scopedRow, listQuery)) continue
    setSessionListQueryData(
      query.queryKey as ReturnType<typeof queryKeys.shell.sessionList>,
      (current) => prependCreatedSessionListRow(current, listQuery, scopedRow),
    )
  }
}

function sessionListQueryFromKey(key: readonly unknown[]): SessionListQuery | undefined {
  const query = key[3]
  return query && typeof query === "object" ? query as SessionListQuery : undefined
}

/**
 * Create-time optimistic rows often know `workspaceId` before `projectId`.
 * Project-scoped rail queries require the project id; when this workspace
 * already has a sibling in that section (the signed fixture seed session),
 * adopt the section's project id so the live row is not dropped.
 */
function rowForSessionListQuery(
  row: SessionNavigationRow,
  query: SessionListQuery,
  response: SessionListResponse | undefined,
): SessionNavigationRow | undefined {
  if (row.projectId || query.scope !== "project" || !query.projectId || !row.workspaceId) return row
  const sibling = response?.items?.some((item) => item.workspaceId === row.workspaceId)
  if (!sibling) return row
  return { ...row, projectId: query.projectId }
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
  sessionId: string
  directory: SessionNavigationRow["directory"]
  workspaceId?: string
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
        sessionId: input.sessionId,
        directory: input.directory,
        workspaceId: input.workspaceId,
        archivedAt: input.archivedAt,
        archiveView,
      }) : response,
    )
  }
}

export function removeSessionListQueryData(input: {
  baseUrl?: string
  sessionId: string
  directory?: SessionNavigationRow["directory"]
  workspaceId?: string
}) {
  const base = input.baseUrl === undefined ? undefined : normalizedBase(input.baseUrl)
  for (const query of queryClient.getQueryCache().findAll({
    predicate: (query) => isSessionListQueryKey(query.queryKey, base),
  })) {
    setSessionListQueryData(query.queryKey as ReturnType<typeof queryKeys.shell.sessionList>, (response) =>
      response ? removeSessionFromListResponse(response, input) : response,
    )
  }
}

type SessionListUpdate = {
  sessionId: string
  directory: SessionNavigationRow["directory"]
  workspaceId?: string
  title?: string
  updatedAt?: number
}

export function reconcileUpdatedSessionListQueryData(input: SessionListUpdate) {
  for (const query of queryClient.getQueryCache().findAll({
    predicate: (query) => isSessionListQueryKey(query.queryKey),
  })) {
    setSessionListQueryData(query.queryKey as ReturnType<typeof queryKeys.shell.sessionList>, (response) => {
      if (!response) return response
      // `updated_desc` is the list's contract for surfacing content edits, and
      // this reconcile can move a row's `updatedAt` — so those rows have to be
      // re-ordered, not just rewritten in place. Without this an auto-titled
      // session stayed at whatever index it was first inserted at while
      // claiming a brand-new timestamp: observed live as a 30-second-old
      // "Greeting" sitting at position 6, below rows 12-29 minutes older than it.
      //
      // Guarded on the view's own sort so a list ordered by `created_desc`
      // (stable on visit) is left exactly as the server sent it. Also skip
      // reordering when the update did not actually change `updatedAt`.
      const sort = response.view?.sort
      const shouldReorder = sort === "updated_desc"
      const nextItems = response.items
        ? reconcileUpdatedSessionListRows(response.items, input)
        : undefined
      const nextGroups = response.groups
        ? response.groups.map((group) => ({
          ...group,
          items: reconcileUpdatedSessionListRows(group.items, input),
        }))
        : undefined
      const itemsMoved = shouldReorder && nextItems
        && updatedAtChanged(response.items ?? [], nextItems, input)
      const groupsMoved = shouldReorder && nextGroups
        && nextGroups.some((group, index) =>
          updatedAtChanged(response.groups?.[index]?.items ?? [], group.items, input))
      return {
        ...response,
        ...(nextItems ? {
          items: itemsMoved ? reorder(nextItems, true, sort) : nextItems,
        } : {}),
        ...(nextGroups ? {
          groups: groupsMoved
            ? nextGroups.map((group) => ({ ...group, items: reorder(group.items, true, sort) }))
            : nextGroups,
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
function reorder(
  rows: readonly SessionNavigationRow[],
  sorted: boolean,
  sort: SessionListResponse["view"]["sort"] = "updated_desc",
) {
  if (!sorted || sort !== "updated_desc") return rows as SessionNavigationRow[]
  return [...rows].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
}

function updatedAtChanged(
  before: readonly SessionNavigationRow[],
  after: readonly SessionNavigationRow[],
  input: SessionListUpdate,
) {
  const prev = before.find((row) => matchesSessionListRow(row, input))
  const next = after.find((row) => matchesSessionListRow(row, input))
  if (!prev || !next) return false
  return (prev.updatedAt ?? 0) !== (next.updatedAt ?? 0)
}

function reconcileUpdatedSessionListRows(
  rows: readonly SessionNavigationRow[],
  input: SessionListUpdate,
) {
  return rows.map((row) => {
    if (!matchesSessionListRow(row, input)) return row
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
  sessionId: string
  directory: SessionNavigationRow["directory"]
  workspaceId?: string
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

function removeSessionFromListResponse(
  response: SessionListResponse,
  identity: SessionListIdentity,
): SessionListResponse {
  return {
    ...response,
    ...(response.items ? {
      items: response.items.filter((row) => !matchesSessionListRow(row, identity)),
      totalKnown: removeSessionListTotal(response.totalKnown, response.items, identity),
    } : {}),
    ...(response.groups ? {
      groups: response.groups.map((group) => ({
        ...group,
        items: group.items.filter((row) => !matchesSessionListRow(row, identity)),
        totalKnown: removeSessionListTotal(group.totalKnown, group.items, identity),
      })),
    } : {}),
  }
}

function reconcileSessionListRowsAfterArchive(
  rows: readonly SessionNavigationRow[],
  input: {
    sessionRef: string
    sessionId: string
    directory: SessionNavigationRow["directory"]
    workspaceId?: string
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
    sessionId: string
    directory: SessionNavigationRow["directory"]
    workspaceId?: string
    archivedAt: number
    archiveView: NonNullable<SessionListQuery["archived"]>
  },
) {
  if (input.archiveView !== "active" || total === undefined) return total
  return Math.max(0, total - rows.filter((row) => matchesSessionListRow(row, input)).length)
}

function removeSessionListTotal(
  total: number | undefined,
  rows: readonly SessionNavigationRow[],
  identity: SessionListIdentity,
) {
  if (total === undefined) return total
  return Math.max(0, total - rows.filter((row) => matchesSessionListRow(row, identity)).length)
}

type SessionListIdentity = {
  sessionRef?: string
  sessionId: string
  directory?: SessionNavigationRow["directory"]
  workspaceId?: string
}

function matchesSessionListRow(
  row: SessionNavigationRow,
  input: SessionListIdentity,
) {
  if (input.sessionRef && row.sessionRef === input.sessionRef) return true
  if (row.sessionId !== input.sessionId) return false
  // Session ids are unique. Do not also require directory equality — signed
  // cloud activity frames often name a workspace alias while the cached row
  // stores the concrete worktree, which left updatedAt bumps matching no row
  // and the rail stuck in creation order (tier-real B5/B6).
  if (input.workspaceId && row.workspaceId && input.workspaceId !== row.workspaceId) return false
  return true
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
