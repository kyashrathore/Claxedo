import { queryOptions, skipToken } from "@tanstack/solid-query"
import type { PermissionRequest, QuestionRequest, Session, SessionStatus, SnapshotFileDiff, Todo } from "@opencode-ai/sdk/v2/client"
import { queryKeys } from "../../shared/query/keys"
import { shellDataKeys, type SessionScopedQueryKey, type WorkspaceScopedQueryKey } from "./keys"
import type { SessionRef } from "../identity/session-ref"
import type { ClaxedoSession } from "../../shared/data/session-types"
import { sameSessionIdentity } from "./global-session-identity"
export type { PermissionRequest, QuestionRequest, SessionStatus, SnapshotFileDiff, Todo } from "@opencode-ai/sdk/v2/client"
export {
  setSessionDiffQueryData,
  setSessionRequestsQueryData,
  setSessionStatusQueryData,
  setSessionTodoQueryData,
  type ShellQueryDataWriter,
} from "./writers"

type SessionStatusClient = {
  session: {
    status: () => Promise<{ data?: Record<string, SessionStatus> }>
  }
}

type SessionRequestsClient = {
  permission: {
    list: () => Promise<{ data?: PermissionRequest[] }>
  }
  question: {
    list: () => Promise<{ data?: QuestionRequest[] }>
  }
}

export type SessionRequestsQueryData = {
  permissions: PermissionRequest[]
  questions: QuestionRequest[]
}

type SessionTodoClient = {
  session: {
    todo: (input: { sessionID: string }) => Promise<{ data?: Todo[] }>
  }
}

type SessionDiffClient = {
  session: {
    diff: (input: { sessionID: string }) => Promise<{ data?: SnapshotFileDiff[] }>
  }
}

export type DirectorySessionCacheValue = {
  at: number
  limit: number
  total: number
  session: ClaxedoSession[]
}

type PageState = { hasMore: boolean; loading: boolean; cursor?: number }

type SessionInventoryIdentity = {
  id: string
  directory?: string
  workspaceId?: string
  workspaceName?: string
  projectID?: string
  tags?: string[]
  time?: number | { updated?: number; created?: number }
}

export type SessionInventoryWorkspaceGroup<TSession> = {
  key?: string
  directory: string
  workspaceId?: string
  workspaceName?: string
  projectID: string
  sessions: TSession[]
  hasMore: boolean
  total: number
  nextCursor?: number
}

export type SessionInventoryWorkspaceMeta = Omit<SessionInventoryWorkspaceGroup<never>, "sessions">

export type SessionInventoryStoredValue<TSession> = {
  sessions: TSession[]
  globalState: PageState
  projectState: Record<string, PageState>
  workspaceMeta: Record<string, SessionInventoryWorkspaceMeta>
  workspaceState: Record<string, PageState>
  workspaceOrder: string[]
  loading: boolean
  loaded: boolean
  initialCursor?: number
}

