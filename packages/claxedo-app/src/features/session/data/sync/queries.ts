import { queryOptions, skipToken } from "@tanstack/solid-query"
import type {
  AgentPermission as PermissionRequest,
  AgentQuestion as QuestionRequest,
  AgentRuntimeStatus as SessionStatus,
  AgentTodo as Todo,
} from "@claxedo/agent-runtime-contract"
import { queryKeys } from "@/platform/query/keys"
import { queryClient } from "@/platform/query/query-client"
import { shellDataKeys } from "@/platform/sync/keys"
import type { ClaxedoSession } from "../session-types"
import type { SessionInventoryRow } from "../query/types"
import { sameSessionIdentity } from "@/platform/sync/global-session-identity"
export type {
  AgentPermission as PermissionRequest,
  AgentQuestion as QuestionRequest,
  AgentRuntimeStatus as SessionStatus,
  AgentSnapshotFileDiff as SnapshotFileDiff,
  AgentTodo as Todo,
} from "@claxedo/agent-runtime-contract"
export {
  setSessionDiffQueryData,
  setSessionCapabilitiesQueryData,
  setSessionRequestsQueryData,
  setSessionStatusQueryData,
  setSessionTodoQueryData,
  sessionRequestResolved,
  type ShellQueryDataWriter,
} from "./writers"

export type SessionRequestsQueryData = {
  permissions: PermissionRequest[]
  questions: QuestionRequest[]
  /**
   * When the canonical directory read (`applyDirectorySessionMeta`) last
   * reconciled this entry — event-driven writes preserve it, so a dock can
   * tell data confirmed since attach from a retained replay or a stale hold.
   */
  reconciledAt?: number
}

export type DirectorySessionCacheValue = {
  at: number
  limit: number
  total: number
  session: ClaxedoSession[]
}

type PageState = { hasMore: boolean; loading: boolean; cursor?: number }

/**
 * The fields an inventory operation needs to identify and order a session by.
 *
 * Narrower than `SessionInventoryRow` on purpose: removals and lookups are
 * given a *target* — an event payload, a route ref — that carries an id and
 * little else. Row-shaped values satisfy it, so this is what those entry points
 * accept. `inventory-writers.ts` kept a byte-identical copy until it was
 * consolidated here.
 */
export type SessionInventoryIdentity = {
  id: string
  directory?: string
  workspaceId?: string
  workspaceName?: string
  projectID?: string
  tags?: string[]
  time?: number | { updated?: number; created?: number }
}

export type SessionInventoryWorkspaceGroup = {
  key?: string
  directory: string
  workspaceId?: string
  workspaceName?: string
  projectID: string
  sessions: SessionInventoryRow[]
  hasMore: boolean
  total: number
  nextCursor?: number
}

export type SessionInventoryWorkspaceMeta = Omit<SessionInventoryWorkspaceGroup, "sessions">

// Single source of truth for projecting a workspace group down to its stored
// meta (every field except the session rows). Reused by the inventory
// derivation below and by the query-cache writers in `inventory-writers.ts`, so
// the meta shape lives in exactly one place instead of five inline copies.
export function workspaceMetaFromGroup(
  key: string,
  group: SessionInventoryWorkspaceGroup,
): SessionInventoryWorkspaceMeta {
  return {
    key: group.key ?? key,
    directory: group.directory,
    workspaceId: group.workspaceId,
    workspaceName: group.workspaceName,
    projectID: group.projectID,
    hasMore: group.hasMore,
    total: group.total,
    nextCursor: group.nextCursor,
  }
}

export type SessionInventoryStoredValue = {
  sessions: SessionInventoryRow[]
  globalState: PageState
  projectState: Record<string, PageState>
  workspaceMeta: Record<string, SessionInventoryWorkspaceMeta>
  workspaceState: Record<string, PageState>
  workspaceOrder: string[]
  loading: boolean
  loaded: boolean
  initialCursor?: number
}

