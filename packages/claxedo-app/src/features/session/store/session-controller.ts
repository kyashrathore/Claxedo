import { createEffect, createMemo, createSignal, on, onCleanup, type Accessor } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import type { Message, PermissionRequest, QuestionRequest, SessionStatus } from "@opencode-ai/sdk/v2/client"
import { useGlobalSDK, useSDK } from "@/features/session/app-ports"
import { diffs as list } from "@/lib/diffs"
import { idleSessionStatus, isSessionTurnActive, mergeBusySessionStatus, pickSessionPermissions, pickSessionQuestions } from "./session-store"
import { dispatchSessionRequestsEvent, dispatchSessionStatusEvent, dispatchSessionTodoEvent } from "./session-status-dispatcher"
import { registeredConversationSnapshot } from "../conversation/conversation-registry"
import { hydrateConversationPage, resolveStoredMessages, resolveStoredParts } from "../conversation/conversation-hydrator"
import { observeSessionStatusPoll, sessionStatusPollingRemovalGate } from "./session-status-telemetry"
import { acceptedPromptRefreshRequest, readAcceptedPromptStatus, type AcceptedPromptRefresh } from "./accepted-prompt-refresh"
import {
  DEFAULT_OPENCODE_TRANSPORT_CAPABILITIES,
  fetchSessionCapabilitiesByTransport,
  fetchSessionByTransport,
  fetchSessionMessagesByTransport,
  fetchSessionTodoByTransport,
  PENDING_SCOPED_TRANSPORT_CAPABILITIES,
  type SessionTransportCapabilities,
  usesClaxedoSessionTransport,
} from "./session-transport"
import { useDirectorySessionCacheActions } from "../data/sync/directory-session-cache"
import {
  directorySessionCacheQueryOptions,
  type DirectorySessionCacheValue,
  sessionDiffQueryOptions,
  sessionRequestsQueryOptions,
  sessionStatusQueryOptions,
  sessionTodoQueryOptions,
} from "../data/sync/queries"
import { removeSessionInventoryQueryData, useSessionInventoryActions } from "../data/sync/session-inventory"
import { scheduleSessionCacheCeiling } from "../data/sync/session-cache-cleanup"
import { getSessionPrefetch, getSessionPrefetchPromise, SESSION_PREFETCH_TTL, type SessionPrefetchMeta } from "@/platform/sync/session-prefetch"
import { shellDataKeys } from "@/platform/sync/keys"
import { queryClient } from "@/platform/query/query-client"
import { settledQueryData as settledData } from "@/platform/query/settled-query-data"
import { isWorkspaceReady, useWorkspaceQuery } from "@/features/session/app-ports"
import { scheduleSessionProjectionPull } from "@/platform/runtime/agent/session-projection"
import { removeDirectorySession, upsertDirectorySession } from "../data/sync/directory-session-cache"
import { FAST_SESSION_SWITCH_NETWORK_QUIET_MS, FIRST_FOLD_SESSION_BACKGROUND_HYDRATE_DELAY_MS, FIRST_FOLD_SESSION_META_HYDRATE_DELAY_MS, fastSessionSwitchQuietDelay, fastSessionSwitchNetworkQuiet, suppressedByFastSessionSwitch } from "@/platform/runtime/session-switch"
import { assistantMessageIdForUserMessage } from "../data/session-types"
import { backfillFailedCursor, createHistoryMetaState, historyHasMore, historyIsLoading } from "./history-pagination"
import type { SessionRef } from "@/platform/identity/session-ref"

export { FAST_SESSION_SWITCH_NETWORK_QUIET_MS, FIRST_FOLD_SESSION_BACKGROUND_HYDRATE_DELAY_MS, FIRST_FOLD_SESSION_META_HYDRATE_DELAY_MS } from "@/platform/runtime/session-switch"
export { resolveStoredMessages, resolveStoredParts }

export function sessionHistoryKey(input: { sessionID: string; directory: string }) {
  return `${input.directory}\0${input.sessionID}`
}

type DirectoryRef = Parameters<typeof sessionHistoryKey>[0]["directory"]

function markLiveSession(event: Pick<ReturnType<typeof useGlobalSDK>["event"], "setLiveSession">, sessionID: string, directory: DirectoryRef, workspaceId?: string, host?: SessionRef["host"]) {
  event.setLiveSession(sessionID, { directory, workspaceId, host })
}

function scheduleDelayedTask(task: () => void, delay: number) {
  const timer = setTimeout(task, delay)
  return () => clearTimeout(timer)
}

