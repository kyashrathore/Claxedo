import { isAbortError } from "@/lib/abort-error"
import type { Event as OpenCodeEvent, Project } from "@opencode-ai/sdk/v2/client"
import {
  createOpencodeCompatProjection,
  runtimeOwnsOpencodeCompatProjection,
  type CompatEvent,
  type OpencodeCompatProjection,
} from "@claxedo/agent-event-runtime/opencode-compat"
import { AGENT_RUNTIME_EVENT_CONTRACT_VERSION, type AgentRuntimeEvent } from "@claxedo/agent-event-runtime/contracts"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { onCleanup, onSettled } from "solid-js"
import { createSdkForServer } from "@/app/connection/server-client"
import { useLanguage } from "@/platform/i18n/provider"
import { usePlatform } from "@/platform/runtime/platform-provider"
import { centralTransportForServer, createTransport } from "@/platform/runtime/transport"
import { useServer } from "@/app/connection/server"
import { authFetch } from "@/platform/api/api"
import { principalHasSignedAccess, usePrincipal } from "@/platform/auth/identity-provider"
import { sameWorkspaceDirectory, signedWorkspaceFromProjects } from "@/platform/runtime/agent/signed-workspace"
import { shellRouteDirectoryFromPathname } from "@/platform/identity/route"
import { isUserHostedWorkspaceDirectory } from "@/platform/identity/legacy-resolver"
import { sessionWorkspaceRuntimeRef } from "@/platform/runtime/session-workspace"
import { fastSessionSwitchAnyNetworkQuiet, fastSessionSwitchAnyQuietDelay } from "@/platform/runtime/session-switch"
import { queryClient } from "@/platform/query/query-client"
import { queryKeys } from "@/platform/query/keys"
import { workspaceResolveUrl } from "@/platform/runtime/agent/workspace-control-routes"
import { createControlPlaneEventFetch, workspaceEventTransport, type LiveSession } from "../global-sdk-event-fetch"
import { createGlobalSdkFetch } from "@/platform/sync/global-sdk-fetch"
import { createEventCoalescer } from "@/platform/sync/global-sdk/event-coalescer"
import { createHeartbeatWatchdog } from "@/platform/sync/global-sdk/heartbeat-watchdog"
import { RECONNECT_DELAY_MS, reconnectBackoffMs } from "@/platform/sync/global-sdk/reconnect-backoff"
import { createSubagentRegistry, type SubagentRegistry } from "@/features/session/subagents/subagent-registry"
import {
  abortSubagentsForParent,
  applySubagentCompatLifecycleEvent,
  applySubagentRuntimeEventEnvelope,
} from "@/features/session/subagents/subagent-ingress"
import {
  eventDirectoryForLiveSession,
  globalSdkClientPlacement,
  globalSdkClientWorkspaceId,
  liveSessionTransition,
  liveSessionWithRelayBacking,
  runtimeEventLiveSession,
  USER_HOSTED_WORKSPACE_KIND,
  type GlobalSdkClientOptions,
} from "./live-session"
export {
  abortSubagentsForParent,
  applySubagentCompatLifecycleEvent,
  applySubagentRuntimeEventEnvelope,
} from "@/features/session/subagents/subagent-ingress"
export {
  eventDirectoryForLiveSession,
  globalSdkClientPlacement,
  globalSdkClientWorkspaceId,
  liveSessionTransition,
  liveSessionWithRelayBacking,
  nextLiveSession,
  runtimeEventLiveSession,
} from "./live-session"
export { createControlPlaneEventFetch, createGlobalSdkFetch, workspaceEventTransport }
export type GlobalSdkEvent = OpenCodeEvent | CompatEvent
type Event = GlobalSdkEvent
type EventDirectory = string
const claxedoExtensionEventTypes = new Set<string>([
  "message.completed",
  "session.agent",
  "session.config",
  "session.usage",
  "runtime.diagnostic",
])
export function isOpenCodeSdkEvent(event: GlobalSdkEvent): event is OpenCodeEvent {
  return !claxedoExtensionEventTypes.has(event.type)
}

