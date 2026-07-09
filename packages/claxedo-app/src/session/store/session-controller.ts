import { createEffect, createMemo, createSignal, on, onCleanup, type Accessor } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import type { Message, PermissionRequest, QuestionRequest, SessionStatus } from "@opencode-ai/sdk/v2/client"
import { useGlobalSDK } from "@/context/global-sdk"
import { useSDK } from "@/context/sdk"
import { diffs as list } from "@/utils/diffs"
import { idleSessionStatus, isSessionTurnActive, mergeBusySessionStatus, pickSessionPermissions, pickSessionQuestions } from "./session-store"
import { dispatchSessionRequestsEvent, dispatchSessionStatusEvent, dispatchSessionTodoEvent } from "./session-status-dispatcher"
import { registeredConversationSnapshot } from "../../shell/chat/conversation-registry"
import { hydrateConversationPage, resolveStoredMessages, resolveStoredParts } from "../../shell/chat/conversation-hydrator"
import { observeSessionStatusPoll, sessionStatusPollingRemovalGate } from "./session-status-telemetry"
import { acceptedPromptRefreshRequest, type AcceptedPromptRefresh } from "./accepted-prompt-refresh"
import {
  DEFAULT_OPENCODE_TRANSPORT_CAPABILITIES,
  fetchSessionCapabilitiesByTransport,
  fetchSessionByTransport,
  fetchSessionMessagesByTransport,
  fetchSessionTodoByTransport,
  type SessionTransportCapabilities,
  usesClaxedoSessionTransport,
} from "./session-transport"
import { useDirectorySessionCacheActions } from "../../shell/data/directory-session-cache"
import {
  directorySessionCacheQueryOptions,
  type DirectorySessionCacheValue,
  sessionDiffQueryOptions,
  sessionRequestsQueryOptions,
  sessionStatusQueryOptions,
  sessionTodoQueryOptions,
} from "../../shell/data/queries"
import { removeSessionInventoryQueryData, useSessionInventoryActions } from "../../shell/data/session-inventory"
import { getSessionPrefetch, getSessionPrefetchPromise, SESSION_PREFETCH_TTL, type SessionPrefetchMeta } from "../../shell/data/session-prefetch"
import { shellDataKeys } from "../../shell/data/keys"
import { queryClient } from "../../shared/query/query-client"
import { isWorkspaceReady } from "../../shell/workspace/workspace-connection"
import { useWorkspaceQuery } from "../../shell/workspace/use-workspace-query"
import { scheduleSessionProjectionPull } from "../../runtime/session-projection"
import { removeDirectorySession, upsertDirectorySession } from "../../shell/data/directory-session-cache"
import { FAST_SESSION_SWITCH_NETWORK_QUIET_MS, FIRST_FOLD_SESSION_BACKGROUND_HYDRATE_DELAY_MS, FIRST_FOLD_SESSION_META_HYDRATE_DELAY_MS, fastSessionSwitchQuietDelay, fastSessionSwitchNetworkQuiet, suppressedByFastSessionSwitch } from "./fast-session-switch"
import { assistantMessageIdForUserMessage } from "../../shared/data/session-types"

export {
  FAST_SESSION_SWITCH_NETWORK_QUIET_MS,
  FIRST_FOLD_SESSION_BACKGROUND_HYDRATE_DELAY_MS,
  FIRST_FOLD_SESSION_META_HYDRATE_DELAY_MS,
} from "./fast-session-switch"

export { resolveStoredMessages, resolveStoredParts }

export function sessionHistoryKey(input: { sessionID: string; directory: string }) {
  return `${input.directory}\0${input.sessionID}`
}

type DirectoryRef = Parameters<typeof sessionHistoryKey>[0]["directory"]

function markLiveSession(event: Pick<ReturnType<typeof useGlobalSDK>["event"], "setLiveSession">, sessionID: string, directory: DirectoryRef, workspaceId?: string) {
  event.setLiveSession(sessionID, { directory, workspaceId })
}

function scheduleDelayedTask(task: () => void, delay: number) {
  const timer = setTimeout(task, delay)
  return () => clearTimeout(timer)
}

export function conversationHasAssistantMessage(sessionID: string, assistantMessageId: string | undefined) {
  if (!assistantMessageId) return false
  const conversation = registeredConversationSnapshot(sessionID)
  const message = conversation.messages.find((item) => item.role === "assistant" && item.id === assistantMessageId)
  if (!message) return false
  return "error" in message && !!message.error || (conversation.parts[assistantMessageId]?.length ?? 0) > 0
}

export function firstFoldSessionHydrateDelay(input: {
  sessionID: string
  prefetched?: boolean
  now?: number
  baseDelay?: number
}) {
  if (input.prefetched === false) return input.baseDelay ?? 0
  return fastSessionSwitchQuietDelay({
    sessionId: input.sessionID,
    now: input.now,
    baseDelay: input.baseDelay ?? FIRST_FOLD_SESSION_BACKGROUND_HYDRATE_DELAY_MS,
  })
}