/**
 * Has the turn whose reply was announced as `assistantMessageId` produced
 * anything yet — content or an error?
 *
 * Matched by TURN, not by id alone. A reply legitimately arrives under two ids:
 * the announced `${userMessageId}_r` and the id the engine picks for itself.
 * The store collapses those into one message (`assistantTurnIndex` in
 * `opencode-conversation.ts`), and the survivor carries whichever id arrived
 * FIRST — so on a turn where the engine's envelope won the race, looking up the
 * announced id alone finds nothing.
 *
 * That is not cosmetic: this predicate gates the accepted-turn reconciliation.
 * A miss leaves the composer pinned on "Stop"/"Thinking" forever with the reply
 * sitting in the store, which is exactly how claude-sdk's turn 2 presented.
 *
 * The parent match keys on `parentID`, which is the same fact the announced id
 * encodes (`${userMessageId}_r` is derived from it), so this recognises the
 * merged message without widening to "any assistant message in the session".
 *
 * The parent-matched path additionally requires the message to have FINISHED
 * the turn — errored, or carrying a `finish` other than "tool-calls". The
 * exact-id path needs no guard (the announced envelope only ever holds the
 * turn's reply), but a parent-matched sibling can be a mid-turn STEP: a
 * multi-step tool turn emits an assistant message per step, each parented to
 * the same user message, each acquiring parts AND a completed time when its
 * step ends — so neither parts nor `time.completed` distinguishes a step from
 * the reply (a completed-time guard was tried and failed for exactly that
 * reason). The engine's own vocabulary does: a step that ended in tool calls
 * gets `finish = "tool-calls"` while the turn's true end gets "stop"/etc —
 * the same rule the engine itself uses to decide whether a turn is resumable
 * (prompt.ts's `!["tool-calls"].includes(lastAssistant.finish)`). Without
 * this guard the predicate answered "yes" on step one, and its caller — the
 * accepted-prompt refresh below — accepted a terminal status for a running
 * turn, derailing every multi-round tool flow (found as the
 * workgraph-real lane failing while single-step lanes stayed green).
 */