function runtimeWorkspaceKind(input: unknown) {
  if (input === "local" || input === "cloud" || input === USER_HOSTED_WORKSPACE_KIND) return input
}
function initialRouteDirectory() {
  if (typeof window === "undefined") return
  return shellRouteDirectoryFromPathname(window.location.pathname)
}

function cachedProjectInventory(baseUrl?: string) {
  return baseUrl ? (queryClient.getQueryData<Project[]>(queryKeys.controlPlane.projects(baseUrl)) ?? []) : []
}
function initialRouteWorkspace(baseUrl?: string) {
  const directory = initialRouteDirectory()
  if (!directory) return
  for (const project of cachedProjectInventory(baseUrl) as Array<
    Project & {
      workspaces?: Record<string, { id?: string; workspaceId?: string; kind?: string; directory?: Project["worktree"] }>
    }
  >) {
    const match = Object.entries(project.workspaces ?? {}).find(
      ([key, workspace]) =>
        (sameWorkspaceDirectory(key, directory) || sameWorkspaceDirectory(workspace.directory, directory)) &&
        (workspace.kind === "cloud" || workspace.kind === USER_HOSTED_WORKSPACE_KIND),
    )
    if (!match) continue
    const [key, workspace] = match
    return {
      directory,
      workspaceId: workspace.workspaceId ?? workspace.id ?? key,
      workspaceKind: workspace.kind,
    }
  }
  return undefined
}

function shouldUseSignedEventAccess(input: {
  hasSignedAccess: boolean
  serverUrl?: string
  liveSession?: LiveSession
}) {
  if (!input.hasSignedAccess) return false
  if (initialRouteWorkspace(input.serverUrl)) return true
  if (centralTransportForServer(input.serverUrl) !== "loopback") return true
  const directory = input.liveSession?.directory ?? initialRouteDirectory()
  if (!directory && input.liveSession?.workspaceId) return true
  if (!directory) return true
  return !!(directory && sessionWorkspaceRuntimeRef({ directory })) || isUserHostedWorkspaceDirectory(directory)
}

export type RuntimeEventEnvelope = {
  contractVersion: typeof AGENT_RUNTIME_EVENT_CONTRACT_VERSION
  directory: EventDirectory
  sessionId: string
  agentSessionId?: string
  assistantMessageId?: string
  payload: AgentRuntimeEvent
}

type RuntimeProjectionCache = Map<string, OpencodeCompatProjection>
type RuntimeCoveredSessions = Set<string>

function record(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : undefined
}

export function compatEventEnvelope(input: unknown): { directory?: string; payload: Event } | undefined {
  const row = record(input)
  if (!row || row.type === "heartbeat") return
  const payload = record(row.payload) ?? row
  if (typeof payload.type !== "string" || payload.type === "server.heartbeat") return
  return {
    ...(typeof row.directory === "string" ? { directory: row.directory } : {}),
    payload: payload as Event,
  }
}

export function runtimeEnvelope(input: unknown): RuntimeEventEnvelope | undefined {
  const row = record(input)
  const payload = record(row?.payload)
  if (row?.contractVersion !== AGENT_RUNTIME_EVENT_CONTRACT_VERSION) return
  if (typeof row?.directory !== "string") return
  if (typeof row.sessionId !== "string") return
  if (typeof payload?.type !== "string") return
  return {
    contractVersion: AGENT_RUNTIME_EVENT_CONTRACT_VERSION,
    directory: row.directory,
    sessionId: row.sessionId,
    ...(typeof row.agentSessionId === "string" ? { agentSessionId: row.agentSessionId } : {}),
    ...(typeof row.assistantMessageId === "string" ? { assistantMessageId: row.assistantMessageId } : {}),
    payload: payload as AgentRuntimeEvent,
  }
}

