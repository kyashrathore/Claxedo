import { createEffect, createMemo, createSignal, on, onCleanup, type Accessor } from "solid-js"
import type {
  AgentSessionStartBinding,
  AgentPermission as PermissionRequest,
  AgentQuestion as QuestionRequest,
  AgentRuntimeStatus as SessionStatus,
} from "@claxedo/agent-runtime-contract"
import { useGlobalSDK, useSDK } from "@/features/session/app-ports"
import { diffs as list } from "@/lib/diffs"
import { idleSessionStatus, isSessionTurnActive } from "./session-store"
import {  dispatchSessionTodoEvent } from "./session-status-dispatcher"
import { hydrateConversationPage, resolveStoredMessages, resolveStoredParts } from "../conversation/conversation-hydrator"
import { createActiveConversationSnapshot, registeredConversationSnapshot, registeredConversationUserMessages } from "../conversation/conversation-registry"
import { observeSessionStatusPoll } from "./session-status-telemetry"
import { createTurnCoverageOwner } from "./session-coverage-obligations"
import { sessionHistoryResyncMatches, sessionHistoryResyncRequest } from "./session-history-resync"
import {
  DEFAULT_SESSION_TRANSPORT_CAPABILITIES,
  fetchSessionByTransport,
  fetchSessionMessagesByTransport,
  fetchSessionTodoByTransport,
  PENDING_SCOPED_TRANSPORT_CAPABILITIES,
  shouldFetchSessionAlongsideHistory,
  fetchTransportSession,
  type SessionTransportCapabilities,
  usesClaxedoSessionTransport,
} from "./session-transport"
import { useDirectorySessionCacheActions } from "../data/sync/directory-session-cache"
import {
  directorySessionCacheQueryOptions,
  type DirectorySessionCacheValue,
  type SessionRequestsQueryData,
} from "../data/sync/queries"
import { removeSessionInventoryQueryData } from "../data/sync/session-inventory"
import { removeSessionListQueryData } from "../data/query/session-list"
import {
  getSessionPrefetch,
  getSessionPrefetchPromise,
  SESSION_OLDER_HISTORY_PAGE_MESSAGE_COUNT,
  sessionHistoryPageRequest,
  type SessionPrefetchPage,
} from "@/platform/sync/session-prefetch"
import { shellDataKeys } from "@/platform/sync/keys"
import type { SessionMessagePageRequest } from "@/platform/runtime/session"
import { queryClient } from "@/platform/query/query-client"
import { settledQueryData as settledData } from "@/platform/query/settled-query-data"
import { isWorkspaceReady } from "@/features/session/app-ports"
import { scheduleSessionProjectionPull, sessionProjectionWorkspaceBacking } from "@/platform/runtime/agent/session-projection"
import { directorySessionCacheOwnsSession, removeDirectorySession, upsertDirectorySession } from "../data/sync/directory-session-cache"
import { FAST_SESSION_SWITCH_NETWORK_QUIET_MS, FIRST_FOLD_SESSION_BACKGROUND_HYDRATE_DELAY_MS, FIRST_FOLD_SESSION_META_HYDRATE_DELAY_MS, fastSessionSwitchQuietDelay, fastSessionSwitchNetworkQuiet, suppressedByFastSessionSwitch } from "@/platform/runtime/session-switch"
import { createHistoryMetaState, historyHasMore, historyIsLoading } from "./history-pagination"
import type { SessionRef } from "@/platform/identity/session-ref"
import { createLatestTurnCompletion, firstFoldSessionPrefetch, joinFirstFoldSessionPrefetch, latestTurnWindowNeedsTailSync, runFirstFoldFallback, scheduleDeferredFirstFoldPrefetch, shouldScheduleFirstFoldHistory } from "./first-fold-prefetch"
import { hydrateFirstFoldSessionPrefetch } from "./first-fold-hydration"
import { conversationHasAssistantMessage } from "./assistant-turn-evidence"
import { createActivePaneProjection } from "./active-pane-projection"
import { createSessionPaneQueries, sessionCapabilitiesKey, sessionTodoTransportRequestKey, sessionTransportRequestKey } from "./session-pane-queries"
import { sessionHydrationAuthorityKey } from "./session-resource-authority"
import {
  ACTIVE_SESSION_STATUS_POLL_DELAY_MS,
  ACTIVE_SESSION_STATUS_POLL_INTERVAL_MS,
  activeSessionStatusPollingDecision,
  createActiveSessionStatusPoll,
  shouldStartActiveSessionStatusPolling,
  waitForFirstActiveSessionStatusPoll,
} from "./active-session-status-poll"
import { syncSessionCapabilitiesData } from "./session-capabilities-query"
import { createSessionGoalController } from "./session-goal-controller"
import { applyDirectorySessionMeta } from "./directory-session-meta"
import { leasedQueryRequest } from "./leased-query-request"
import { setDirectorySessionMetaQueryData } from "../data/sync/writers"
import {
  classifySessionHistoryReadFailure,
  createActivationSessionReadEpoch,
  firstFoldSessionHydrateDelay,
  isSessionNotFoundError,
  shouldAcceptSessionTransportResult,
  shouldDeferSessionTransportHydrate,
  shouldSkipSessionTransportHydrate,
} from "./session-history-activation"
import type { RelayHostKind } from "@/platform/runtime/placement-wire"
import {
  FIRST_FOLD_SECONDARY_HYDRATION_EARLIEST_MS,
  scheduleActivationWork,
  TURN_SETTLEMENT_CATCH_UP_EARLIEST_MS,
} from "./session-activation-work"
export { FAST_SESSION_SWITCH_NETWORK_QUIET_MS, FIRST_FOLD_SESSION_BACKGROUND_HYDRATE_DELAY_MS, FIRST_FOLD_SESSION_META_HYDRATE_DELAY_MS } from "@/platform/runtime/session-switch"
export { resolveStoredMessages, resolveStoredParts }
export { conversationHasAssistantMessage, conversationHasTurnReply } from "./assistant-turn-evidence"
export { firstFoldSessionPrefetch } from "./first-fold-prefetch"
export { createSessionInfoHydrationGetter, fetchTransportSession } from "./session-transport"
export function sessionHistoryKey(input: { sessionID: string; directory: string }) {
  return `${input.directory}\0${input.sessionID}`
}