export function shouldSkipSessionTransportHydrate(input: {
  sessionID: string
  force?: boolean
  before?: string
  bypassQuiet?: boolean
  now?: number
}) {
  if (input.force || input.before || input.bypassQuiet) return false
  return fastSessionSwitchNetworkQuiet({ sessionId: input.sessionID, now: input.now })
}

export function shouldDeferSessionTransportHydrate(input: {
  loading?: boolean
  force?: boolean
}) {
  return input.loading === true && input.force !== true
}

export function acceptedPromptRefreshMatches(input: {
  request?: Pick<AcceptedPromptRefresh, "sessionID" | "directory">
  sessionID?: string
  currentDirectory: DirectoryRef
}) {
  return !!input.request &&
    input.request.sessionID === input.sessionID &&
    input.request.directory === input.currentDirectory
}

export function shouldAcceptSessionTransportResult(input: {
  expectedSessionID: string
  currentSessionID: string | undefined
}) {
  return input.currentSessionID === input.expectedSessionID
}

type MetaPayload = {
  status: Record<string, SessionStatus>
  permissions?: PermissionRequest[]
  questions?: QuestionRequest[]
}
type HistoryMeta = {
  limit: Record<string, number | undefined>
  cursor: Record<string, string | undefined>
  failedCursor: Record<string, string | undefined>
  complete: Record<string, boolean | undefined>
  loading: Record<string, boolean | undefined>
}
const HYDRATE_FRESH_MS = 15_000
export const ACTIVE_SESSION_STATUS_POLL_DELAY_MS = 60_000
export const ACTIVE_SESSION_STATUS_POLL_INTERVAL_MS = 5_000
const ACCEPTED_PROMPT_REFRESH_ATTEMPT_DELAYS_MS = [0, 600, 1_200, 2_400, 4_000, 8_000, 12_000] as const
const PENDING_SCOPED_TRANSPORT_CAPABILITIES: SessionTransportCapabilities = {
  ...DEFAULT_OPENCODE_TRANSPORT_CAPABILITIES,
  abort: false,
  permissions: false,
  questions: false,
  commands: false,
  fork: false,
  revert: false,
  unrevert: false,
  configOptions: false,
}

type ActiveSessionStatusPollStartedKeys = Pick<Set<string>, "has" | "add">

export async function waitForFirstActiveSessionStatusPoll(input: {
  key: string
  startedKeys: ActiveSessionStatusPollStartedKeys
  wait?: (delay: number, signal?: AbortSignal) => Promise<void>
  signal?: AbortSignal
}) {
  if (input.startedKeys.has(input.key)) return
  input.startedKeys.add(input.key)
  await (input.wait ?? waitForActiveStatusPollDelay)(ACTIVE_SESSION_STATUS_POLL_DELAY_MS, input.signal)
}

function waitForActiveStatusPollDelay(delay: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }
    const timer = setTimeout(resolve, delay)
    signal?.addEventListener("abort", () => {
      clearTimeout(timer)
      reject(signal.reason)
    }, { once: true })
  })
}

function promptRefreshDelay(delay: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, delay))
}

export function shouldStartActiveSessionStatusPolling(input: {
  directory?: string
  sessionID: string
}) {
  return activeSessionStatusPollingDecision(input).shouldStart
}

export function activeSessionStatusPollingDecision(input: {
  directory?: string
  sessionID: string
}) {
  const gate = sessionStatusPollingRemovalGate(input)
  return {
    shouldStart: !gate.canDisablePolling,
    ...gate,
  }
}

export async function fetchCompatTransportSession<TSession, TMessages>(input: {
  shouldFetchSession: boolean
  fetchSession: () => Promise<TSession>
  fetchMessages: () => Promise<TMessages>
}) {
  const session = input.shouldFetchSession ? await input.fetchSession() : undefined
  return {
    session,
    messages: await input.fetchMessages(),
  }
}

function metaKey(directory: string, includeRequests?: boolean) {
  return ["shell", "directory", directory, "session-meta", includeRequests === false ? "status" : "requests"] as const
}

export function firstFoldSessionPrefetch(input: {
  sessionID: string
  directory: string
  info?: SessionPrefetchMeta
  now?: number
}) {
  if (!input.info) return
  if (input.info.directory !== input.directory) return
  if (!input.info.messages || input.info.messages.length === 0) return
  if ((input.now ?? Date.now()) - input.info.at > SESSION_PREFETCH_TTL) return
  return input.info
}

export function removeDirectorySessionCacheRow(directory: string, sessionID: string) {
  removeDirectorySession(directory, sessionID)
}

export function isSessionNotFoundError(error: unknown) {
  const value = typeof error === "string"
    ? error
    : error instanceof Error
      ? error.message
      : JSON.stringify(error)
  return value.includes("session_not_found") || value.includes("Session not found") || value.includes("Request failed: 404")
}

function sessionCapabilitiesKey(sessionID: string) {
  return shellDataKeys.sessionId(sessionID, "transport-capabilities")
}

function sessionTodoTransportRequestKey(input: {
  sessionID: string
  directory: string
  signedControlPlane?: boolean
  workspaceId?: string
  workspaceKind?: "cloud" | "user-hosted"
}) {
  return shellDataKeys.sessionId(
    input.sessionID,
    "todo-request",
    input.directory,
    input.signedControlPlane === true ? "signed" : "local",
    input.workspaceId ?? "",
    input.workspaceKind ?? "",
  )
}