export function projectRuntimeEventEnvelope(
  input: RuntimeEventEnvelope,
  projections: RuntimeProjectionCache = new Map(),
): Array<{ directory: EventDirectory; payload: Event }> {
  const assistantMessageId = input.assistantMessageId ?? `${input.sessionId}_r`
  const key = `${input.sessionId}:${assistantMessageId}`
  const projection =
    projections.get(key) ??
    createOpencodeCompatProjection({
      sessionId: input.sessionId,
      directory: input.directory,
      assistantMessageId,
    })
  projections.set(key, projection)
  return projection.ingest(input.payload).map((event) => ({
    directory: input.directory,
    payload: event.payload as Event,
  }))
}

function eventSessionId(payload: Event): string | undefined {
  const properties = record((payload as { properties?: unknown }).properties)
  if (typeof properties?.sessionID === "string") return properties.sessionID
  if (typeof properties?.sessionId === "string") return properties.sessionId
  const part = record(properties?.part)
  if (typeof part?.sessionID === "string") return part.sessionID
  const info = record(properties?.info)
  if (typeof info?.sessionID === "string") return info.sessionID
  return undefined
}

function runtimeSessionKey(sessionID: string) {
  return sessionID
}

export function rememberRuntimeEventEnvelope(input: RuntimeEventEnvelope, covered: RuntimeCoveredSessions) {
  covered.add(runtimeSessionKey(input.sessionId))
}

export function runtimeProjectionOwnsCompat(input: RuntimeEventEnvelope) {
  return runtimeOwnsOpencodeCompatProjection(input)
}

export function runtimeReplayGap(input: RuntimeEventEnvelope) {
  const payload = input.payload
  return payload.type === "harness-notice" && payload.code === "runtime.sse_replay_gap"
}

export function resetRuntimeReplayGapState(input: {
  envelope: RuntimeEventEnvelope
  projections?: RuntimeProjectionCache
  covered?: RuntimeCoveredSessions
  baseUrl?: string
  liveSession?: LiveSession
  subagents?: SubagentRegistry
}) {
  input.projections?.clear()
  input.covered?.clear()
  input.subagents?.replayGap()
  const directory = eventDirectoryForLiveSession({
    directory: input.envelope.directory,
    liveSession: input.liveSession,
  })
  return Promise.all([
    queryClient.invalidateQueries({
      queryKey: queryKeys.session.row(input.baseUrl, directory, input.envelope.sessionId),
    }),
    queryClient.invalidateQueries({
      queryKey: queryKeys.session.messages(input.baseUrl, directory, input.envelope.sessionId),
    }),
    queryClient.invalidateQueries({
      queryKey: queryKeys.session.todo(input.baseUrl, directory, input.envelope.sessionId),
    }),
    queryClient.invalidateQueries({
      queryKey: queryKeys.session.diff(input.baseUrl, directory, input.envelope.sessionId),
    }),
    queryClient.invalidateQueries({ queryKey: queryKeys.shell.sessionInventory(input.baseUrl) }),
  ]).then(() => {})
}

function mirroredByRuntimeProjection(payload: Event) {
  // Defensive: keepalive frames (`{"type":"heartbeat"}`) and other envelopes
  // carry no event payload, so callers can hand us `undefined` — never read
  // `.type` off it or the whole event loop throws and the bus dies.
  if (!payload || typeof payload !== "object") return false
  const type = payload.type as string
  return (
    type === "message.updated" ||
    type === "message.part.updated" ||
    type === "message.part.delta" ||
    type === "message.completed" ||
    type === "session.idle" ||
    type === "session.error" ||
    type === "session.status" ||
    type === "session.updated" ||
    type === "session.agent" ||
    type === "todo.updated" ||
    type === "permission.asked" ||
    type === "permission.replied" ||
    type === "question.asked" ||
    type === "question.replied" ||
    type === "question.rejected" ||
    type === "session.diff" ||
    type === "session.compacted"
  )
}

export function shouldAcceptCompatEvent(payload: Event, covered: RuntimeCoveredSessions) {
  if (!mirroredByRuntimeProjection(payload)) return true
  const sessionID = eventSessionId(payload)
  if (!sessionID) return true
  if (runtimeOwnsOpencodeCompatProjection({ sessionId: sessionID })) return false
  return !covered.has(runtimeSessionKey(sessionID))
}