export type SessionInventoryValue = {
  sessions: SessionInventoryRow[]
  sessionOrder: string[]
  global: SessionInventoryRow[]
  globalState: PageState
  byProject: Record<string, SessionInventoryRow[]>
  projectState: Record<string, PageState>
  byWorkspace: Record<string, SessionInventoryWorkspaceGroup>
  workspaceMeta?: Record<string, SessionInventoryWorkspaceMeta>
  workspaceState: Record<string, PageState>
  workspaceOrder: string[]
  loading: boolean
  loaded: boolean
  initialCursor?: number
}

function sessionUpdatedAt(input: SessionInventoryIdentity) {
  if (typeof input.time === "number") return input.time
  return input.time?.updated ?? input.time?.created ?? 0
}

function sessionIsGlobalChat(input: SessionInventoryIdentity) {
  return input.tags?.includes("global") || input.directory === "global"
}

function sessionShouldShowInGlobalChat(input: SessionInventoryIdentity) {
  return input.tags?.includes("global:default") || input.directory === "global"
}

function sessionWorkspaceKey(input: SessionInventoryIdentity) {
  return input.workspaceId ?? input.directory
}

function sortSessions(sessions: readonly SessionInventoryRow[]) {
  return [...sessions].sort((a, b) => sessionUpdatedAt(b) - sessionUpdatedAt(a))
}

function dedupeSessions(sessions: readonly SessionInventoryRow[]) {
  const next: SessionInventoryRow[] = []
  for (const session of sortSessions(sessions)) {
    if (!next.some((item) => sameSessionIdentity(item, session))) next.push(session)
  }
  return next
}

export function deriveSessionInventoryIndexes(
  input: Pick<SessionInventoryValue, "sessions" | "workspaceState" | "workspaceOrder" | "projectState" | "globalState"> & {
    byWorkspace?: Record<string, SessionInventoryWorkspaceGroup>
    workspaceMeta?: Record<string, SessionInventoryWorkspaceMeta>
  },
) {
  const sessions = dedupeSessions(input.sessions)
  const sessionsById = new Map<string, SessionInventoryRow[]>()
  for (const session of sessions) {
    const matches = sessionsById.get(session.id)
    if (matches) matches.push(session)
    else sessionsById.set(session.id, [session])
  }
  const global = sessions.filter(sessionShouldShowInGlobalChat)
  const byProject: Record<string, SessionInventoryRow[]> = {}
  const byWorkspace: Record<string, SessionInventoryWorkspaceGroup> = {}
  const workspaceMeta: Record<string, SessionInventoryWorkspaceMeta> = { ...input.workspaceMeta }
  const workspaceOrder = [...input.workspaceOrder]

  for (const session of sessions) {
    if (sessionIsGlobalChat(session)) continue
    const projectID = session.projectID ?? session.directory
    if (projectID) byProject[projectID] = sortSessions([...(byProject[projectID] ?? []), session])

    const workspaceKey = sessionWorkspaceKey(session)
    if (!workspaceKey || !session.directory) continue
    const previous = input.byWorkspace?.[workspaceKey]
    const meta = workspaceMeta[workspaceKey] ?? previous
    const group = byWorkspace[workspaceKey] ?? {
      key: meta?.key ?? workspaceKey,
      directory: meta?.directory ?? session.directory,
      workspaceId: meta?.workspaceId ?? session.workspaceId,
      workspaceName: meta?.workspaceName ?? session.workspaceName,
      projectID: meta?.projectID ?? projectID ?? session.directory,
      sessions: [],
      hasMore: meta?.hasMore ?? input.workspaceState[workspaceKey]?.hasMore ?? false,
      total: meta?.total ?? 0,
      nextCursor: meta?.nextCursor ?? input.workspaceState[workspaceKey]?.cursor,
    }
    group.sessions = sortSessions([...group.sessions, session])
    group.total = group.hasMore ? Math.max(meta?.total ?? 0, group.sessions.length) : group.sessions.length
    byWorkspace[workspaceKey] = group
    workspaceMeta[workspaceKey] = workspaceMetaFromGroup(workspaceKey, group)
    if (!workspaceOrder.includes(workspaceKey)) workspaceOrder.push(workspaceKey)
  }

  for (const [workspaceKey, previous] of Object.entries(input.byWorkspace ?? {})) {
    const state = input.workspaceState[workspaceKey]
    const meta = workspaceMeta[workspaceKey] ?? previous
    const page = dedupeSessions(previous.sessions.flatMap((session) => {
      const canonical = sessionsById.get(session.id)?.find((item) => sameSessionIdentity(item, session))
      return canonical ? [canonical] : []
    }))
    const sessions = input.workspaceMeta?.[workspaceKey] && byWorkspace[workspaceKey]
      ? dedupeSessions([...byWorkspace[workspaceKey].sessions, ...page])
      : page
    const hasMore = state?.hasMore ?? meta.hasMore
    byWorkspace[workspaceKey] = {
      ...previous,
      key: meta.key ?? previous.key ?? workspaceKey,
      directory: meta.directory,
      workspaceId: meta.workspaceId,
      workspaceName: meta.workspaceName,
      projectID: meta.projectID,
      sessions,
      hasMore,
      total: hasMore ? Math.max(meta.total, sessions.length) : sessions.length,
      nextCursor: state?.cursor ?? meta.nextCursor,
    }
    workspaceMeta[workspaceKey] = workspaceMetaFromGroup(workspaceKey, byWorkspace[workspaceKey])
    if (!workspaceOrder.includes(workspaceKey)) workspaceOrder.push(workspaceKey)
  }

  return {
    sessions,
    sessionOrder: sessions.map((session) => session.id),
    global,
    byProject,
    byWorkspace,
    workspaceMeta,
    workspaceOrder,
  }
}