function sessionTransportRequestKey(input: {
  sessionID: string
  directory: string
  before?: string
  limit: number
  shouldFetchSession: boolean
  signedControlPlane?: boolean
  workspaceId?: string
  workspaceKind?: "cloud" | "user-hosted"
}) {
  return shellDataKeys.sessionId(
    input.sessionID,
    "transport-session-request",
    input.directory,
    input.before ?? "latest",
    input.limit,
    input.shouldFetchSession ? "with-session" : "messages-only",
    input.signedControlPlane === true ? "signed" : "local",
    input.workspaceId ?? "",
    input.workspaceKind ?? "",
  )
}

export function shouldHydrateSession(input: {
  sessionID?: string
  directory?: string
  healthy?: boolean
  active?: boolean
  signedControlPlane?: boolean
}) {
  if (input.active === false) return false
  const scopedTransport = usesClaxedoSessionTransport(input.sessionID, input.directory)
  const allowed = !!input.sessionID &&
    input.sessionID !== "new" &&
    (input.signedControlPlane === true || input.healthy === true || scopedTransport)
  return allowed
}

export function shouldReuseSessionHistory(input: {
  before?: string
  cachedCount?: number
  hasSession: boolean
  cached: boolean
  force?: boolean
  signedControlPlane?: boolean
  workspaceId?: string
}) {
  if (input.before || input.force || input.signedControlPlane) return false
  if (input.workspaceId && input.cachedCount === 0) return false
  return input.hasSession && input.cached
}

function sessionHydrationDebug(phase: string, data: Record<string, unknown>) {
  if (!import.meta.env.DEV) return
  console.debug("[claxedo:session-hydrate]", phase, data)
}

type ActiveTurnSnapshot = {
  key: string
  active: boolean
}

export function activeTurnTransition(input: {
  previous?: ActiveTurnSnapshot
  directory: string
  sessionID?: string
  active: boolean
}) {
  const key = input.sessionID && input.sessionID !== "new"
    ? sessionHistoryKey({ directory: input.directory, sessionID: input.sessionID })
    : undefined
  return {
    settled: !!key && input.previous?.key === key && input.previous.active && !input.active,
    next: key ? { key, active: input.active } : undefined,
  }
}

export async function syncSessionMeta(input: {
  directory?: string
  sessionID: string
  currentSessionID: Accessor<string | undefined>
  includeRequests?: boolean
  force?: boolean
  instrumentPoll?: boolean
  sdk: {
    session: {
      status: () => Promise<{ data?: Record<string, SessionStatus> }>
    }
    permission: {
      list: () => Promise<{ data?: PermissionRequest[] }>
    }
    question: {
      list: () => Promise<{ data?: QuestionRequest[] }>
    }
  }
}) {
  const { status, permissions, questions } = input.directory
    ? await loadSessionMeta({
        directory: input.directory,
        includeRequests: input.includeRequests,
        force: input.force,
        sdk: input.sdk,
      })
    : await fetchSessionMeta({
        includeRequests: input.includeRequests,
        sdk: input.sdk,
      })

  if (!shouldAcceptSessionTransportResult({ expectedSessionID: input.sessionID, currentSessionID: input.currentSessionID() })) return false

  if (input.instrumentPoll) {
    observeSessionStatusPoll({
      directory: input.directory,
      sessionID: input.sessionID,
      status: status[input.sessionID],
    })
  }

  const cachedRequests = queryClient.getQueryData<{ permissions: PermissionRequest[]; questions: QuestionRequest[] }>(
    shellDataKeys.sessionId(input.sessionID, "requests"),
  )
  const sessionPermissions =
    permissions === undefined ? cachedRequests?.permissions ?? [] : pickSessionPermissions(permissions, input.sessionID)
  const sessionQuestions =
    questions === undefined ? cachedRequests?.questions ?? [] : pickSessionQuestions(questions, input.sessionID)
  const server = status[input.sessionID]
  const activeEvidence = isSessionTurnActive({
    permissions: sessionPermissions,
    questions: sessionQuestions,
  })
  const nextStatus = mergeBusySessionStatus(
    queryClient.getQueryData<SessionStatus>(shellDataKeys.sessionId(input.sessionID, "status")),
    server,
    activeEvidence,
  ) ?? idleSessionStatus
  dispatchSessionStatusEvent({ event: { type: "session.status", source: "server", sessionID: input.sessionID, status: nextStatus } })
  if (permissions !== undefined || questions !== undefined) {
    dispatchSessionRequestsEvent({
      event: {
        type: "session.requests", source: "server", sessionID: input.sessionID,
        requests: {
          permissions: sessionPermissions,
          questions: sessionQuestions,
        },
      },
    })
  }

  return true
}