type DirectoryRef = Parameters<typeof sessionHistoryKey>[0]["directory"]

function markLiveSession(event: Pick<ReturnType<typeof useGlobalSDK>["event"], "setLiveSession">, sessionID: string, directory: DirectoryRef, workspaceId?: string, sessionRef?: SessionRef) {
  event.setLiveSession(sessionID, { directory, workspaceId, host: sessionRef?.host, sessionRef })
}

function scheduleDelayedTask(task: () => void, delay: number) {
  const timer = setTimeout(task, delay)
  return () => clearTimeout(timer)
}

type MetaPayload = {
  readErrors?: SessionRequestsQueryData["readErrors"]
  status?: Record<string, SessionStatus>
  permissions?: PermissionRequest[]
  questions?: QuestionRequest[]
}
const HYDRATE_FRESH_MS = 15_000
export {
  ACTIVE_SESSION_STATUS_POLL_DELAY_MS,
  ACTIVE_SESSION_STATUS_POLL_INTERVAL_MS,
  activeSessionStatusPollingDecision,
  shouldStartActiveSessionStatusPolling,
  waitForFirstActiveSessionStatusPoll,
}

function metaKey(directory: string, includeRequests?: boolean) {
  return ["shell", "directory", directory, "session-meta", includeRequests === false ? "status" : "requests"] as const
}

export function removeDirectorySessionCacheRow(directory: string, sessionID: string) {
  removeDirectorySession(directory, sessionID)
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
  if (typeof localStorage === "undefined" || localStorage.getItem("claxedo.debug.session-hydrate") !== "1") return
  // oxlint-disable-next-line no-console -- opt-in tracing behind the localStorage flag above
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
  currentDirectory?: Accessor<string | undefined>
  includeRequests?: boolean
  force?: boolean
  instrumentPoll?: boolean
  signal?: AbortSignal
  sdk: {
    session: {
      status: (input?: undefined, options?: { signal?: AbortSignal }) => Promise<{ data?: Record<string, SessionStatus> }>
    }
    permission: {
      list: (input?: undefined, options?: { signal?: AbortSignal }) => Promise<{ data?: PermissionRequest[] }>
    }
    question: {
      list: (input?: undefined, options?: { signal?: AbortSignal }) => Promise<{ data?: QuestionRequest[] }>
    }
  }
}) {
  let payload: MetaPayload
  try {
    payload = input.directory
      ? await loadSessionMeta({
          directory: input.directory,
          includeRequests: input.includeRequests,
          force: input.force,
          signal: input.signal,
          sdk: input.sdk,
        })
      : await fetchSessionMeta({
          includeRequests: input.includeRequests,
          signal: input.signal,
          sdk: input.sdk,
        })
  } catch (error) {
    if (input.signal?.aborted) return false
    throw error
  }
  const { status, permissions, questions, readErrors } = payload

  if (input.signal?.aborted) return false
  if (!shouldAcceptSessionTransportResult({
    expectedSessionID: input.sessionID,
    currentSessionID: input.currentSessionID(),
    expectedDirectory: input.directory,
    currentDirectory: input.currentDirectory?.(),
  })) return false

  if (input.instrumentPoll && status !== undefined) {
    observeSessionStatusPoll({
      directory: input.directory,
      sessionID: input.sessionID,
      status: status[input.sessionID],
    })
  }

  applyDirectorySessionMeta({ sessionID: input.sessionID, status, permissions, questions, readErrors })

  return true
}

async function fetchSessionMeta(input: {
  includeRequests?: boolean
  signal?: AbortSignal
  sdk: {
    session: {
      status: (input?: undefined, options?: { signal?: AbortSignal }) => Promise<{ data?: Record<string, SessionStatus> }>
    }
    permission: {
      list: (input?: undefined, options?: { signal?: AbortSignal }) => Promise<{ data?: PermissionRequest[] }>
    }
    question: {
      list: (input?: undefined, options?: { signal?: AbortSignal }) => Promise<{ data?: QuestionRequest[] }>
    }
  }
}): Promise<MetaPayload> {
  const unavailableUnlessAborted = (error: unknown) => {
    if (input.signal?.aborted) throw error
    return undefined
  }
  const readErrors: NonNullable<SessionRequestsQueryData["readErrors"]> = {}
  const requestFailed = (kind: "permissions" | "questions") => (error: unknown) => {
    if (input.signal?.aborted) throw error
    readErrors[kind] = error instanceof Error ? error.message : String(error)
    return undefined
  }
  const [status, permissions, questions] = await Promise.all([
    input.sdk.session.status(undefined, { signal: input.signal }).then((x) => x.data)
      .catch(unavailableUnlessAborted),
    input.includeRequests === false
      ? Promise.resolve(undefined)
      : input.sdk.permission.list(undefined, { signal: input.signal }).then((x) => x.data)
        .catch(requestFailed("permissions")),
    input.includeRequests === false
      ? Promise.resolve(undefined)
      : input.sdk.question.list(undefined, { signal: input.signal }).then((x) => x.data)
        .catch(requestFailed("questions")),
  ])
  return { status, permissions, questions, ...(input.includeRequests === false ? {} : { readErrors }) }
}