export function normalizeSessionInventory(
  input: SessionInventoryStoredValue | SessionInventoryValue,
): SessionInventoryValue {
  const stored = toSessionInventoryStore(input)
  const derived = deriveSessionInventoryIndexes({
    sessions: stored.sessions,
    workspaceState: stored.workspaceState,
    workspaceOrder: stored.workspaceOrder,
    projectState: stored.projectState,
    globalState: stored.globalState,
    byWorkspace: "byWorkspace" in input ? input.byWorkspace : undefined,
    workspaceMeta: "byWorkspace" in input ? input.workspaceMeta : stored.workspaceMeta,
  })
  return {
    ...stored,
    ...derived,
  }
}

/**
 * Memoizes the derivation per stored snapshot. Every read of the inventory
 * derives its indexes, so without this the rail re-groups the whole session
 * list on every render.
 */
const derivedSessionInventoryCache = new WeakMap<SessionInventoryStoredValue, SessionInventoryValue>()

export function deriveSessionInventoryValue(
  input: SessionInventoryStoredValue,
): SessionInventoryValue {
  const cached = derivedSessionInventoryCache.get(input)
  if (cached) return cached
  const value = normalizeSessionInventory(input)
  derivedSessionInventoryCache.set(input, value)
  return value
}

export function toSessionInventoryStore(
  input: SessionInventoryStoredValue | SessionInventoryValue,
): SessionInventoryStoredValue {
  const workspaceMeta: Record<string, SessionInventoryWorkspaceMeta> = { ...input.workspaceMeta }
  if ("byWorkspace" in input) {
    for (const [key, group] of Object.entries(input.byWorkspace)) {
      if (workspaceMeta[key]) continue
      workspaceMeta[key] = workspaceMetaFromGroup(key, group)
    }
  }
  return sessionInventoryStore(input, input.sessions, workspaceMeta)
}

/**
 * Serialize an already-normalized inventory after a mutation.
 *
 * `byProject` and `byWorkspace` are derived indexes and can still describe the
 * pre-mutation snapshot while `sessions` is intentionally empty. Re-reading
 * those indexes here resurrected the final archived/deleted session. The
 * canonical `sessions` array is authoritative at every boundary.
 */
