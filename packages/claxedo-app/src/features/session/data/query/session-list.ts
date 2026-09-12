import { asRecord } from "@/lib/record"
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

/** The cache entry one rail section's list lives in. */
export function sessionListQueryKey(baseUrl: string | undefined, query: SessionListQuery) {
  return queryKeys.shell.sessionList(baseUrl, query)
}

function sessionListBaseQuery(query: SessionListQuery): SessionListQuery {
  if (!query.cursor) return query
  const { cursor: _cursor, ...base } = query
  return base
}

/**
 * One session, once — whichever producer named it.
 *
 * The rule is shared with the composed source in `session-source.ts`: a
 * project's list can hold the same session from the central server AND from
 * the workspace runtime that owns it, exactly as a cached page can hold it
 * beside a fresh one.
 */
export function mergeSessionListItems(primary: readonly SessionNavigationRow[], tail: readonly SessionNavigationRow[]) {
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
  const items = input.append ? [...merged] : reorder(merged, input.page.view.sort)
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
    queryFn: async () => applyFetchedSessionListPage({
      baseUrl: input.baseUrl,
      query: input.query,
      page: await fetchSessionListPage(input),
    }),
  })
}

/**
 * One page from the app's own central server, exactly as it answered.
 *
 * Separate from the cache folding above because a section whose workspaces
 * answer from more than one server (`session-source.ts`'s composed source)
 * needs the central server's PAGE, and folds the composition — not this page
 * alone — into the section's `shell.sessionList` entry.
 */
export async function fetchSessionListPage(input: {
  baseUrl?: string
  query: SessionListQuery
  request?: typeof fetch
}): Promise<SessionListResponse> {
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
    // server parses those, never a header. Adding an `x-claxedo-directory`
    // header here would be redundant against the loopback server and fatal
    // against the hosted control plane: a header the cross-origin preflight
    // does not name is not "ignored", the browser refuses to send the
    // request at all.
    headers: { Accept: "application/json" },
  })
  if (!res.ok) {
    span.end({ status: res.status, ok: false })
    throw new Error((await res.text()) || `Session list request failed: ${res.status}`)
  }
  const page: unknown = await res.json()
  if (!isSessionListResponse(page)) {
    span.end({ status: res.status, ok: false })
    throw new Error("Session list response is missing its `view` descriptor")
  }
  span.end({ status: res.status, ok: true, rows: page.items?.length ?? page.groups?.reduce((n, g) => n + g.items.length, 0) ?? 0 })
  return page
}

/**
 * Fold a freshly fetched page into the list cached for its query.
 *
 * The shaping is the list's, not any one source's: whichever server answered —
 * the daemon, the control-plane registry, or a user-hosted workspace's own
 * runtime over the relay — the cached entry keeps the same merge, ordering and
 * pagination contract, so every reader and every event applier below sees one
 * shape.
 */
export function applyFetchedSessionListPage(input: {
  baseUrl?: string
  query: SessionListQuery
  page: SessionListResponse
}): SessionListResponse {
  if (input.query.cursor) return input.page
  return mergeSessionListResponses({
    current: queryClient.getQueryData<SessionListResponse>(
      sessionListQueryKey(input.baseUrl, sessionListBaseQuery(input.query)),
    ),
    page: input.page,
    append: false,
  })
}

// A harness-backed `POST /session` only publishes a `session.lifecycle`
// "created" event; it never streams the per-directory session rows the way an
// interactive session does. The flat inventory (`GET /api/control/sessions`)
// already refetches on that event, but the paginated per-section query
// (the product-specific session-list route) that actually feeds the rendered rail rows
// does not — so the new session stays invisible until a full reload. Invalidate
// every session-list query so the active section refetches and the row appears.
export async function invalidateSessionListQueries(input: { baseUrl?: string } = {}) {
  const base = input.baseUrl === undefined ? undefined : normalizedBase(input.baseUrl)
  // Dropped BEFORE the sections are told to refetch, because that refetch is
  // what reads it: `invalidateQueries` marks every match synchronously, so by
  // the time the second call starts a section's `queryFn` the runtime page it
  // folds in is already known-stale and the relay is asked again.
  const runtimeRows = invalidateWorkspaceRuntimeSessionRows(base)
  const lists = queryClient.invalidateQueries({
    predicate: (query) => isSessionListQueryKey(query.queryKey, base),
  })
  await Promise.all([runtimeRows, lists])
}