function loadSessionMeta(input: Parameters<typeof fetchSessionMeta>[0] & { directory: string; force?: boolean }) {
  const key = metaKey(input.directory, input.includeRequests)
  const cached = queryClient.getQueryData<MetaPayload>(key)
  const updatedAt = queryClient.getQueryState<MetaPayload>(key)?.dataUpdatedAt ?? 0
  const complete = cached?.status !== undefined && (input.includeRequests === false || (
    cached.permissions !== undefined && cached.questions !== undefined
  ))
  if (!input.force && complete && Date.now() - updatedAt < HYDRATE_FRESH_MS) return Promise.resolve(cached)
  return leasedQueryRequest({
    scopeKey: ["runtime", "directory-session-meta-request", input.directory, input.includeRequests === false ? "status" : "requests"],
    authority: input.sdk,
    signal: input.signal,
    queryFn: (signal) => fetchSessionMeta({ ...input, signal }),
  }).then((value) => {
    setDirectorySessionMetaQueryData({ queryClient, queryKey: key, value })
    return value
  })
}

export function createSessionController(input: {
  directory: Accessor<string>
  sessionID: Accessor<string | undefined>
  pendingSessionStart?: Accessor<AgentSessionStartBinding | undefined>
  serverHealthy: Accessor<boolean | undefined>
  active?: Accessor<boolean>
  signedControlPlane?: Accessor<boolean>
  workspaceId?: Accessor<string | undefined>
  // The workspace's resolved host, from the pane's connection authority —
  // threaded into the session transports so a signed read of a workspace on
  // another machine diverts to the relay (the central control plane has no
  // session store for those).
  hostKind?: Accessor<RelayHostKind | undefined>
  sessionRef?: Accessor<SessionRef | undefined>
  onMissingSession?: (sessionID: string, cwd: string) => void
}) {
  const sdk = useSDK()
  const globalSDK = useGlobalSDK()
  const paneActive = input.active ?? (() => true)
  const directorySessionCacheActions = useDirectorySessionCacheActions()
  const { meta: historyMeta, setValue: setHistoryMetaValue } = createHistoryMetaState()
  const [missingSessions, setMissingSessions] = createSignal<Record<string, boolean | undefined>>({})
  let sessionActivationEpoch = 0
  const {
    statusQuery,
    requestQuery,
    todoQuery,
    diffQuery,
    capabilitiesQuery,
    goalQuery,
    directorySessionCacheQuery,
    sessionRowQuery,
  } = createSessionPaneQueries({
    active: paneActive,
    pendingSessionStart: input.pendingSessionStart,
    sessionID: input.sessionID,
    directory: input.directory,
    serverUrl: () => globalSDK.url,
    signedControlPlane: input.signedControlPlane,
    workspaceId: input.workspaceId,
    hostKind: input.hostKind,
    sessionRef: input.sessionRef,
    fetchSessionRow: async (sessionID) => (await fetchSessionByTransport({
      directory: input.directory(),
      sessionID,
      claxedoServerUrl: globalSDK.url,
      signedControlPlane: input.signedControlPlane?.() ?? false,
      workspaceId: input.signedControlPlane?.() ? input.workspaceId?.() : undefined,
      hostKind: input.signedControlPlane?.() ? input.hostKind?.() : undefined,
      sessionRef: input.sessionRef?.(),
    })).data,
  })

  const sourceInfo = createMemo(() => {
    const sessionID = input.sessionID()
    if (!sessionID || sessionID === "new") return undefined
    if (!directorySessionCacheOwnsSession(input.sessionRef?.())) {
      return sessionRowQuery.data?.id === sessionID ? sessionRowQuery.data : undefined
    }
    return directorySessionCacheQuery.data?.session.find((session) => session.id === sessionID)
  })
  const info = createActivePaneProjection({
    active: paneActive,
    read: sourceInfo,
    initial: undefined as ReturnType<typeof sourceInfo>,
  })

  const activeConversation = createActiveConversationSnapshot({ directory: input.directory, sessionID: input.sessionID, active: paneActive })
  const sourceMessages = createMemo(() => {
    const sessionID = input.sessionID()
    if (!sessionID || sessionID === "new") return undefined
    const snapshot = activeConversation()
    if (!snapshot) return undefined
    if (snapshot.messages.length > 0) return snapshot.messages
    if (historyMeta().limit[sessionHistoryKey({ sessionID, directory: input.directory() })] !== undefined) {
      return snapshot.messages
    }
    return undefined
  })
  const messages = createActivePaneProjection({
    active: paneActive,
    read: sourceMessages,
    initial: undefined as ReturnType<typeof sourceMessages>,
  })

  const sourceTodos = createMemo(() => {
    const sessionID = input.sessionID()
    if (!sessionID || sessionID === "new") return []
    return settledData(todoQuery) ?? []
  })
  const todos = createActivePaneProjection({ active: paneActive, read: sourceTodos, initial: [] as ReturnType<typeof sourceTodos> })

  const sourceDiffs = createMemo(() => {
    const sessionID = input.sessionID()
    if (!sessionID || sessionID === "new") return []
    return list(settledData(diffQuery))
  })
  const diffs = createActivePaneProjection({ active: paneActive, read: sourceDiffs, initial: [] as ReturnType<typeof sourceDiffs> })
  const sourceDiffsReady = createMemo(() => {
    const sessionID = input.sessionID()
    if (!sessionID || sessionID === "new") return true
    return settledData(diffQuery) !== undefined
  })
  const diffsReady = createActivePaneProjection({ active: paneActive, read: sourceDiffsReady, initial: true })

  // status/request are LIVE mirrors: on draft->session handoff their fresh
  // observers sit in "pending" for the first fetch while the turn is
  // already busy, so a settled-only read reports idle exactly when the stop
  // control must show. Plain .data is safe here — the vendored solid-query
  // patch removed client-side query suspension globally, which the settled gate existed to avoid.
  const sourceStatus = createMemo(() => {
    const sessionID = input.sessionID()
    if (!sessionID || sessionID === "new") return idleSessionStatus
    return statusQuery.data ?? idleSessionStatus
  })
  const status = createActivePaneProjection({ active: paneActive, read: sourceStatus, initial: idleSessionStatus })

  createTurnCoverageOwner({
    sessionID: input.sessionID,
    directory: input.directory,
    paneActive,
    client: sdk.client,
    createReadEpoch: createActivationSessionReadEpoch,
    loadedTurnIds: () =>
      registeredConversationUserMessages(input.directory(), input.sessionID()).map((message) => message.id),
    status,
  })

  const statusReady = createMemo(() => !input.sessionID() || input.sessionID() === "new" || statusQuery.data !== undefined)

  const sourcePermissionRequest = createMemo(() => {
    const sessionID = input.sessionID()
    if (!sessionID || sessionID === "new") return undefined
    return requestQuery.data?.permissions[0]
  })
  const permissionRequest = createActivePaneProjection({
    active: paneActive,
    read: sourcePermissionRequest,
    initial: undefined as ReturnType<typeof sourcePermissionRequest>,
  })

  const sourceQuestionRequest = createMemo(() => {
    const sessionID = input.pendingSessionStart?.()?.sessionId ?? input.sessionID()
    if (!sessionID || sessionID === "new") return undefined
    return requestQuery.data?.questions[0]
  })
  const questionRequest = createActivePaneProjection({
    active: paneActive,
    read: sourceQuestionRequest,
    initial: undefined as ReturnType<typeof sourceQuestionRequest>,
  })

  const blocked = createMemo(() => !!permissionRequest() || !!questionRequest())
  const sourceCapabilities = createMemo(() => {
    const sessionID = input.sessionID()
    if (!sessionID || sessionID === "new") return DEFAULT_SESSION_TRANSPORT_CAPABILITIES
    return settledData(capabilitiesQuery) ?? PENDING_SCOPED_TRANSPORT_CAPABILITIES
  })
  const capabilities = createActivePaneProjection({
    active: paneActive,
    read: sourceCapabilities,
    initial: DEFAULT_SESSION_TRANSPORT_CAPABILITIES,
  })
  const goals = createSessionGoalController({
    active: paneActive,
    sessionID: input.sessionID,
    directory: input.directory,
    serverUrl: () => globalSDK.url,
    signedControlPlane: input.signedControlPlane,
    workspaceId: input.workspaceId,
    hostKind: input.hostKind,
    sessionRef: input.sessionRef,
    source: () => settledData(goalQuery),
    suppressed: suppressedByFastSessionSwitch,
  })
  const sourceActiveTurn = createMemo(() => {
    const sessionID = input.sessionID()
    if (!sessionID || sessionID === "new") return false
    return isSessionTurnActive({
      status: status(),
      permissions: requestQuery.data?.permissions,
      questions: requestQuery.data?.questions,
    })
  })
  const activeTurn = createActivePaneProjection({ active: paneActive, read: sourceActiveTurn, initial: false })

  const sourceHistoryMore = createMemo(() => {
    const sessionID = input.sessionID()
    if (!sessionID || sessionID === "new") return false
    return historyHasMore(historyMeta(), sessionHistoryKey({ sessionID, directory: input.directory() }))
  })
  const historyMore = createActivePaneProjection({ active: paneActive, read: sourceHistoryMore, initial: false })

  const sourceHistoryLoading = createMemo(() => {
    const sessionID = input.sessionID()
    if (!sessionID || sessionID === "new") return false
    return historyIsLoading(historyMeta(), sessionHistoryKey({ sessionID, directory: input.directory() }))
  })
  const historyLoading = createActivePaneProjection({ active: paneActive, read: sourceHistoryLoading, initial: false })

  const sourceMissing = createMemo(() => {
    const sessionID = input.sessionID()
    if (!sessionID || sessionID === "new") return false
    return missingSessions()[sessionHistoryKey({ sessionID, directory: input.directory() })] === true
  })
  const missing = createActivePaneProjection({ active: paneActive, read: sourceMissing, initial: false })

  const seedFirstFoldFromPrefetch = (sessionID: string) => {
    const directory = input.directory()
    const prefetch = firstFoldSessionPrefetch({
      sessionID,
      directory,
      info: getSessionPrefetch(directory, sessionID),
    })
    if (!prefetch) return false
    const split = hydrateFirstFoldSessionPrefetch({ directory, sessionID, prefetch })
    if (!split) return false

    const key = sessionHistoryKey({ sessionID, directory })
    // IDs alone do not prove the bounded surface is present: the helper above
    // always applies its selected message/parts and preserves identities on a
    // genuine no-op.
    setHistoryMetaValue("cursor", key, prefetch.cursor)
    setHistoryMetaValue("failedCursor", key, undefined)
    setHistoryMetaValue("complete", key, prefetch.complete)
    setHistoryMetaValue("limit", key, prefetch.limit)
    return { deferred: split.deferred }
  }

  const syncSessionHistory = async (
    sessionID: string,
    opts?: { force?: boolean; before?: string; view?: "latest-turn" | "latest-surface"; tail?: boolean; mode?: "replace" | "prepend" | "replace-window"; bypassQuiet?: boolean; silent?: boolean; activationEpoch?: number; signal?: AbortSignal },
  ) => {
    if (opts?.signal?.aborted) return false
    if (suppressedByFastSessionSwitch(sessionID)) return false
    if (shouldSkipSessionTransportHydrate({ sessionID, ...opts })) return false
    const directory = input.directory()
    const signedControlPlane = input.signedControlPlane?.() ?? false
    const workspaceId = signedControlPlane ? input.workspaceId?.() : undefined
    const hostKind = input.signedControlPlane?.() ? input.hostKind?.() : undefined
    // A dead CLOUD workspace keeps its transcript centrally, so the message read
    // must not divert to a relay that cannot answer (branch B of `resolveSessionResourceRoute`).
    const workspaceReachable = workspaceId ? isWorkspaceReady(workspaceId) : undefined
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
    const pageRequest: SessionMessagePageRequest = opts?.view
      ? { view: opts.view }
      : opts?.tail
        ? { limit: SESSION_OLDER_HISTORY_PAGE_MESSAGE_COUNT }
        : sessionHistoryPageRequest(opts?.before)
    const shouldFetchSession = shouldFetchSessionAlongsideHistory({
      before: opts?.before, view: pageRequest.view, hasSession, force: opts?.force, title: cachedSession?.title,
    })
    const transportRequest = () => fetchTransportSession({
      shouldFetchSession,
      fetchSession: () => fetchSessionByTransport({
        directory,
        sessionID,
        claxedoServerUrl: globalSDK.url,
        signedControlPlane,
        workspaceId,
        hostKind,
        sessionRef: input.sessionRef?.(),
      }),
      fetchMessages: () => fetchSessionMessagesByTransport({
        directory,
        sessionID,
        claxedoServerUrl: globalSDK.url,
        ...pageRequest,
        signedControlPlane,
        workspaceId,
        hostKind,
        workspaceReachable,
        sessionRef: input.sessionRef?.(),
        signal: opts?.signal,
      }),
    })
    // Activation-local reads carry their own AbortSignal and therefore bypass
    // the query single-flight. Aborting a stale pane must never cancel a rail
    // prefetch or another owner that happens to share the same query key.
    return (opts?.force || opts?.signal
      ? transportRequest()
      : queryClient.fetchQuery({
          queryKey: sessionTransportRequestKey({
            sessionID,
            directory,
            before: opts?.before,
            view: pageRequest.view,
            limit: pageRequest.limit,
            shouldFetchSession,
            signedControlPlane,
            workspaceId,
            hostKind,
          }),
          queryFn: transportRequest, gcTime: 0,
        }))
      .then((result) => {
        if (opts?.signal?.aborted) return false
        if (result.session && "error" in result.session && isSessionNotFoundError(result.session.error)) {
          forgetUnavailableSession(directory, sessionID, "missing")
          return false
        }
        if (!shouldAcceptSessionTransportResult({
          expectedSessionID: sessionID,
          currentSessionID: input.sessionID(),
          expectedDirectory: directory,
          currentDirectory: input.directory(),
          expectedActivationEpoch: opts?.activationEpoch,
          currentActivationEpoch: sessionActivationEpoch,
        })) {
          return false
        }
        if (!opts?.silent) setMissingSession(directory, sessionID, false)
        if (!opts?.silent && result.session?.data) {
          if (directorySessionCacheOwnsSession(input.sessionRef?.())) upsertDirectorySession(directory, result.session.data)
        }
        const messageCount = hydrateConversationPage({
          directory,
          sessionID,
          rows: result.messages.data ?? [],
          mode: opts?.mode,
          messageCompleteness: pageRequest.view === "latest-surface" ? "fragment" : "canonical",
          partCompleteness: pageRequest.view === "latest-surface" ? "fragment" : "canonical",
        })
        // `workspaceId` is the live session's scope for the subagent registry
        // (a change of workspace resets it); the stream reads the address the
        // pane published, not this.
        if (!opts?.silent) globalSDK.event.setLiveSession(sessionID, { directory, workspaceId, host: input.sessionRef?.()?.host, sessionRef: input.sessionRef?.() })
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
        if (opts?.signal?.aborted) return false
        const failure = classifySessionHistoryReadFailure({ error, before: opts?.before })
        if (failure.kind === "unhandled") throw error
        if (failure.kind === "page") {
          setHistoryMetaValue("failedCursor", key, failure.failedCursor)
          return false
        }
        if (failure.kind === "denied") {
          // Settling on "session unavailable" is all this read owes the pane;
          // closing it stays with the revocation reconcile.
          forgetUnavailableSession(directory, sessionID, "denied")
          return false
        }
        forgetUnavailableSession(directory, sessionID, "missing")
        return false
      })
      .finally(() => {
        if (!opts?.silent) setHistoryMetaValue("loading", key, false)
      })
  }

  /**
   * Drop a session the pane can no longer read from every cache that would
   * re-offer it, and settle the pane on its "session unavailable" surface.
   *
   * `cause` is the reason the read stopped being answerable, and it decides
   * whether a repair is worth attempting. A session the runtime no longer has
   * may still be re-materializable from a signed control plane's projection, so
   * "missing" schedules the repair pull. "denied" is the authority's own answer
   * about this principal, so pulling again would only ask the same question.
   */
  const forgetUnavailableSession = (directory: string, sessionID: string, cause: "missing" | "denied") => {
    removeDirectorySessionCacheRow(directory, sessionID)
    removeSessionInventoryQueryData({
      baseUrl: globalSDK.url,
      session: { id: sessionID, directory },
    })
    removeSessionListQueryData({
      baseUrl: globalSDK.url,
      sessionId: sessionID,
      directory,
      workspaceId: input.workspaceId?.(),
    })
    setMissingSession(directory, sessionID, true)
    if (cause === "missing" && !input.signedControlPlane?.()) input.onMissingSession?.(sessionID, directory)
    if (cause !== "missing" || !input.signedControlPlane?.()) return
    const workspaceId = input.workspaceId?.()
    void scheduleSessionProjectionPull({
      action: "repair",
      reason: "repair",
      workspaceId,
      sessionId: sessionID,
      idempotencyKey: `missing-session:${workspaceId ?? ""}:${sessionID}`,
    })
  }

  const setMissingSession = (directory: string, sessionID: string, missing: boolean) => {
    const key = sessionHistoryKey({ sessionID, directory })
    setMissingSessions((sessions) => ({
      ...sessions,
      [key]: missing,
    }))
  }

  // The row query can discover deletion even when persisted history needs no
  // fetch. Reconcile its authoritative rejection through the same owner as a
  // failed history read; missing rows in a directory listing are not evidence.
  createEffect(on(
    () => [paneActive(), input.directory(), input.sessionID(), sessionRowQuery.error] as const,
    ([active, directory, sessionID, error]) => {
      if (!active || !sessionID || sessionID === "new" || !error) return
      const failure = classifySessionHistoryReadFailure({ error })
      if (failure.kind === "missing" || failure.kind === "denied") {
        forgetUnavailableSession(directory, sessionID, failure.kind)
      }
    },
  ))

  const syncSessionTodo = async (sessionID: string, opts?: { force?: boolean }) => {
    if (suppressedByFastSessionSwitch(sessionID)) return false
    const cached = queryClient.getQueryData(shellDataKeys.sessionId(sessionID, "todo")) !== undefined
    if (cached && !opts?.force) return true
    const directory = input.directory()
    const signedControlPlane = input.signedControlPlane?.() ?? false
    const workspaceId = signedControlPlane ? input.workspaceId?.() : undefined
    return queryClient.fetchQuery({
      queryKey: sessionTodoTransportRequestKey({ sessionID, directory, signedControlPlane, workspaceId, hostKind: signedControlPlane ? input.hostKind?.() : undefined }),
      queryFn: async () => (await fetchSessionTodoByTransport({
        directory,
        sessionID,
        claxedoServerUrl: globalSDK.url,
        signedControlPlane,
        workspaceId,
        hostKind: signedControlPlane ? input.hostKind?.() : undefined,
        sessionRef: input.sessionRef?.(),
      })).data ?? [],
    }).then((todo) => {
      if (!shouldAcceptSessionTransportResult({
        expectedSessionID: sessionID,
        currentSessionID: input.sessionID(),
        expectedDirectory: directory,
        currentDirectory: input.directory(),
      })) return false
      dispatchSessionTodoEvent({ event: { type: "session.todo", source: "server", sessionID, todos: todo } })
      return true
    })
  }

  // The workspace stream reported a hole or opened without a cursor: what the
  // session did meanwhile is behind the stream, and the stream is live again,
  // so the turn's state is repaired by reading it — the latest-turn window and
  // the todo list, which has no stream-independent read of its own. Each
  // mounted controller answers once per request for its own session; a
  // request raised before this controller mounted is already covered by the
  // history its activation loads.
  let handledHistoryResync = sessionHistoryResyncRequest()?.sequence ?? 0
  createEffect(
    on(
      () => [sessionHistoryResyncRequest(), input.sessionID(), input.directory(), paneActive()] as const,
      ([request, sessionID, directory, active]) => {
        if (!active || !request || !sessionID || request.sequence <= handledHistoryResync) return
        if (!sessionHistoryResyncMatches({ request, sessionID, directory })) return
        handledHistoryResync = request.sequence
        void syncSessionHistory(sessionID, { force: true, view: "latest-turn", mode: "replace-window", bypassQuiet: true, silent: true }).catch(() => undefined)
        void syncSessionTodo(sessionID, { force: true }).catch(() => undefined)
      },
    ),
  )

  const syncSessionCapabilities = async (sessionID: string, opts?: { force?: boolean; signal?: AbortSignal }) => {
    if (suppressedByFastSessionSwitch(sessionID)) return false
    const directory = input.directory()
    const signedControlPlane = input.signedControlPlane?.() ?? false
    const workspaceId = signedControlPlane ? input.workspaceId?.() : undefined
    const hostKind = signedControlPlane ? input.hostKind?.() : undefined
    const sessionRef = input.sessionRef?.()
    const key = sessionCapabilitiesKey({
      sessionID,
      directory,
      serverUrl: globalSDK.url,
      signedControlPlane,
      workspaceId,
      hostKind,
      sessionRef,
    })
    if (queryClient.getQueryData<SessionTransportCapabilities>(key) && !opts?.force) return true
    return syncSessionCapabilitiesData({
      request: {
        directory,
        sessionID,
        claxedoServerUrl: globalSDK.url,
        signedControlPlane,
        workspaceId,
        hostKind,
        sessionRef,
      },
      currentSessionID: input.sessionID,
      currentDirectory: input.directory,
      signal: opts?.signal,
    })
  }

  const refreshMeta = async (sessionID = input.sessionID(), opts?: {
    force?: boolean
    includeRequests?: boolean
    instrumentPoll?: boolean
    signal?: AbortSignal
  }) => {
    if (!sessionID || sessionID === "new") return false
    const cached =
      queryClient.getQueryData(shellDataKeys.sessionId(sessionID, "status")) !== undefined &&
      queryClient.getQueryData(shellDataKeys.sessionId(sessionID, "requests")) !== undefined
    if (cached && !opts?.force) return true

    return syncSessionMeta({
      directory: input.directory(),
      sessionID,
      currentSessionID: input.sessionID,
      currentDirectory: input.directory,
      includeRequests: opts?.includeRequests,
      force: opts?.force,
      instrumentPoll: opts?.instrumentPoll,
      signal: opts?.signal,
      sdk: sdk.client,
    })
  }

  createActiveSessionStatusPoll({
    active: paneActive,
    directory: input.directory,
    sessionID: input.sessionID,
    enabled: () => {
      const sessionID = input.sessionID()
      if (!sessionID || sessionID === "new") return false
      const workspaceId = input.workspaceId?.()
      return !input.signedControlPlane?.() &&
        activeTurn() &&
        input.serverHealthy() === true &&
        (workspaceId === undefined || isWorkspaceReady(workspaceId)) &&
        shouldStartActiveSessionStatusPolling({ directory: input.directory(), sessionID })
    },
    refresh: (sessionID, signal) => refreshMeta(sessionID, {
      force: true,
      includeRequests: false,
      instrumentPoll: true,
      signal,
    }),
  })

  createEffect(
    on(
      () => {
        if (!paneActive()) return undefined
        return [
          input.directory(),
          input.sessionID(),
          input.serverHealthy(),
          true,
          input.signedControlPlane?.() ?? false,
          sessionHydrationAuthorityKey(input.sessionRef?.()),
        ] as const
      },
      (state) => {
        if (!state) return
        const [directory, sessionID, healthy, paneActive, signedControlPlane] = state
        const activationEpoch = ++sessionActivationEpoch
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
        const readEpoch = createActivationSessionReadEpoch()
        const activationAt = Date.now()
        const quiet = fastSessionSwitchNetworkQuiet({ sessionId: id })
        const initialSeed = seedFirstFoldFromPrefetch(id)
        const prefetched = !!initialSeed
        markLiveSession(globalSDK.event, id, directory, signedControlPlane ? input.workspaceId?.() : undefined, input.sessionRef?.())
        const syncFirstFoldHistory = async () => {
          const synced = await syncSessionHistory(id, { bypassQuiet: true, activationEpoch, signal: readEpoch.signal })
          sessionHydrationDebug("sync-session-complete", { directory, sessionID: id, synced })
          return synced
        }
        const prefetchRequest = prefetched ? undefined : getSessionPrefetchPromise(directory, id)
        const hydrateDelay = quiet
          ? fastSessionSwitchQuietDelay({
            sessionId: id,
            baseDelay: FIRST_FOLD_SESSION_BACKGROUND_HYDRATE_DELAY_MS,
          })
          : firstFoldSessionHydrateDelay({
            sessionID: id,
            prefetched: prefetched || !!prefetchRequest,
          })
        let cancelDeferredPrefetch = () => {}
        const latestTurnCompletion = createLatestTurnCompletion({
          activationAt,
          active: () => readEpoch.active() && input.directory() === directory && input.sessionID() === id && input.active?.() !== false,
          complete: async () => {
            const synced = await syncSessionHistory(id, { force: true, view: "latest-turn", mode: "replace-window", bypassQuiet: true, silent: true, activationEpoch, signal: readEpoch.signal })
            if (!synced) return
            if (!latestTurnWindowNeedsTailSync(registeredConversationSnapshot(directory, id)?.messages)) return
            await syncSessionHistory(id, { force: true, tail: true, mode: "replace-window", bypassQuiet: true, silent: true, activationEpoch, signal: readEpoch.signal })
          },
          onError: (error) => sessionHydrationDebug("latest-turn-error", {
            directory,
            sessionID: id,
            error: error instanceof Error ? error.message : String(error),
          }),
        })
        if (prefetchRequest) latestTurnCompletion.block()
        const scheduleDeferredPrefetch = (page: SessionPrefetchPage | undefined) => {
          if (!page?.messages.length) return
          cancelDeferredPrefetch()
          cancelDeferredPrefetch = scheduleDeferredFirstFoldPrefetch({
            delay: Math.max(0, activationAt + hydrateDelay - Date.now()),
            active: () => readEpoch.active() && input.directory() === directory && input.sessionID() === id && input.active?.() !== false,
            hydrate: () => hydrateConversationPage({
              directory, sessionID: id, messages: page.messages,
              parts: page.parts.map((row) => ({ id: row.id, parts: row.part })),
              messageCompleteness: "fragment", partCompleteness: "fragment",
            }),
          })
        }
        if (initialSeed) scheduleDeferredPrefetch(initialSeed.deferred)
        if (prefetchRequest) {
          void joinFirstFoldSessionPrefetch({
            request: prefetchRequest,
            active: () => readEpoch.active() && input.directory() === directory && input.sessionID() === id && input.active?.() !== false,
            seed: () => {
              const seed = seedFirstFoldFromPrefetch(id)
              if (!seed) return false
              scheduleDeferredPrefetch(seed.deferred)
              return true
            },
            onSeed: () => { latestTurnCompletion.schedule(); latestTurnCompletion.unblock() },
            onEmpty: () => { latestTurnCompletion.schedule(); latestTurnCompletion.unblock() },
            fallback: () => runFirstFoldFallback({
              sync: syncFirstFoldHistory,
              scheduleCompletion: latestTurnCompletion.schedule,
              unblockCompletion: latestTurnCompletion.unblock,
            }),
            onError: (error) => sessionHydrationDebug("first-fold-error", {
              directory,
              sessionID: id,
              error: error instanceof Error ? error.message : String(error),
            }),
          })
        }
        const cancelHydration = scheduleDelayedTask(() => {
          if (!readEpoch.active() || input.directory() !== directory || input.sessionID() !== id || input.active?.() === false) return
          sessionHydrationDebug("sync-start", { directory, sessionID: id, hydrateDelay, quiet, prefetched })
          if (shouldScheduleFirstFoldHistory({ prefetched, request: prefetchRequest })) {
            void syncFirstFoldHistory().then((synced) => { if (synced) latestTurnCompletion.schedule() })
          } else if (!prefetchRequest) {
            latestTurnCompletion.schedule()
          }
        }, hydrateDelay)
        const cancelSecondaryHydration = scheduleActivationWork({
          activationAt,
          earliestMs: FIRST_FOLD_SECONDARY_HYDRATION_EARLIEST_MS,
          requestedDelay: hydrateDelay,
          active: () => readEpoch.active() && input.directory() === directory && input.sessionID() === id && input.active?.() !== false,
          run: () => {
            void syncSessionCapabilities(id, { signal: readEpoch.signal })
            void goals.sync(id, { signal: readEpoch.signal })
            void syncSessionTodo(id)
          },
        })
        const cancelMeta = scheduleDelayedTask(() => {
          if (input.directory() !== directory || input.sessionID() !== id || input.active?.() === false) return
          // Forced, not cached-checked: a request resolved off-client while this
          // pane was away stays in the push cache, and the dock's attach gate
          // waits on this read to confirm what is still pending.
          void refreshMeta(id, { includeRequests: true, force: true })
        }, Math.max(FIRST_FOLD_SESSION_META_HYDRATE_DELAY_MS, hydrateDelay + 600))
        onCleanup(() => {
          readEpoch.abort()
          if (sessionActivationEpoch === activationEpoch) sessionActivationEpoch += 1
          cancelHydration()
          cancelSecondaryHydration()
          cancelMeta()
          cancelDeferredPrefetch()
          latestTurnCompletion.cancel()
        })
      },
    ),
  )

  let previousActiveTurn: ActiveTurnSnapshot | undefined
  createEffect(
    on(
      () => {
        if (!paneActive()) return undefined
        return [input.directory(), input.sessionID(), activeTurn(), true] as const
      },
      (state) => {
        if (!state) return
        const [directory, sessionID, active, paneActive] = state
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
          const workspace = sessionProjectionWorkspaceBacking({ signedControlPlane: input.signedControlPlane?.() ?? false, workspaceId: input.workspaceId?.(), hostKind: input.hostKind?.() })
          if (workspace) {
            void scheduleSessionProjectionPull({
              action: "checkpoint",
              reason: "message-checkpoint",
              workspaceId: workspace.workspaceId,
              sessionId: sessionID,
              idempotencyKey: `active-turn-settled:${workspace.workspaceId}:${sessionID}:${Date.now()}`,
            })
          }
          void syncSessionHistory(sessionID, { force: true })
          void syncSessionTodo(sessionID, { force: true })
          void directorySessionCacheActions.refresh({ directory, ...(workspace ? { workspace } : {}) })
        }
        const quietDelay = fastSessionSwitchQuietDelay({ sessionId: sessionID })
        const cancelSettlementCatchUp = scheduleActivationWork({
          activationAt: Date.now(),
          earliestMs: TURN_SETTLEMENT_CATCH_UP_EARLIEST_MS,
          requestedDelay: quietDelay > 0 ? quietDelay + 100 : undefined,
          active: () => input.active?.() !== false && input.directory() === directory && input.sessionID() === sessionID,
          run: refresh,
        })
        onCleanup(cancelSettlementCatchUp)
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
    statusReady,
    permissionRequest,
    questionRequest,
    blocked,
    capabilities,
    ...goals.actions,
    activeTurn,
    missing,
    historyMore,
    historyLoading,
    refreshMeta,
    loadMore: async (sessionID: string) => {
      const before = historyMeta().cursor[sessionHistoryKey({ sessionID, directory: input.directory() })]
      if (!before) return
      await syncSessionHistory(sessionID, { before, mode: "prepend" })
    },
  }
}