async function fetchSessionMeta(input: {
  includeRequests?: boolean
  sdk: {
    session: {
      status: () => Promise<{ data?: Record<string, SessionStatus> }>
    }
    permission: {
      list: () => Promise<{ data?: PermissionRequest[] }>
    }
    question: {
      list: () => Promise<{ data?: QuestionRequest[] }>
    }
  }
}): Promise<MetaPayload> {
  const [status, permissions, questions] = await Promise.all([
    input.sdk.session.status().then((x) => x.data ?? {}).catch((): Record<string, SessionStatus> => ({})),
    input.includeRequests === false
      ? Promise.resolve(undefined)
      : input.sdk.permission.list().then((x) => x.data ?? []).catch((): PermissionRequest[] => []),
    input.includeRequests === false
      ? Promise.resolve(undefined)
      : input.sdk.question.list().then((x) => x.data ?? []).catch((): QuestionRequest[] => []),
  ])
  return { status, permissions, questions }
}

function loadSessionMeta(input: Parameters<typeof fetchSessionMeta>[0] & { directory: string; force?: boolean }) {
  const key = metaKey(input.directory, input.includeRequests)
  const cached = queryClient.getQueryData<MetaPayload>(key)
  const updatedAt = queryClient.getQueryState<MetaPayload>(key)?.dataUpdatedAt ?? 0
  if (!input.force && cached && Date.now() - updatedAt < HYDRATE_FRESH_MS) return Promise.resolve(cached)
  return queryClient.fetchQuery({
    queryKey: key,
    queryFn: () => fetchSessionMeta(input),
    staleTime: input.force ? 0 : HYDRATE_FRESH_MS,
  })
}