/**
 * The relay read a user-hosted section's rows are cut from
 * (`data/sync/session-source.ts`).
 *
 * It is memoized per WORKSPACE so one relay hop answers that workspace's own
 * section, its project's section and every page — which also means a section
 * refetch on its own re-reads the memo and answers with exactly the rows the
 * doorbell just said had changed. A freshly shared session stayed off the
 * recipient's rail for the whole memo window because of that: the session-list
 * refetch fired, and the runtime was never asked.
 */
function invalidateWorkspaceRuntimeSessionRows(base: string | undefined) {
  return queryClient.invalidateQueries({
    predicate: (query) => {
      const key = query.queryKey
      if (!Array.isArray(key) || key[0] !== "runtime" || key[2] !== "workspaceSessions") return false
      return base === undefined || key[1] === base
    },
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
      sort: query.sort ?? "updated_desc",
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
  sort: SessionListResponse["view"]["sort"],
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
    // Sorted rather than prepended: a session an agent created carries no human
    // turn, so under `human_turn_desc` it belongs below every session the reader
    // has spoken to rather than on top of them. Leading the list before the sort
    // keeps it first among the rows it ties with, which is where creation puts it.
    items: reorder([row, ...without], sort),
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
    const key = query.queryKey
    if (!isSessionListQueryKey(key, base)) continue
    const listQuery = sessionListQueryFromKey(key)
    if (!listQuery || listQuery.cursor) continue
    const response = isSessionListResponse(query.state.data) ? query.state.data : undefined
    const scopedRow = rowForSessionListQuery(row, listQuery, response)
    if (!scopedRow || !rowMatchesSessionListQuery(scopedRow, listQuery)) continue
    setSessionListQueryData(
      key,
      (current) => prependCreatedSessionListRow(current, listQuery, scopedRow, sessionListQuerySort(key, current)),
    )
  }
}

function sessionListQueryFromKey(key: readonly unknown[]): SessionListQuery | undefined {
  return isSessionListQuery(key[3]) ? key[3] : undefined
}

/**
 * The order a cached list is held in.
 *
 * The SECTION decides it, and the key the entry is cached under carries the
 * view that section asked for — so an applier rewriting a row places it in the
 * order the reader will render, whichever server answered and whatever `view`
 * that server chose to echo. The response's own `view` is the fallback for an
 * entry bootstrapped before any page landed.
 */
function sessionListQuerySort(
  key: readonly unknown[],
  response: SessionListResponse | undefined,
): NonNullable<SessionListQuery["sort"]> {
  return sessionListQueryFromKey(key)?.sort ?? response?.view?.sort ?? "updated_desc"
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
    const key = query.queryKey
    if (!isSessionListQueryKey(key, base)) continue
    const archiveView = sessionListArchiveView(key)
    setSessionListQueryData(key, (response) =>
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
    const key = query.queryKey
    if (!isSessionListQueryKey(key, base)) continue
    setSessionListQueryData(key, (response) =>
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
  /**
   * Only the submit path may set this. It is what the list orders on, so a
   * caller that stamps it for an agent's turn, a wake or a completion moves the
   * row under a reader who did not speak to the session.
   */
  lastHumanTurnAt?: number
}

export function reconcileUpdatedSessionListQueryData(input: SessionListUpdate) {
  for (const query of queryClient.getQueryCache().findAll({
    predicate: (query) => isSessionListQueryKey(query.queryKey),
  })) {
    const key = query.queryKey
    if (!isSessionListQueryKey(key)) continue
    setSessionListQueryData(key, (response) => {
      if (!response) return response
      // A rewrite that moves the key the entry is ordered by has to be re-ordered
      // too, not just written in place: an auto-titled session otherwise stayed at
      // whatever index it was first inserted at while claiming a brand-new
      // timestamp — observed live as a 30-second-old "Greeting" sitting at
      // position 6, below rows 12-29 minutes older than it.
      //
      // Asked of the key rather than of the sort, so an update that leaves the
      // ordering key alone — a title under `human_turn_desc`, anything at all
      // under `created_desc` — cannot move a row.
      const sort = sessionListQuerySort(query.queryKey, response)
      const nextItems = response.items
        ? reconcileUpdatedSessionListRows(response.items, input)
        : undefined
      const nextGroups = response.groups
        ? response.groups.map((group) => ({
          ...group,
          items: reconcileUpdatedSessionListRows(group.items, input),
        }))
        : undefined
      const itemsMoved = nextItems
        && sortKeyChanged(response.items ?? [], nextItems, input, sort)
      const groupsMoved = nextGroups
        && nextGroups.some((group, index) =>
          sortKeyChanged(response.groups?.[index]?.items ?? [], group.items, input, sort))
      return {
        ...response,
        ...(nextItems ? {
          items: itemsMoved ? reorder(nextItems, sort) : nextItems,
        } : {}),
        ...(nextGroups ? {
          groups: groupsMoved
            ? nextGroups.map((group) => ({ ...group, items: reorder(group.items, sort) }))
            : nextGroups,
        } : {}),
      }
    })
  }
}

/**
 * A sort's key for one row, most significant first — the same tuple the server
 * orders and pages on, so a client-side rewrite lands a row where the next
 * refetch will also put it.
 *
 * The one definition of what each order means on this side of the wire: the
 * cache appliers below and the composed source in `session-source.ts`, which
 * assembles a page out of several servers' answers, both read it. A second copy
 * would let a section that merges runtimes order differently from one that does
 * not, which is invisible until someone has both.
 *
 * A session the reader has never prompted keys on 0 under `human_turn_desc`,
 * which sorts it below every session they have.
 */
export function sessionListSortKey(row: SessionNavigationRow, sort: SessionListResponse["view"]["sort"]) {
  if (sort === "human_turn_desc") return [row.lastHumanTurnAt ?? 0, row.createdAt ?? 0]
  if (sort === "created_desc") return [row.createdAt ?? 0]
  return [row.updatedAt ?? 0]
}

/**
 * Re-sort into the order the cache entry is held in, as a stable pass over a
 * copy: rows whose key ties keep the server's relative order, since the client
 * does not apply the server's `sessionRef` tiebreak and reshuffling ties would
 * move rows for no reason.
 */
function reorder(rows: readonly SessionNavigationRow[], sort: SessionListResponse["view"]["sort"]) {
  return [...rows].sort((a, b) => {
    const left = sessionListSortKey(a, sort)
    const right = sessionListSortKey(b, sort)
    for (const [index, value] of left.entries()) {
      const other = right[index] ?? 0
      if (other !== value) return other - value
    }
    return 0
  })
}

function sortKeyChanged(
  before: readonly SessionNavigationRow[],
  after: readonly SessionNavigationRow[],
  input: SessionListUpdate,
  sort: SessionListResponse["view"]["sort"],
) {
  const prev = before.find((row) => matchesSessionListRow(row, input))
  const next = after.find((row) => matchesSessionListRow(row, input))
  if (!prev || !next) return false
  const nextKey = sessionListSortKey(next, sort)
  return sessionListSortKey(prev, sort).some((value, index) => value !== nextKey[index])
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
      ...(input.lastHumanTurnAt !== undefined ? { lastHumanTurnAt: input.lastHumanTurnAt } : {}),
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

type SessionListQueryKey = ReturnType<typeof queryKeys.shell.sessionList>

/**
 * A cache key `queryKeys.shell.sessionList` produced.
 *
 * The builder types its query slot as `unknown`, so every reader used to assert
 * the key's shape back. A predicate states the same check once and narrows.
 */
function isSessionListQueryKey(key: readonly unknown[], base?: string): key is SessionListQueryKey {
  return key[0] === "shell" && typeof key[1] === "string" && key[2] === "sessionList"
    && (base === undefined || key[1] === base)
}

/** The query a session-list key was built for, from its fourth slot. */
function isSessionListQuery(value: unknown): value is SessionListQuery {
  const query = asRecord(value)
  if (!query) return false
  const scope = query.scope
  return (scope === "global" || scope === "project" || scope === "workspace") && typeof query.limit === "number"
}

/** A cached or fetched session-list page: `view` is the field every reader keys on. */
function isSessionListResponse(value: unknown): value is SessionListResponse {
  return !!asRecord(asRecord(value)?.view)
}

function normalizedBase(url: string | undefined) {
  return normalizeUrl(url) ?? "default"
}