export function conversationHasAssistantMessage(sessionID: string, assistantMessageId: string | undefined) {
  if (!assistantMessageId) return false
  const conversation = registeredConversationSnapshot(sessionID)
  const userMessageId = assistantMessageId.endsWith("_r") ? assistantMessageId.slice(0, -2) : undefined
  const turnFinished = (item: (typeof conversation.messages)[number]) => {
    if ("error" in item && item.error) return true
    const finish = (item as { finish?: unknown }).finish
    return typeof finish === "string" && finish !== "tool-calls"
  }
  const message = conversation.messages.find(
    (item) =>
      item.role === "assistant" &&
      (item.id === assistantMessageId ||
        (!!userMessageId && item.parentID === userMessageId && turnFinished(item))),
  )
  if (!message) return false
  return "error" in message && !!message.error || (conversation.parts[message.id]?.length ?? 0) > 0
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
const HYDRATE_FRESH_MS = 15_000
export const ACTIVE_SESSION_STATUS_POLL_DELAY_MS = 60_000
export const ACTIVE_SESSION_STATUS_POLL_INTERVAL_MS = 5_000
const ACCEPTED_PROMPT_REFRESH_ATTEMPT_DELAYS_MS = [0, 600, 1_200, 2_400, 4_000, 8_000, 12_000] as const
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

export async function fetchTransportSession<TSession, TMessages>(input: {
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
  sessionRef?: Accessor<SessionRef | undefined>
}) {
  const sdk = useSDK()
  const globalSDK = useGlobalSDK()
  const sessionInventoryActions = useSessionInventoryActions()
  const directorySessionCacheActions = useDirectorySessionCacheActions()
  const { meta: historyMeta, setValue: setHistoryMetaValue } = createHistoryMetaState()
  const [missingSessions, setMissingSessions] = createSignal<Record<string, boolean | undefined>>({})
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
    return settledData(todoQuery) ?? []
  })

  const diffs = createMemo(() => {
    const sessionID = input.sessionID()
    if (!sessionID || sessionID === "new") return []
    return list(settledData(diffQuery))
  })
  const diffsReady = createMemo(() => {
    const sessionID = input.sessionID()
    if (!sessionID || sessionID === "new") return true
    return settledData(diffQuery) !== undefined
  })

  // status/request are LIVE mirrors: on the draft->session handoff their
  // fresh observers sit in "pending" for the first fetch while the turn is
  // already busy, so a settled-only read reports idle exactly when the stop
  // control must show. Plain .data is safe here — the vendored solid-query
  // patch removed client-side query suspension globally, which is what the
  // settled gate existed to avoid.
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
    return settledData(capabilitiesQuery) ?? PENDING_SCOPED_TRANSPORT_CAPABILITIES
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
    return historyHasMore(historyMeta(), sessionHistoryKey({ sessionID, directory: input.directory() }))
  })

  const historyLoading = createMemo(() => {
    const sessionID = input.sessionID()
    if (!sessionID || sessionID === "new") return false
    return historyIsLoading(historyMeta(), sessionHistoryKey({ sessionID, directory: input.directory() }))
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

  const syncSessionHistory = async (
    sessionID: string,
    opts?: { force?: boolean; before?: string; mode?: "replace" | "prepend"; bypassQuiet?: boolean; silent?: boolean },
  ) => {
    if (suppressedByFastSessionSwitch(sessionID)) return false
    if (shouldSkipSessionTransportHydrate({ sessionID, ...opts })) return false
    const directory = input.directory()
    const signedControlPlane = input.signedControlPlane?.() ?? false
    const workspaceId = signedControlPlane ? input.workspaceId?.() : undefined
    const workspaceKind = input.signedControlPlane?.() ? input.workspaceKind?.() : undefined
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
    const limit = opts?.before ? 200 : 80
    const shouldFetchSession = !opts?.before &&
      (!hasSession || opts?.force === true || !cachedSession?.title || cachedSession.title === "New Session")
    const transportRequest = () => fetchTransportSession({
      shouldFetchSession,
      fetchSession: () => fetchSessionByTransport({
        client: sdk.client.session,
        directory,
        sessionID,
        claxedoServerUrl: globalSDK.url,
        signedControlPlane,
        workspaceId,
        workspaceKind,
        sessionRef: input.sessionRef?.(),
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
        workspaceReachable,
        sessionRef: input.sessionRef?.(),
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
          queryFn: transportRequest, gcTime: 0,
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
        if (!opts?.silent) globalSDK.event.setLiveSession(sessionID, { directory, workspaceId, host: input.sessionRef?.()?.host })
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
        const sessionNotFound = isSessionNotFoundError(error)
        if (!sessionNotFound) {
          const failedCursor = backfillFailedCursor({ before: opts?.before, sessionNotFound })
          if (failedCursor !== undefined) {
            setHistoryMetaValue("failedCursor", key, failedCursor)
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
            const [synced, fetchedStatus] = await Promise.all([
              syncSessionHistory(request.sessionID, { force: true, silent: true }), readAcceptedPromptStatus({ sessionID: request.sessionID, client: sdk.client }),
            ])
            if (cancelled) return
            const settled = synced && fetchedStatus?.type === "idle" && conversationHasAssistantMessage(request.sessionID, assistantMessageIdForUserMessage(request.messageID))
            if (fetchedStatus && (fetchedStatus.type !== "idle" || settled)) dispatchSessionStatusEvent({
              event: { type: "session.status", source: "server", sessionID: request.sessionID, status: fetchedStatus },
            })
            if (settled) return true
          }
        })().catch(() => undefined)
        onCleanup(() => { cancelled = true })
      },
    ),
  )

  const syncSessionTodo = async (sessionID: string, opts?: { force?: boolean }) => {
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
        sessionRef: input.sessionRef?.(),
      })).data ?? [],
    }).then((todo) => {
      if (!shouldAcceptSessionTransportResult({ expectedSessionID: sessionID, currentSessionID: input.sessionID() })) return false
      dispatchSessionTodoEvent({ event: { type: "session.todo", source: "server", sessionID, todos: todo } })
      return true
    })
  }

  const syncSessionCapabilities = async (sessionID: string, opts?: { force?: boolean }) => {
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
        sessionRef: input.sessionRef?.(),
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
          markLiveSession(globalSDK.event, id, directory, signedControlPlane ? input.workspaceId?.() : undefined, input.sessionRef?.()?.host)
          // Hydration is the moment this session's shell caches come alive, so
          // it is what triggers the ceiling — but the pass itself runs once the
          // renderer is idle, never in front of the pane the user just opened.
          scheduleSessionCacheCeiling(id)
          void syncSessionCapabilities(id)
          void syncSessionHistory(id, { bypassQuiet: true }).then((synced) =>
            sessionHydrationDebug("sync-session-complete", { directory, sessionID: id, synced }))
          void syncSessionTodo(id)
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
          void syncSessionHistory(sessionID, { force: true })
          void syncSessionTodo(sessionID, { force: true })
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
      await syncSessionHistory(sessionID, { before, mode: "prepend" })
    },
  }
}