export function toCanonicalSessionInventoryStore(
  input: SessionInventoryValue,
): SessionInventoryStoredValue {
  const workspaceMeta: Record<string, SessionInventoryWorkspaceMeta> = { ...input.workspaceMeta }
  for (const [key, group] of Object.entries(input.byWorkspace)) {
    if (workspaceMeta[key]) continue
    workspaceMeta[key] = workspaceMetaFromGroup(key, group)
  }
  return sessionInventoryStore(input, input.sessions, workspaceMeta)
}

function sessionInventoryStore(
  input: SessionInventoryStoredValue | SessionInventoryValue,
  sessions: SessionInventoryRow[],
  workspaceMeta: Record<string, SessionInventoryWorkspaceMeta>,
): SessionInventoryStoredValue {
  return {
    sessions: dedupeSessions(sessions),
    globalState: { ...input.globalState },
    projectState: Object.fromEntries(
      Object.entries(input.projectState).map(([key, state]) => [key, { ...state }]),
    ),
    workspaceMeta,
    workspaceState: Object.fromEntries(
      Object.entries(input.workspaceState).map(([key, state]) => [key, { ...state }]),
    ),
    workspaceOrder: [...input.workspaceOrder],
    loading: input.loading,
    loaded: input.loaded,
    initialCursor: input.initialCursor,
  }
}

export function emptySessionInventoryStore(): SessionInventoryStoredValue {
  return {
    sessions: [],
    globalState: { hasMore: false, loading: false },
    projectState: {},
    workspaceMeta: {},
    workspaceState: {},
    workspaceOrder: [],
    loading: false,
    loaded: false,
  }
}

export function emptySessionInventory(): SessionInventoryValue {
  return normalizeSessionInventory(emptySessionInventoryStore())
}

/**
 * The address the inventory holds a session under, read off the cache: what a
 * bare `/s/<id>` route, which names no workspace, resolves its workspace from.
 */
export function sessionInventoryDirectory(baseUrl: string | undefined, sessionId: string): string | undefined {
  const inventory = queryClient.getQueryData<SessionInventoryStoredValue>(queryKeys.shell.sessionInventory(baseUrl))
  return inventory?.sessions.find((row) => row.id === sessionId)?.directory
}

export function sessionInventoryQueryOptions(input: {
  baseUrl?: string
}) {
  return queryOptions<SessionInventoryStoredValue, Error, SessionInventoryValue>({
    queryKey: queryKeys.shell.sessionInventory(input.baseUrl),
    queryFn: skipToken,
    select: deriveSessionInventoryValue,
  })
}

export function directorySessionCacheQueryOptions(input: {
  directory: string
}) {
  return queryOptions<DirectorySessionCacheValue>({
    queryKey: queryKeys.directory.sessionCache(input.directory),
    queryFn: skipToken,
  })
}

/**
 * Observe push-owned session status without installing a transport closure on
 * the durable canonical cache entry. Dispatchers and explicit refresh owners
 * write this key; cache readers must never become a second producer.
 */
export function sessionStatusCacheQueryOptions(input: { sessionId: string }) {
  return queryOptions<SessionStatus>({
    queryKey: shellDataKeys.sessionId(input.sessionId, "status"),
    queryFn: skipToken,
    enabled: false,
  })
}

/** Cache-only observer for push-owned permission/question projection data. */
export function sessionRequestsCacheQueryOptions(input: { sessionId: string }) {
  return queryOptions<SessionRequestsQueryData>({
    queryKey: shellDataKeys.sessionId(input.sessionId, "requests"),
    queryFn: skipToken,
    enabled: false,
  })
}

/** Cache-only observer for todo data written by the session event projector. */
export function sessionTodoCacheQueryOptions(input: { sessionId: string }) {
  return queryOptions<Todo[]>({
    queryKey: shellDataKeys.sessionId(input.sessionId, "todo"),
    queryFn: skipToken,
    enabled: false,
  })
}