export function partUpdateSupersedesDeltas(payload: Event) {
  if (payload.type !== "message.part.updated") return false
  const part = record((payload.properties as { part?: unknown }).part)
  return typeof part?.text === "string" && part.text.length > 0
}

async function* sseJsonStream(
  response: Response,
  signal: AbortSignal,
  onEventId?: (id: string) => void,
): AsyncGenerator<unknown> {
  if (!response.ok) throw new Error(`runtime event stream failed: ${response.status}`)
  if (!response.body) return
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ""
  try {
    while (!signal.aborted) {
      const next = await reader.read()
      if (next.done) break
      text += decoder.decode(next.value, { stream: true })
      const frames = text.split("\n\n")
      text = frames.pop() ?? ""
      for (const frame of frames) {
        const id = frame
          .split("\n")
          .find((line) => line.startsWith("id:"))
          ?.slice(3)
          .trimStart()
        if (id) onEventId?.(id)
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n")
        if (!data) continue
        yield JSON.parse(data)
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
}

const globalSDKContextInput = {
  name: "GlobalSDK",
  gate: true,
  init: () => {
    const language = useLanguage()
    const server = useServer()
    const platform = usePlatform()
    const principal = usePrincipal()
    const abort = new AbortController()

    let liveSession: LiveSession | undefined
    // Add relay identity when the live session only carries a legacy directory.
    // Without workspaceId/kind, hosted runtime events fall through to central
    // `/api/wr/runtime-events` and 404 instead of using the relay.
    const withRelayBacking = (session: LiveSession): LiveSession =>
      session.host === "central"
        ? session
        : liveSessionWithRelayBacking(session, cachedProjectInventory(server.current?.http.url))
    const eventLiveSession = () => {
      if (liveSession) return withRelayBacking(liveSession)
      const directory = initialRouteDirectory()
      const workspace = initialRouteWorkspace(server.current?.http.url)
      if (workspace) return { sessionID: "route", ...workspace }
      const ref = directory
        ? sessionWorkspaceRuntimeRef({ directory, projects: cachedProjectInventory(server.current?.http.url) })
        : undefined
      if (!ref) return
      return { sessionID: "route", directory, workspaceId: ref.workspaceId, workspaceKind: ref.kind }
    }
    const signedEventAccess = () =>
      shouldUseSignedEventAccess({
        // The surface type is not authority: local/mock browser lanes are web
        // too. The principal opens the signed boundary; shouldUseSignedEventAccess
        // then limits it to the active route/live workspace identity.
        hasSignedAccess: principalHasSignedAccess(principal()),
        serverUrl: server.current?.http.url,
        liveSession,
      })
    const rawEventFetch = (() => {
      if (!platform.fetch || !server.current) return
      if (centralTransportForServer(server.current.http.url) !== "loopback") return platform.fetch
    })()
    const eventFetch = createControlPlaneEventFetch({
      signedControlPlane: signedEventAccess,
      liveSession: eventLiveSession,
      setLiveSession: (next) => {
        liveSession = next
      },
      fetch:
        signedEventAccess() && centralTransportForServer(server.current?.http.url) !== "loopback"
          ? authFetch
          : (rawEventFetch ?? platform.fetch ?? globalThis.fetch),
    })

    const currentServer = server.current
    if (!currentServer) throw new Error(language.t("error.globalSDK.noServerAvailable"))

    const emitter = createGlobalEmitter<{
      [key: string]: Event
    }>()

    const FLUSH_FRAME_MS = 16
    const STREAM_YIELD_MS = 8
    let streamReady = false
    const readyResolvers = new Set<() => void>()

    const deltaKey = (directory: string, messageID: string, partID: string) => `${directory}:${messageID}:${partID}`

    const key = (directory: string, payload: Event) => {
      if (payload.type === "session.status") return `session.status:${payload.properties.sessionID}`
      if (payload.type === "lsp.updated") return `lsp.updated:${directory}`
      if (payload.type === "message.part.updated") {
        const part = payload.properties.part
        return `message.part.updated:${directory}:${part.messageID}:${part.id}`
      }
    }

    const coalescer = createEventCoalescer<Event>({
      emit: (directory, payload) => emitter.emit(directory, payload),
      frameMs: FLUSH_FRAME_MS,
      policy: {
        coalesceKey: key,
        supersededDelta: (directory, payload) => {
          if (!partUpdateSupersedesDeltas(payload)) return
          const part = record((payload.properties as { part?: unknown }).part)
          if (typeof part?.messageID === "string" && typeof part.id === "string") {
            return deltaKey(directory, part.messageID, part.id)
          }
        },
        deltaIdentity: (directory, payload) => {
          if (payload.type !== "message.part.delta") return
          const props = payload.properties
          return deltaKey(directory, props.messageID, props.partID)
        },
      },
    })
    const enqueue = coalescer.enqueue
    const flush = coalescer.flush

    let streamErrorLogged = false
    const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
    const aborted = isAbortError
    const transientStreamError = (error: unknown) =>
      error instanceof TypeError && error.message.toLowerCase() === "network error"
    const runtimeCoveredSessions: RuntimeCoveredSessions = new Set()
    const subagents = createSubagentRegistry()
    const markStreamReady = () => {
      if (streamReady) return
      streamReady = true
      for (const resolve of readyResolvers) resolve()
      readyResolvers.clear()
    }
    const markStreamPending = () => {
      streamReady = false
    }

    let attempt: AbortController | undefined
    let runtimeAttempt: AbortController | undefined
    let runtimeRun: Promise<void> | undefined
    let run: Promise<void> | undefined
    let started = false
    let lastGlobalEventId: string | undefined
    let lastRuntimeEventId: string | undefined
    let liveSessionRestartTimer: ReturnType<typeof setTimeout> | undefined
    const HEARTBEAT_TIMEOUT_MS = 15_000
    const heartbeat = createHeartbeatWatchdog({
      timeoutMs: HEARTBEAT_TIMEOUT_MS,
      onTimeout: () => {
        attempt?.abort()
        runtimeAttempt?.abort()
      },
    })
    const restartLiveSessionStreams = () => {
      if (fastSessionSwitchAnyQuietDelay() > 0) {
        scheduleLiveSessionRestart()
        return
      }
      if (liveSessionRestartTimer) clearTimeout(liveSessionRestartTimer)
      liveSessionRestartTimer = undefined
      lastGlobalEventId = undefined
      lastRuntimeEventId = undefined
      attempt?.abort()
      runtimeAttempt?.abort()
    }
    const scheduleLiveSessionRestart = () => {
      if (liveSessionRestartTimer) clearTimeout(liveSessionRestartTimer)
      const delay = fastSessionSwitchAnyQuietDelay()
      if (delay <= 0) {
        restartLiveSessionStreams()
        return
      }
      liveSessionRestartTimer = setTimeout(restartLiveSessionStreams, delay)
    }

    const startRuntimeEvents = () => {
      if (runtimeRun) return runtimeRun
      const projections: RuntimeProjectionCache = new Map()
      runtimeRun = (async () => {
        let failures = 0
        while (!abort.signal.aborted && started) {
          const quietDelay = fastSessionSwitchAnyQuietDelay()
          if (quietDelay > 0) {
            await wait(quietDelay)
            continue
          }
          runtimeAttempt = new AbortController()
          let becameReady = false
          const onAbort = () => {
            runtimeAttempt?.abort()
          }
          abort.signal.addEventListener("abort", onAbort)
          try {
            const request =
              centralTransportForServer(currentServer.http.url) === "loopback"
                ? (rawEventFetch ?? platform.fetch ?? globalThis.fetch)
                : authFetch
            const headers = new Headers({ Accept: "text/event-stream" })
            if (lastRuntimeEventId) headers.set("Last-Event-ID", lastRuntimeEventId)
            const init = {
              signal: runtimeAttempt.signal,
              headers,
            }
            const session = runtimeEventLiveSession(liveSession, cachedProjectInventory(currentServer.http.url))
            if (!session || (session.host !== "central" && !session.directory && !session.workspaceId)) {
              await wait(RECONNECT_DELAY_MS)
              continue
            }
            const runtimePath = new URL("/api/wr/runtime-events", "http://workspace-runtime.local")
            if (session.directory) runtimePath.searchParams.set("directory", session.directory)
            runtimePath.searchParams.set("parentSessionId", session.sessionID)
            const sessionWorkspaceKind = runtimeWorkspaceKind(session.workspaceKind)
            const response =
              session.host === "central"
                ? await request(
                    new URL(
                      `/api/control/session/${encodeURIComponent(session.sessionID)}/runtime-events?parentSessionId=${encodeURIComponent(session.sessionID)}`,
                      currentServer.http.url,
                    ),
                    init,
                  )
                : await createTransport({
                    placement: {
                      ...(session.workspaceId ? { workspaceId: session.workspaceId } : {}),
                      hosting: "workspace",
                      transport: workspaceEventTransport({
                        serverUrl: currentServer.http.url,
                        signedControlPlane: signedEventAccess(),
                        workspaceId: session.workspaceId,
                        workspaceKind: sessionWorkspaceKind,
                      }),
                    },
                    serverUrl: currentServer.http.url,
                    directory: session?.directory,
                    resolveWorkspaceRuntime: async ({ directory, workspaceId }) => {
                      if (fastSessionSwitchAnyNetworkQuiet() && directory && !workspaceId) return null
                      if (session.workspaceId && sessionWorkspaceKind)
                        return { workspaceId: session.workspaceId, kind: sessionWorkspaceKind }
                      const res = await request(
                        workspaceResolveUrl({ baseUrl: currentServer.http.url, scope: directory, workspaceId }),
                        {
                          headers: { Accept: "application/json" },
                        },
                      )
                      if (res.status === 404) return null
                      if (!res.ok) throw new Error((await res.text()) || `workspace resolve failed: ${res.status}`)
                      return await res.json()
                    },
                    request,
                    relayRequest: request,
                  }).fetch(`${runtimePath.pathname}${runtimePath.search}`, init)
            let yielded = Date.now()
            for await (const item of sseJsonStream(response, runtimeAttempt.signal, (id) => {
              lastRuntimeEventId = id
            })) {
              const envelope = runtimeEnvelope(item)
              if (!envelope) continue
              envelope.directory = eventDirectoryForLiveSession({
                directory: envelope.directory,
                liveSession: eventLiveSession(),
              })
              heartbeat.reset()
              markStreamReady()
              becameReady = true
              streamErrorLogged = false
              if (runtimeReplayGap(envelope)) {
                const session = eventLiveSession()
                if (session?.sessionID && session.sessionID !== "route") {
                  enqueue(envelope.directory, {
                    type: "runtime.diagnostic",
                    properties: {
                      sessionID: session.sessionID,
                      code: "runtime.sse_replay_gap",
                      message: "Runtime event replay cursor is no longer available; refetch session state.",
                      severity: "warn",
                    },
                  } as Event)
                }
                void resetRuntimeReplayGapState({
                  envelope,
                  projections,
                  covered: runtimeCoveredSessions,
                  baseUrl: currentServer.http.url,
                  liveSession: eventLiveSession(),
                  subagents,
                })
                lastRuntimeEventId = undefined
                runtimeAttempt.abort()
                break
              }
              applySubagentRuntimeEventEnvelope(envelope, subagents)
              if (!runtimeProjectionOwnsCompat(envelope)) continue
              rememberRuntimeEventEnvelope(envelope, runtimeCoveredSessions)
              for (const event of projectRuntimeEventEnvelope(envelope, projections)) {
                enqueue(event.directory, event.payload)
              }
              if (Date.now() - yielded < STREAM_YIELD_MS) continue
              yielded = Date.now()
              await wait(0)
            }
          } catch (error) {
            if (!aborted(error) && !transientStreamError(error) && !streamErrorLogged) {
              // The first few consecutive non-transient failures are still the
              // host tunnel settling (relay→runtime 502s while the host comes
              // up); they self-heal via backoff, so keep them on a quiet
              // `console.debug` path and only escalate to `console.error` once
              // the failure run is SUSTAINED. `failures` is the count of PRIOR
              // consecutive failures (incremented after this catch), so it is 0
              // on the first failure. The `streamErrorLogged` latch is only set
              // once we actually escalate, so the quiet path keeps re-evaluating
              // until the threshold is crossed (then logs exactly once per run).
              const detail = { url: currentServer.http.url, error }
              if (failures >= 3) {
                streamErrorLogged = true
                console.error("[global-sdk] runtime event stream failed", detail)
              } else {
                console.debug("[global-sdk] runtime event stream failed (transient, retrying)", detail)
              }
            }
          } finally {
            abort.signal.removeEventListener("abort", onAbort)
            runtimeAttempt = undefined
          }

          if (abort.signal.aborted || !started) return
          failures = becameReady ? 0 : failures + 1
          await wait(reconnectBackoffMs(failures))
        }
      })().finally(() => {
        runtimeRun = undefined
        flush()
      })
      return runtimeRun
    }

    const start = () => {
      if (started) return run
      started = true
      run = (async () => {
        void startRuntimeEvents()
        let failures = 0
        // oxlint-disable-next-line no-unmodified-loop-condition -- `started` is set to false by stop() which also aborts; both flags are checked to allow graceful exit
        while (!abort.signal.aborted && started) {
          const quietDelay = fastSessionSwitchAnyQuietDelay()
          if (quietDelay > 0) {
            await wait(quietDelay)
            continue
          }
          attempt = new AbortController()
          markStreamPending()
          heartbeat.touch()
          let becameReady = false
          const onAbort = () => {
            attempt?.abort()
          }
          abort.signal.addEventListener("abort", onAbort)
          try {
            const headers = new Headers({ Accept: "text/event-stream" })
            if (lastGlobalEventId) headers.set("Last-Event-ID", lastGlobalEventId)
            const response = await eventFetch(new URL("/global/event", currentServer.http.url), {
              signal: attempt.signal,
              headers,
            })
            let yielded = Date.now()
            heartbeat.reset()
            for await (const item of sseJsonStream(response, attempt.signal, (id) => {
              lastGlobalEventId = id
            })) {
              heartbeat.reset()
              markStreamReady()
              becameReady = true
              streamErrorLogged = false
              const event = compatEventEnvelope(item)
              if (!event) continue
              const directory = eventDirectoryForLiveSession({
                directory: event.directory ?? "global",
                liveSession: eventLiveSession(),
              })
              applySubagentCompatLifecycleEvent(event.payload, subagents)
              if (!shouldAcceptCompatEvent(event.payload, runtimeCoveredSessions)) continue
              enqueue(directory, event.payload)

              if (Date.now() - yielded < STREAM_YIELD_MS) continue
              yielded = Date.now()
              await wait(0)
            }
          } catch (error) {
            if (!aborted(error) && !transientStreamError(error) && !streamErrorLogged) {
              streamErrorLogged = true
              console.error(
                "[global-sdk] event stream failed",
                JSON.stringify({
                  url: currentServer.http.url,
                  fetch: rawEventFetch ? "platform" : "webview",
                  error:
                    error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : error,
                }),
              )
            }
          } finally {
            abort.signal.removeEventListener("abort", onAbort)
            attempt = undefined
            heartbeat.clear()
          }

          if (abort.signal.aborted || !started) return
          // Reset backoff once the stream actually delivered data; otherwise grow
          // it so a persistent 401/network failure stops hammering the server.
          failures = becameReady ? 0 : failures + 1
          await wait(reconnectBackoffMs(failures))
        }
      })().finally(() => {
        run = undefined
        flush()
      })
      return run
    }

    const stop = () => {
      started = false
      attempt?.abort()
      runtimeAttempt?.abort()
      heartbeat.clear()
      markStreamPending()
      for (const resolve of readyResolvers) resolve()
      readyResolvers.clear()
    }

    const ready = async (timeoutMs = 8_000) => {
      start()
      if (streamReady) return
      let resolveReady: (() => void) | undefined
      await Promise.race([
        new Promise<void>((resolve) => {
          resolveReady = resolve
          readyResolvers.add(resolve)
        }),
        wait(timeoutMs),
      ])
      if (resolveReady) readyResolvers.delete(resolveReady)
    }

    onSettled(() => {
      queueMicrotask(() => {
        void start()
      })
      const handler = () => {
        if (document.visibilityState !== "visible") return
        if (!started) return
        if (heartbeat.sinceLastEvent() < HEARTBEAT_TIMEOUT_MS) return
        attempt?.abort()
      }
      document.addEventListener("visibilitychange", handler)
      return () => document.removeEventListener("visibilitychange", handler)
    })

    onCleanup(() => {
      if (liveSessionRestartTimer) clearTimeout(liveSessionRestartTimer)
      stop()
      abort.abort()
      flush()
    })

    const guardedSdkFetch = createGlobalSdkFetch({
      serverUrl: currentServer.http.url,
      resolveSignedWorkspace: (directory) => {
        const projects = cachedProjectInventory(currentServer.http.url)
        return (
          signedWorkspaceFromProjects(projects, directory) ??
          signedWorkspaceFromProjects(projects, sessionWorkspaceRuntimeRef({ directory, projects })?.workspaceId)
        )
      },
      request: platform.fetch ?? authFetch,
    })
    const guardedGlobalFetch: typeof fetch = async (requestInput, init) => {
      const url = new URL(
        requestInput instanceof Request ? requestInput.url : String(requestInput),
        currentServer.http.url,
      )
      if (url.pathname === "/global/event" || url.pathname === "/event") {
        return eventFetch(requestInput, init)
      }
      return guardedSdkFetch(requestInput, init)
    }

    const sdk = createSdkForServer({
      server: server.current.http,
      fetch: guardedGlobalFetch,
      throwOnError: true,
    })

    const setLiveSession = (
      sessionID: string,
      opts?: { host?: "central" | "workspace"; directory?: string; workspaceId?: string; workspaceKind?: string },
    ) => {
      const transition = liveSessionTransition(liveSession, sessionID, opts)
      liveSession = transition.next
      if (transition.workspaceScopeChanged) subagents.workspaceChanged()
      if (transition.runtimeStreamChanged && started) {
        scheduleLiveSessionRestart()
      }
    }

    return {
      url: currentServer.http.url,
      client: sdk,
      event: {
        on: emitter.on.bind(emitter),
        listen: emitter.listen.bind(emitter),
        start,
        ready,
        setLiveSession,
        getLiveSession: () => liveSession,
        subagents: {
          registry: subagents,
          abortParent: (sessionID: string) => abortSubagentsForParent(sessionID, subagents),
        },
      },
      createClient(opts: GlobalSdkClientOptions) {
        const s = server.current
        if (!s) throw new Error(language.t("error.globalSDK.serverNotAvailable"))
        const { workspaceId: explicitWorkspaceId, ...clientOptions } = opts
        const workspaceId = globalSdkClientWorkspaceId(cachedProjectInventory(s.http.url), {
          directory: clientOptions.directory,
          workspaceId: explicitWorkspaceId,
        })
        const placement = globalSdkClientPlacement(workspaceId)
        const request = platform.fetch ?? authFetch
        return createSdkForServer({
          server: s.http,
          fetch: placement
            ? createTransport({
                placement,
                serverUrl: s.http.url,
                directory: clientOptions.directory,
                request,
                relayRequest: request,
              }).sdkFetch
            : platform.fetch,
          ...clientOptions,
        })
      },
    }
  },
}
export const { use: useGlobalSDK, provider: GlobalSDKProvider } = createSimpleContext<
  ReturnType<typeof globalSDKContextInput.init>,
  Record<string, any>
>(globalSDKContextInput)