export function createSessionController(input: {
  directory: Accessor<string>
  sessionID: Accessor<string | undefined>
  serverHealthy: Accessor<boolean | undefined>
  active?: Accessor<boolean>
  signedControlPlane?: Accessor<boolean>
  workspaceId?: Accessor<string | undefined>
  // The workspace's resolved hosting kind (cloud vs user-hosted) from the
  // pane's connection authority — threaded into the session transports so
  // signed user-hosted reads divert to the relay (the central control plane
  // has no session store for them).
  workspaceKind?: Accessor<"cloud" | "user-hosted" | undefined>
}) {
  const sdk = useSDK()
  const globalSDK = useGlobalSDK()
  const sessionInventoryActions = useSessionInventoryActions()
  const directorySessionCacheActions = useDirectorySessionCacheActions()
  const [historyMeta, setHistoryMeta] = createSignal<HistoryMeta>({
    limit: {} as Record<string, number | undefined>,
    cursor: {} as Record<string, string | undefined>,
    failedCursor: {} as Record<string, string | undefined>,
    complete: {} as Record<string, boolean | undefined>,
    loading: {} as Record<string, boolean | undefined>,
  })
  const [missingSessions, setMissingSessions] = createSignal<Record<string, boolean | undefined>>({})
  const setHistoryMetaValue = <T extends keyof HistoryMeta>(field: T, key: string, value: HistoryMeta[T][string]) =>
    setHistoryMeta((meta) => meta[field][key] === value
      ? meta
      : {
        ...meta,
        [field]: {
          ...meta[field],
          [key]: value,
        },
      })
  const statusQuery = useQuery(() => {
    const sessionID = input.sessionID()
    return {
      ...sessionStatusQueryOptions({
        sessionId: !sessionID || sessionID === "new" ? "__claxedo_idle_session__" : sessionID,
        client: sdk.client,
      }),
      enabled: false,
    }
  })
  const requestQuery = useQuery(() => {
    const sessionID = input.sessionID()
    return {
      ...sessionRequestsQueryOptions({
        sessionId: !sessionID || sessionID === "new" ? "__claxedo_idle_session__" : sessionID,
        client: sdk.client,
      }),
      enabled: false,
    }
  })
  const todoQuery = useQuery(() => {
    const sessionID = input.sessionID()
    return {
      ...sessionTodoQueryOptions({
        sessionId: !sessionID || sessionID === "new" ? "__claxedo_idle_session__" : sessionID,
        client: sdk.client,
      }),
      enabled: false,
    }
  })
  const diffQuery = useQuery(() => {
    const sessionID = input.sessionID()
    return {
      ...sessionDiffQueryOptions({
        sessionId: !sessionID || sessionID === "new" ? "__claxedo_idle_session__" : sessionID,
        client: sdk.client,
      }),
      enabled: false,
    }
  })
  const capabilitiesQuery = useQuery(() => {
    const sessionID = input.sessionID()
    return {
      queryKey: sessionCapabilitiesKey(!sessionID || sessionID === "new" ? "__claxedo_idle_session__" : sessionID),
      queryFn: async () => DEFAULT_OPENCODE_TRANSPORT_CAPABILITIES,
      enabled: false,
    }
  })
  // `skipToken` cache slot (populated by refresh, not auto-fetched) — routed
  // through the authority for structural connection-awareness. `enabled:false`
  // does not drop cached `.data`, so `info`/`messages` derivations below keep
  // reading the warm cache; relay-backed scopes simply stop being considered a
  // live source while offline. Local scopes (`workspaceId` undefined) are a
  // no-op gate (always ready).
  const directorySessionCacheQuery = useWorkspaceQuery(() => ({
    ...directorySessionCacheQueryOptions({
      directory: input.directory(),
    }),
    workspaceId: input.workspaceId?.(),
  }))

  const info = createMemo(() => {
    const sessionID = input.sessionID()
    if (!sessionID || sessionID === "new") return undefined
    return directorySessionCacheQuery.data?.session.find((session) => session.id === sessionID)
  })

  const messages = createMemo(() => {
    const sessionID = input.sessionID()
    if (!sessionID || sessionID === "new") return undefined
    const snapshot = registeredConversationSnapshot(sessionID)
    if (snapshot.messages.length > 0) return snapshot.messages as Message[]
    if (historyMeta().limit[sessionHistoryKey({ sessionID, directory: input.directory() })] !== undefined) {
      return snapshot.messages as Message[]
    }
    return undefined
  })

  const todos = createMemo(() => {
    const sessionID = input.sessionID()
    if (!sessionID || sessionID === "new") return []
    return todoQuery.data ?? []
  })

  const diffs = createMemo(() => {
    const sessionID = input.sessionID()
    if (!sessionID || sessionID === "new") return []
    return list(diffQuery.data)
  })
  const diffsReady = createMemo(() => {
    const sessionID = input.sessionID()
    if (!sessionID || sessionID === "new") return true
    return diffQuery.data !== undefined
  })

  const status = createMemo(() => {
    const sessionID = input.sessionID()
    if (!sessionID || sessionID === "new") return idleSessionStatus
    return statusQuery.data ?? idleSessionStatus
  })

  const permissionRequest = createMemo(() => {
    const sessionID = input.sessionID()
    if (!sessionID || sessionID === "new") return undefined
    return requestQuery.data?.permissions[0]
  })

  const questionRequest = createMemo(() => {
    const sessionID = input.sessionID()
    if (!sessionID || sessionID === "new") return undefined
    return requestQuery.data?.questions[0]
  })

  const blocked = createMemo(() => !!permissionRequest() || !!questionRequest())
  const capabilities = createMemo(() => {
    const sessionID = input.sessionID()
    if (!sessionID || sessionID === "new") return DEFAULT_OPENCODE_TRANSPORT_CAPABILITIES
    if (!usesClaxedoSessionTransport(sessionID, input.directory())) return DEFAULT_OPENCODE_TRANSPORT_CAPABILITIES
    return capabilitiesQuery.data ?? PENDING_SCOPED_TRANSPORT_CAPABILITIES
  })
  const activeTurn = createMemo(() => {
    const sessionID = input.sessionID()
    if (!sessionID || sessionID === "new") return false
    return isSessionTurnActive({
      status: status(),
      permissions: requestQuery.data?.permissions,
      questions: requestQuery.data?.questions,
    })
  })

  const historyMore = createMemo(() => {
    const sessionID = input.sessionID()
    if (!sessionID || sessionID === "new") return false
    const meta = historyMeta()
    const key = sessionHistoryKey({ sessionID, directory: input.directory() })
    return !!meta.cursor[key] &&
      meta.cursor[key] !== meta.failedCursor[key] &&
      meta.complete[key] !== true
  })

  const historyLoading = createMemo(() => {
    const sessionID = input.sessionID()
    if (!sessionID || sessionID === "new") return false
    return historyMeta().loading[sessionHistoryKey({ sessionID, directory: input.directory() })] === true
  })

  const seedFirstFoldFromPrefetch = (sessionID: string) => {
    const directory = input.directory()
    const prefetch = firstFoldSessionPrefetch({
      sessionID,
      directory,
      info: getSessionPrefetch(sessionID),
    })
    if (!prefetch) return false

    const conversation = registeredConversationSnapshot(sessionID)
    if (conversation.messages.length > 0) {
      const key = sessionHistoryKey({ sessionID, directory })
      setHistoryMetaValue("cursor", key, prefetch.cursor)
      setHistoryMetaValue("failedCursor", key, undefined)
      setHistoryMetaValue("complete", key, prefetch.complete)
      setHistoryMetaValue("limit", key, prefetch.limit)
      return true
    }
    hydrateConversationPage({
      sessionID,
      messages: prefetch.messages ?? [],
      parts: prefetch.parts?.map((row) => ({ id: row.id, parts: row.part })),
    })
    const key = sessionHistoryKey({ sessionID, directory })
    setHistoryMetaValue("cursor", key, prefetch.cursor)
    setHistoryMetaValue("failedCursor", key, undefined)
    setHistoryMetaValue("complete", key, prefetch.complete)
    setHistoryMetaValue("limit", key, prefetch.limit)
    return true
  }

  const syncCompatSession = async (
    sessionID: string,
    opts?: { force?: boolean; before?: string; mode?: "replace" | "prepend"; bypassQuiet?: boolean; silent?: boolean },
  ) => {
    if (suppressedByFastSessionSwitch(sessionID)) return false
    if (shouldSkipSessionTransportHydrate({ sessionID, ...opts })) return false
    const directory = input.directory()
    const signedControlPlane = input.signedControlPlane?.() ?? false
    const workspaceId = signedControlPlane ? input.workspaceId?.() : undefined
    const workspaceKind = input.signedControlPlane?.() ? input.workspaceKind?.() : undefined
    const key = sessionHistoryKey({ sessionID, directory })
    if (shouldDeferSessionTransportHydrate({ loading: historyMeta().loading[key], force: opts?.force })) return false
    const cachedSession = queryClient
      .getQueryData<DirectorySessionCacheValue>(directorySessionCacheQueryOptions({ directory }).queryKey)
      ?.session.find((session) => session.id === sessionID)
    const hasSession = !!cachedSession
    const cachedCount = historyMeta().limit[key]
    const cached = cachedCount !== undefined
    if (shouldReuseSessionHistory({
      before: opts?.before,
      hasSession,
      cached,
      cachedCount,
      force: opts?.force,
      signedControlPlane,
      workspaceId,
    })) return true

    if (!opts?.silent) setHistoryMetaValue("loading", key, true)
    const limit = opts?.before ? 200 : 80
    const shouldFetchSession = !opts?.before &&
      (!hasSession || opts?.force === true || !cachedSession?.title || cachedSession.title === "New Session")
    const transportRequest = () => fetchCompatTransportSession({
      shouldFetchSession,
      fetchSession: () => fetchSessionByTransport({
        client: sdk.client.session,
        directory,
        sessionID,
        claxedoServerUrl: globalSDK.url,
        signedControlPlane,
        workspaceId,
        workspaceKind,
      }),
      fetchMessages: () => fetchSessionMessagesByTransport({
        client: sdk.client.session,
        directory,
        sessionID,
        limit,
        claxedoServerUrl: globalSDK.url,
        ...(opts?.before ? { before: opts.before } : {}),
        signedControlPlane,
        workspaceId,
        workspaceKind,
      }),
    })
    return (opts?.force
      ? transportRequest()
      : queryClient.fetchQuery({
          queryKey: sessionTransportRequestKey({
            sessionID,
            directory,
            before: opts?.before,
            limit,
            shouldFetchSession,
            signedControlPlane,
            workspaceId,
            workspaceKind,
          }),
          queryFn: transportRequest,
        }))
      .then((result) => {
        if (result.session && "error" in result.session && isSessionNotFoundError(result.session.error)) {
          removeMissingSession(directory, sessionID)
          return false
        }
        if (!shouldAcceptSessionTransportResult({ expectedSessionID: sessionID, currentSessionID: input.sessionID() })) {
          return false
        }
        if (!opts?.silent) setMissingSession(directory, sessionID, false)
        if (!opts?.silent && result.session?.data) upsertDirectorySession(directory, result.session.data)
        const messageCount = hydrateConversationPage({
          sessionID,
          rows: result.messages.data ?? [],
          mode: opts?.mode,
        })
        // Thread the scope's stable workspaceId so the runtime event stream can
        // route through the relay even when `directory` is the runtime
        // filesystem path (which the hosted inventory can't map back to a
        // workspace). Without it the stream falls through to the central control
        // plane and 404s for relay-backed (user-hosted) workspaces.
        if (!opts?.silent) globalSDK.event.setLiveSession(sessionID, { directory, workspaceId })
        const cursor = result.messages.response.headers.get("x-next-cursor") ?? undefined
        if (!opts?.silent) {
          setHistoryMetaValue("cursor", key, cursor)
          setHistoryMetaValue("failedCursor", key, undefined)
          setHistoryMetaValue("complete", key, !cursor)
          setHistoryMetaValue("limit", key, messageCount)
        }
        return true
      })
      .catch((error) => {
        if (!isSessionNotFoundError(error)) {
          if (opts?.before) {
            setHistoryMetaValue("failedCursor", key, opts.before)
            return false
          }
          throw error
        }
        removeMissingSession(directory, sessionID)
        return false
      })
      .finally(() => {
        if (!opts?.silent) setHistoryMetaValue("loading", key, false)
      })
  }

  const removeMissingSession = (directory: string, sessionID: string) => {
    removeDirectorySessionCacheRow(directory, sessionID)
    removeSessionInventoryQueryData({
      baseUrl: globalSDK.url,
      session: { id: sessionID, directory },
    })
    if (input.signedControlPlane?.()) {
      const workspaceId = input.workspaceId?.()
      void scheduleSessionProjectionPull({
        action: "repair",
        reason: "repair",
        workspaceId,
        sessionId: sessionID,
        idempotencyKey: `missing-session:${workspaceId ?? ""}:${sessionID}`,
      })
    }
    setMissingSession(directory, sessionID, true)
  }

  const setMissingSession = (directory: string, sessionID: string, missing: boolean) => {
    const key = sessionHistoryKey({ sessionID, directory })
    setMissingSessions((sessions) => ({
      ...sessions,
      [key]: missing,
    }))
  }

  createEffect(
    on(
      () => [acceptedPromptRefreshRequest(), input.sessionID(), input.directory()] as const,
      ([request, sessionID, currentDirectory]) => {
        if (!request || !acceptedPromptRefreshMatches({ request, sessionID, currentDirectory })) return
        let cancelled = false
        void (async () => {
          for (const delay of ACCEPTED_PROMPT_REFRESH_ATTEMPT_DELAYS_MS) {
            if (delay > 0) await promptRefreshDelay(delay)
            if (cancelled) return
            const synced = await syncCompatSession(request.sessionID, { force: true, silent: true })
            if (cancelled) return
            const assistantMessageId = assistantMessageIdForUserMessage(request.messageID)
            if (synced && conversationHasAssistantMessage(request.sessionID, assistantMessageId)) {
              dispatchSessionStatusEvent({ event: { type: "session.status", source: "server", sessionID: request.sessionID, status: idleSessionStatus } })
              return true
            }
          }
        })().catch(() => undefined)
        onCleanup(() => {
          cancelled = true
        })
      },
    ),
  )

  const syncCompatTodo = async (sessionID: string, opts?: { force?: boolean }) => {
    if (suppressedByFastSessionSwitch(sessionID)) return false
    const cached = queryClient.getQueryData(shellDataKeys.sessionId(sessionID, "todo")) !== undefined
    if (cached && !opts?.force) return true
    const directory = input.directory()
    const signedControlPlane = input.signedControlPlane?.() ?? false
    const workspaceId = signedControlPlane ? input.workspaceId?.() : undefined
    return queryClient.fetchQuery({
      queryKey: sessionTodoTransportRequestKey({ sessionID, directory, signedControlPlane, workspaceId, workspaceKind: signedControlPlane ? input.workspaceKind?.() : undefined }),
      queryFn: async () => (await fetchSessionTodoByTransport({
        client: sdk.client.session,
        directory,
        sessionID,
        claxedoServerUrl: globalSDK.url,
        signedControlPlane,
        workspaceId,
        workspaceKind: signedControlPlane ? input.workspaceKind?.() : undefined,
      })).data ?? [],
    }).then((todo) => {
      if (!shouldAcceptSessionTransportResult({ expectedSessionID: sessionID, currentSessionID: input.sessionID() })) return false
      dispatchSessionTodoEvent({ event: { type: "session.todo", source: "server", sessionID, todos: todo } })
      return true
    })
  }

  const syncCompatCapabilities = async (sessionID: string, opts?: { force?: boolean }) => {
    if (suppressedByFastSessionSwitch(sessionID)) return false
    const directory = input.directory()
    const key = sessionCapabilitiesKey(sessionID)
    if (queryClient.getQueryData<SessionTransportCapabilities>(key) && !opts?.force) return true
    return queryClient.fetchQuery({
      queryKey: key,
      queryFn: () => fetchSessionCapabilitiesByTransport({
        client: sdk.client.session,
        directory,
        sessionID,
        claxedoServerUrl: globalSDK.url,
        signedControlPlane: input.signedControlPlane?.() ?? false,
        workspaceId: input.signedControlPlane?.() ? input.workspaceId?.() : undefined,
        workspaceKind: input.signedControlPlane?.() ? input.workspaceKind?.() : undefined,
      }),
    }).then(() => {
      if (!shouldAcceptSessionTransportResult({ expectedSessionID: sessionID, currentSessionID: input.sessionID() })) return false
      return true
    })
  }

  const refreshMeta = async (sessionID = input.sessionID(), opts?: { force?: boolean; includeRequests?: boolean; instrumentPoll?: boolean }) => {
    if (!sessionID || sessionID === "new") return false
    if (input.signedControlPlane?.()) return input.sessionID() === sessionID
    const cached =
      queryClient.getQueryData(shellDataKeys.sessionId(sessionID, "status")) !== undefined &&
      queryClient.getQueryData(shellDataKeys.sessionId(sessionID, "requests")) !== undefined
    if (cached && !opts?.force) return true

    return syncSessionMeta({
      directory: input.directory(),
      sessionID,
      currentSessionID: input.sessionID,
      includeRequests: opts?.includeRequests,
      force: opts?.force,
      instrumentPoll: opts?.instrumentPoll,
      sdk: sdk.client,
    })
  }

  const activeStatusPollStarted = new Set<string>()
  useQuery(() => {
    const directory = input.directory()
    const sessionID = input.sessionID()
    const active = activeTurn()
    const paneActive = input.active?.() ?? true
    const healthy = input.serverHealthy()
    const workspaceReady = input.workspaceId?.() === undefined || isWorkspaceReady(input.workspaceId())
    const enabled = !!sessionID &&
      sessionID !== "new" &&
      active &&
      paneActive &&
      healthy === true &&
      workspaceReady &&
      shouldStartActiveSessionStatusPolling({ directory, sessionID })
    const pollKey = sessionID && sessionID !== "new"
      ? sessionHistoryKey({ directory, sessionID })
      : "__claxedo_idle_session__"

    return {
      queryKey: shellDataKeys.sessionId(sessionID ?? "__claxedo_idle_session__", "active-status-poll", directory),
      queryFn: async ({ signal }: { signal?: AbortSignal }) => {
        if (!sessionID || sessionID === "new") return false
        await waitForFirstActiveSessionStatusPoll({
          key: pollKey,
          startedKeys: activeStatusPollStarted,
          signal,
        })
        return refreshMeta(sessionID, { force: true, includeRequests: false, instrumentPoll: true })
      },
      enabled,
      refetchInterval: ACTIVE_SESSION_STATUS_POLL_INTERVAL_MS,
      refetchIntervalInBackground: true,
    }
  })

  createEffect(
    on(
      () => [
        input.directory(),
        input.sessionID(),
        input.serverHealthy(),
        input.active?.() ?? true,
        input.signedControlPlane?.() ?? false,
      ] as const,
      ([directory, sessionID, healthy, paneActive, signedControlPlane]) => {
        const allowed = shouldHydrateSession({
          sessionID,
          directory,
          healthy,
          active: paneActive,
          signedControlPlane,
        })
        sessionHydrationDebug("gate", {
          directory,
          sessionID,
          healthy,
          paneActive,
          signedControlPlane,
          workspaceId: signedControlPlane ? input.workspaceId?.() : undefined,
          scopedTransport: usesClaxedoSessionTransport(sessionID, directory),
          allowed,
        })
        if (!allowed) return
        const id = sessionID
        if (!id) return
        const quiet = fastSessionSwitchNetworkQuiet({ sessionId: id })
        const prefetched = seedFirstFoldFromPrefetch(id)
        if (!prefetched && !quiet) {
          void getSessionPrefetchPromise(id)?.then(() => {
            if (input.directory() !== directory || input.sessionID() !== id || input.active?.() === false) return
            seedFirstFoldFromPrefetch(id)
          })
        }
        const hydrateDelay = quiet
          ? fastSessionSwitchQuietDelay({
            sessionId: id,
            baseDelay: FIRST_FOLD_SESSION_BACKGROUND_HYDRATE_DELAY_MS,
          })
          : firstFoldSessionHydrateDelay({
            sessionID: id,
            prefetched,
          })
        const cancelHydration = scheduleDelayedTask(() => {
          if (input.directory() !== directory || input.sessionID() !== id || input.active?.() === false) return
          sessionHydrationDebug("sync-start", {
            directory,
            sessionID: id,
            hydrateDelay,
            quiet,
            prefetched,
          })
          seedFirstFoldFromPrefetch(id)
          // See the note at the other setLiveSession call site: thread the
          // scope workspaceId so the runtime stream relays for relay-backed
          // workspaces whose `directory` is a non-ref filesystem path.
          markLiveSession(globalSDK.event, id, directory, signedControlPlane ? input.workspaceId?.() : undefined)
          void syncCompatCapabilities(id)
          void syncCompatSession(id, { bypassQuiet: true }).then((synced) =>
            sessionHydrationDebug("sync-session-complete", { directory, sessionID: id, synced }))
          void syncCompatTodo(id)
        }, hydrateDelay)
        const cancelMeta = scheduleDelayedTask(() => {
          if (input.directory() !== directory || input.sessionID() !== id || input.active?.() === false) return
          void refreshMeta(id, { includeRequests: true })
        }, Math.max(FIRST_FOLD_SESSION_META_HYDRATE_DELAY_MS, hydrateDelay + 600))
        onCleanup(() => {
          cancelHydration()
          cancelMeta()
        })
      },
    ),
  )

  let previousActiveTurn: ActiveTurnSnapshot | undefined
  createEffect(
    on(
      () => [input.directory(), input.sessionID(), activeTurn(), input.active?.() ?? true] as const,
      ([directory, sessionID, active, paneActive]) => {
        const transition = activeTurnTransition({
          previous: previousActiveTurn,
          directory,
          sessionID,
          active,
        })
        previousActiveTurn = transition.next
        if (!paneActive) return
        if (!transition.settled || !sessionID || sessionID === "new") return
        const refresh = () => {
          if (input.directory() !== directory || input.sessionID() !== sessionID || input.active?.() === false) return
          const workspaceId = input.signedControlPlane?.() ? input.workspaceId?.() : undefined
          void scheduleSessionProjectionPull({
            action: "checkpoint",
            reason: "message-checkpoint",
            workspaceId,
            sessionId: sessionID,
            idempotencyKey: `active-turn-settled:${workspaceId ?? ""}:${sessionID}:${Date.now()}`,
          })
          void syncCompatSession(sessionID, { force: true })
          void syncCompatTodo(sessionID, { force: true })
          void directorySessionCacheActions.refresh({
            directory,
          })
          if (input.signedControlPlane?.()) void sessionInventoryActions.reloadWorkspace()
        }
        const quietDelay = fastSessionSwitchQuietDelay({ sessionId: sessionID })
        if (quietDelay <= 0) {
          refresh()
          return
        }
        onCleanup(scheduleDelayedTask(refresh, quietDelay + 100))
      },
    ),
  )

  return {
    info,
    messages,
    todos,
    diffs,
    diffsReady,
    status,
    permissionRequest,
    questionRequest,
    blocked,
    capabilities,
    activeTurn,
    missing: () => {
      const sessionID = input.sessionID()
      if (!sessionID || sessionID === "new") return false
      return missingSessions()[sessionHistoryKey({ sessionID, directory: input.directory() })] === true
    },
    historyMore,
    historyLoading,
    refreshMeta,
    loadMore: async (sessionID: string) => {
      const before = historyMeta().cursor[sessionHistoryKey({ sessionID, directory: input.directory() })]
      if (!before) return
      await syncCompatSession(sessionID, { before, mode: "prepend" })
    },
  }
}