export type SessionInventoryValue<TSession> = {
  sessions: TSession[]
  sessionOrder: string[]
  global: TSession[]
  globalState: PageState
  byProject: Record<string, TSession[]>
  projectState: Record<string, PageState>
  byWorkspace: Record<string, SessionInventoryWorkspaceGroup<TSession>>
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

function sortSessions<TSession extends SessionInventoryIdentity>(sessions: readonly TSession[]) {
  return [...sessions].sort((a, b) => sessionUpdatedAt(b) - sessionUpdatedAt(a))
}

function dedupeSessions<TSession extends SessionInventoryIdentity>(sessions: readonly TSession[]) {
  const next: TSession[] = []
  for (const session of sortSessions(sessions)) {
    if (!next.some((item) => sameSessionIdentity(item, session))) next.push(session)
  }
  return next
}

export function deriveSessionInventoryIndexes<TSession extends SessionInventoryIdentity>(
  input: Pick<SessionInventoryValue<TSession>, "sessions" | "workspaceState" | "workspaceOrder" | "projectState" | "globalState"> & {
    byWorkspace?: Record<string, SessionInventoryWorkspaceGroup<TSession>>
    workspaceMeta?: Record<string, SessionInventoryWorkspaceMeta>
  },
) {
  const sessions = dedupeSessions(input.sessions)
  const sessionById = new Map(sessions.map((session) => [session.id, session] as const))
  const global = sessions.filter(sessionShouldShowInGlobalChat)
  const byProject: Record<string, TSession[]> = {}
  const byWorkspace: Record<string, SessionInventoryWorkspaceGroup<TSession>> = {}
  const workspaceMeta: Record<string, SessionInventoryWorkspaceMeta> = { ...(input.workspaceMeta ?? {}) }
  const workspaceOrder = [...input.workspaceOrder]
  const sessionIds = new Set(sessions.map((session) => session.id))

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
    workspaceMeta[workspaceKey] = {
      key: group.key ?? workspaceKey,
      directory: group.directory,
      workspaceId: group.workspaceId,
      workspaceName: group.workspaceName,
      projectID: group.projectID,
      hasMore: group.hasMore,
      total: group.total,
      nextCursor: group.nextCursor,
    }
    if (!workspaceOrder.includes(workspaceKey)) workspaceOrder.push(workspaceKey)
  }

  for (const [workspaceKey, previous] of Object.entries(input.byWorkspace ?? {})) {
    const state = input.workspaceState[workspaceKey]
    const meta = workspaceMeta[workspaceKey] ?? previous
    const page = dedupeSessions(previous.sessions.flatMap((session) => {
      const canonical = sessionById.get(session.id)
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
    workspaceMeta[workspaceKey] = {
      key: byWorkspace[workspaceKey].key,
      directory: byWorkspace[workspaceKey].directory,
      workspaceId: byWorkspace[workspaceKey].workspaceId,
      workspaceName: byWorkspace[workspaceKey].workspaceName,
      projectID: byWorkspace[workspaceKey].projectID,
      hasMore: byWorkspace[workspaceKey].hasMore,
      total: byWorkspace[workspaceKey].total,
      nextCursor: byWorkspace[workspaceKey].nextCursor,
    }
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

export function normalizeSessionInventory<TSession extends SessionInventoryIdentity>(
  input: SessionInventoryStoredValue<TSession> | SessionInventoryValue<TSession>,
): SessionInventoryValue<TSession> {
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

const derivedSessionInventoryCache = new WeakMap<object, SessionInventoryValue<unknown>>()

export function deriveSessionInventoryValue<TSession extends SessionInventoryIdentity>(
  input: SessionInventoryStoredValue<TSession>,
): SessionInventoryValue<TSession> {
  const cached = derivedSessionInventoryCache.get(input)
  if (cached) return cached as SessionInventoryValue<TSession>
  const value = normalizeSessionInventory(input)
  derivedSessionInventoryCache.set(input, value as SessionInventoryValue<unknown>)
  return value
}

export function toSessionInventoryStore<TSession extends SessionInventoryIdentity>(
  input: SessionInventoryStoredValue<TSession> | SessionInventoryValue<TSession>,
): SessionInventoryStoredValue<TSession> {
  const workspaceMeta: Record<string, SessionInventoryWorkspaceMeta> = { ...input.workspaceMeta }
  if ("byWorkspace" in input) {
    for (const [key, group] of Object.entries(input.byWorkspace)) {
      if (workspaceMeta[key]) continue
      workspaceMeta[key] = {
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
  }
  const legacyRows = "global" in input
    ? [
      ...input.global,
      ...Object.values(input.byProject).flat(),
      ...Object.values(input.byWorkspace).flatMap((group) => group.sessions),
    ]
    : []
  return {
    sessions: dedupeSessions(input.sessions.length > 0 ? input.sessions : legacyRows),
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

export function emptySessionInventoryStore<TSession>(): SessionInventoryStoredValue<TSession> {
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

export function emptySessionInventory<TSession>(): SessionInventoryValue<TSession> {
  return normalizeSessionInventory(emptySessionInventoryStore<TSession>() as SessionInventoryStoredValue<TSession & SessionInventoryIdentity>)
}

export function sessionInventoryQueryOptions<TSession = unknown>(input: {
  baseUrl?: string
}) {
  return queryOptions<SessionInventoryStoredValue<TSession & SessionInventoryIdentity>, Error, SessionInventoryValue<TSession & SessionInventoryIdentity>>({
    queryKey: queryKeys.shell.sessionInventory(input.baseUrl),
    queryFn: skipToken,
    select: deriveSessionInventoryValue,
  })
}

export function sessionQueryOptions<T>(input: {
  ref: SessionRef
  resource: string
  params?: ReadonlyArray<unknown>
  queryFn: () => Promise<T>
  staleTime?: number
}) {
  return queryOptions({
    queryKey: shellDataKeys.session(input.ref, input.resource, ...(input.params ?? [])),
    queryFn: input.queryFn,
    ...(input.staleTime === undefined ? {} : { staleTime: input.staleTime }),
  })
}

export function workspaceQueryOptions<T>(input: {
  workspaceId: string
  resource: string
  params?: ReadonlyArray<unknown>
  queryFn: () => Promise<T>
  staleTime?: number
}) {
  return queryOptions({
    queryKey: shellDataKeys.workspace(input.workspaceId, input.resource, ...(input.params ?? [])),
    queryFn: input.queryFn,
    ...(input.staleTime === undefined ? {} : { staleTime: input.staleTime }),
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

export function dbReadyQuery<T>(input: {
  queryKey: SessionScopedQueryKey | WorkspaceScopedQueryKey
  queryFn: () => Promise<T>
  staleTime?: number
}) {
  return queryOptions({
    queryKey: input.queryKey,
    queryFn: input.queryFn,
    ...(input.staleTime === undefined ? {} : { staleTime: input.staleTime }),
  })
}

export function sessionStatusQueryOptions(input: {
  sessionId: string
  client: SessionStatusClient
  staleTime?: number
}) {
  return queryOptions({
    queryKey: shellDataKeys.sessionId(input.sessionId, "status"),
    queryFn: async () => (await input.client.session.status()).data?.[input.sessionId] ?? { type: "idle" as const },
    staleTime: input.staleTime ?? 5_000,
  })
}

export function sessionRequestsQueryOptions(input: {
  sessionId: string
  client: SessionRequestsClient
  staleTime?: number
}) {
  return queryOptions({
    queryKey: shellDataKeys.sessionId(input.sessionId, "requests"),
    queryFn: async () => {
      const [permissions, questions] = await Promise.all([
        input.client.permission.list().then((result) => result.data ?? []).catch((): PermissionRequest[] => []),
        input.client.question.list().then((result) => result.data ?? []).catch((): QuestionRequest[] => []),
      ])
      return {
        permissions: permissions.filter((item) => item.sessionID === input.sessionId),
        questions: questions.filter((item) => item.sessionID === input.sessionId),
      } satisfies SessionRequestsQueryData
    },
    staleTime: input.staleTime ?? 5_000,
  })
}

export function sessionTodoQueryOptions(input: {
  sessionId: string
  client: SessionTodoClient
  staleTime?: number
}) {
  return queryOptions({
    queryKey: shellDataKeys.sessionId(input.sessionId, "todo"),
    queryFn: async () => (await input.client.session.todo({ sessionID: input.sessionId })).data ?? [],
    staleTime: input.staleTime ?? 30_000,
  })
}

export function sessionDiffQueryOptions(input: {
  sessionId: string
  client: SessionDiffClient
  staleTime?: number
}) {
  return queryOptions({
    queryKey: shellDataKeys.sessionId(input.sessionId, "diff"),
    queryFn: async () => (await input.client.session.diff({ sessionID: input.sessionId })).data ?? [],
    staleTime: input.staleTime ?? 30_000,
  })
}
