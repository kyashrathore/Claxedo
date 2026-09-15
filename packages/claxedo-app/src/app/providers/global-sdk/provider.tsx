import { useClaxedoEvents } from "@/app/integrations/claxedo-events"
import { isAbortError } from "@/lib/abort-error"
import { reportRuntimeContractMismatch, runtimeEnvelope, type RuntimeEventEnvelope } from "./runtime-envelope"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { batch, createEffect, on, onCleanup, onMount } from "solid-js"
import { createServerClient } from "@/app/connection/server-client"
import { useLanguage } from "@/platform/i18n/provider"
import { usePlatform } from "@/platform/runtime/platform-provider"
import { centralTransportForServer, createTransport } from "@/platform/runtime/transport"
import { useServer } from "@/app/connection/server"
import { authFetch } from "@/platform/api/api"
import { principalHasSignedAccess, usePrincipal } from "@/platform/auth/identity-provider"
import { sessionWorkspaceRuntimeRef } from "@/platform/runtime/session-workspace"
import { fastSessionSwitchAnyNetworkQuiet, fastSessionSwitchAnyQuietDelay } from "@/platform/runtime/session-switch"
import {
  registerSessionEventStreamLane,
  reportSessionEventStreamClosed,
  reportSessionEventStreamOpen,
  sessionEventScopeId,
  whenSessionEventStreamsOpen,
} from "@/platform/runtime/session-event-scope"
import { workspaceResolveUrl } from "@/platform/runtime/agent/workspace-control-routes"
import { openWorkspaceRuntimeEventResponse, workspaceEventTransport, type LiveSession } from "../global-sdk-event-fetch"
import { createEventCoalescer } from "@/platform/sync/global-sdk/event-coalescer"
import { createHeartbeatWatchdog } from "@/platform/sync/global-sdk/heartbeat-watchdog"
import { RECONNECT_DELAY_MS, reconnectBackoffMs } from "@/platform/sync/global-sdk/reconnect-backoff"
import { createSubagentRegistry } from "@/features/session/subagents/subagent-registry"
import { abortSubagentsForParent, applySubagentCompatLifecycleEvent, applySubagentRuntimeEventEnvelope } from "@/features/session/subagents/subagent-ingress"
import type { SessionRef } from "@/platform/identity/session-ref"
import { applyLiveSessionGoalEvent, liveSessionGoalScope } from "./goal-events"
import {
  eventDirectoryForLiveSession,
  globalSdkClientPlacement,
  globalSdkClientWorkspaceId,
  liveSessionTransition,
  liveSessionWithRelayBacking,
  runtimeEventLiveSession,
  type GlobalSdkClientOptions,
} from "./live-session"
import {
  cachedProjectInventory,
  initialRouteDirectory,
  initialRouteWorkspace,
  shouldUseSignedEventAccess,
} from "./route-event-scope"
import { EVENT_STREAM_STALL_MS } from "@claxedo/agent-event-runtime"
import { workspaceKind } from "@/platform/runtime/agent/workspace-kind"
export { abortSubagentsForParent, applySubagentCompatLifecycleEvent, applySubagentRuntimeEventEnvelope } from "@/features/session/subagents/subagent-ingress"
export { eventDirectoryForLiveSession, globalSdkClientPlacement, globalSdkClientWorkspaceId, liveSessionTransition, liveSessionWithRelayBacking, nextLiveSession, runtimeEventLiveSession } from "./live-session"
export { workspaceEventTransport }
export { runtimeEnvelope, type RuntimeEventEnvelope } from "./runtime-envelope"
import {
  compatEventEnvelope,
  partUpdateSupersedesDeltas,
  projectRuntimeDiagnosticEnvelope,
  resetRuntimeReplayGapState,
  runtimeReplayGap,
  type GlobalSdkEvent,
} from "./runtime-event-projection"
export {
  compatEventEnvelope,
  partUpdateSupersedesDeltas,
  projectRuntimeDiagnosticEnvelope,
  resetRuntimeReplayGapState,
  runtimeReplayGap,
  type GlobalSdkEvent,
} from "./runtime-event-projection"
type Event = GlobalSdkEvent

export async function* sseJsonStream(response: Response, signal: AbortSignal, onEventId?: (id: string) => void): AsyncGenerator {
  if (!response.ok) throw new Error(`runtime event stream failed: ${response.status}`)
  if (!response.body) return
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ""
  try {
    while (!signal.aborted) {
      const next = await reader.read()
      if (next.done || signal.aborted) break
      text += decoder.decode(next.value, { stream: true })
      const frames = text.split("\n\n")
      text = frames.pop() ?? ""
      for (const frame of frames) {
        if (signal.aborted) return
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
  name: "GlobalSDK", gate: true,
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
      liveSessionWithRelayBacking(session, cachedProjectInventory(server.current?.http.url))
    const eventLiveSession = () => {
      if (liveSession) return withRelayBacking(liveSession)
      const directory = initialRouteDirectory()
      const workspace = initialRouteWorkspace(server.current?.http.url)
      if (workspace) return { sessionID: "route", ...workspace }
      const ref = directory
        ? sessionWorkspaceRuntimeRef({ directory, projects: cachedProjectInventory(server.current?.http.url) })
        : undefined
      if (!ref) return undefined
      return { sessionID: "route", directory, workspaceId: ref.workspaceId, workspaceKind: ref.kind }
    }
    const signedEventAccess = () => shouldUseSignedEventAccess({
      // The surface type is not authority: local/mock browser lanes are web
      // too. The principal opens the signed boundary; shouldUseSignedEventAccess
      // then limits it to the active route/live workspace identity.
      hasSignedAccess: principalHasSignedAccess(principal()),
      serverUrl: server.current?.http.url,
      liveSession,
    })
    const rawEventFetch = (() => {
      if (!platform.fetch || !server.current) return undefined
      if (centralTransportForServer(server.current.http.url) !== "loopback") return platform.fetch
      return undefined
    })()

    const currentServer = server.current
    if (!currentServer) throw new Error(language.t("error.globalSDK.noServerAvailable"))

    const emitter = createGlobalEmitter<{
      [key: string]: Event
    }>()

    const FLUSH_FRAME_MS = 16
    const STREAM_YIELD_MS = 8

    const deltaKey = (directory: string, messageID: string, partID: string) => `${directory}:${messageID}:${partID}`

    const key = (directory: string, payload: Event) => {
      if (payload.type === "session.status") return `session.status:${payload.properties.sessionID}`
      if (payload.type === "message.part.updated") {
        const part = payload.properties.part
        return `message.part.updated:${directory}:${part.messageID}:${part.id}`
      }
      return undefined
    }

    const coalescer = createEventCoalescer<Event>({
      emit: (directory, payload) => emitter.emit(directory, payload),
      batch,
      frameMs: FLUSH_FRAME_MS,
      policy: {
        coalesceKey: key,
        supersededDelta: (directory, payload) => {
          if (!partUpdateSupersedesDeltas(payload)) return undefined
          const part = payload.properties.part
          return deltaKey(directory, part.messageID, part.id)
        },
        deltaIdentity: (directory, payload) => {
          if (payload.type !== "message.part.delta") return undefined
          const props = payload.properties
          return deltaKey(directory, props.messageID, props.partID)
        },
      },
    })
    const enqueue = coalescer.enqueue
    const flush = coalescer.flush

    let streamErrorLogged = false
    let reportedContractVersion: unknown
    const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
    const aborted = isAbortError
    const transientStreamError = (error: unknown) =>
      error instanceof TypeError && error.message.toLowerCase() === "network error"
    const subagents = createSubagentRegistry()

    let runtimeAttempt: AbortController | undefined
    let runtimeRun: Promise<void> | undefined
    let started = false
    // Both halves are load-bearing for every stream loop below: `stop()`
    // clears `started` without aborting `abort` (a later `start()` reuses the
    // same scope), and scope teardown aborts without going through `stop()`.
    const streaming = () => started && !abort.signal.aborted
    let lastRuntimeEventId: string | undefined
    let liveSessionRestartTimer: ReturnType<typeof setTimeout> | undefined
    // The stall budget is the producers' heartbeat contract, not a local guess:
    // a quiet-but-healthy stream must outlive the watchdog on every transport.
    const HEARTBEAT_TIMEOUT_MS = EVENT_STREAM_STALL_MS
    const heartbeat = createHeartbeatWatchdog({
      timeoutMs: HEARTBEAT_TIMEOUT_MS,
      onTimeout: () => {
        runtimeAttempt?.abort()
      },
    })
    // A retarget is a change of SESSION, so only the session-scoped lane has a
    // cursor that no longer means anything: `/api/wr/runtime-events` is opened
    // per `parentSessionId` and its ids belong to that session's log. The
    // workspace-wide compat lane carries every session on the server, so its
    // cursor stays valid across a switch — dropping it makes the next connection
    // cursor-less, which the two producers answer in opposite, equally wrong
    // ways: a server that replays its whole retained log re-delivers frames the
    // app already applied, and a workspace runtime that serves a cursor-less
    // connection nothing at all silently loses everything published in the gap.
    const restartLiveSessionStreams = () => {
      if (fastSessionSwitchAnyQuietDelay() > 0) {
        scheduleLiveSessionRestart()
        return
      }
      if (liveSessionRestartTimer) clearTimeout(liveSessionRestartTimer)
      liveSessionRestartTimer = undefined
      lastRuntimeEventId = undefined
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

    // The scope owner is the authority on which session the runtime-events lane
    // carries, and it changes on navigation — including a navigation to a
    // session this client never created. Retarget the open stream from the scope
    // itself, so an ATTACH opens the same lane a create does instead of waiting
    // for a history fetch to mark a live session.
    createEffect(on(sessionEventScopeId, () => {
      if (started) scheduleLiveSessionRestart()
    }, { defer: true }))

    const startRuntimeEvents = () => {
      if (runtimeRun) return runtimeRun
      // The runtime-events stream is one of the two lanes that carry a
      // session's live frames, and it is always scoped to one parent session.
      // The scope owner needs to know it exists so a caller can wait for THIS
      // session's stream instead of for "some stream, once".
      const releaseLane = registerSessionEventStreamLane("runtime-events")
      runtimeRun = (async () => {
        let failures = 0
        while (streaming()) {
          const quietDelay = fastSessionSwitchAnyQuietDelay()
          if (quietDelay > 0) {
            await wait(quietDelay)
            continue
          }
          runtimeAttempt = new AbortController()
          heartbeat.touch()
          let becameReady = false
          const onAbort = () => {
            runtimeAttempt?.abort()
          }
          abort.signal.addEventListener("abort", onAbort)
          try {
            const request = centralTransportForServer(currentServer.http.url) === "loopback"
              ? rawEventFetch ?? platform.fetch ?? globalThis.fetch
              : authFetch
            const headers = new Headers({ Accept: "text/event-stream" })
            if (lastRuntimeEventId) headers.set("Last-Event-ID", lastRuntimeEventId)
            const init = {
              signal: runtimeAttempt.signal,
              headers,
            }
            // `session-event-scope` — not this provider's own live session —
            // owns WHICH session's frames must be streaming. `eventLiveSession()`
            // supplies the workspace identity to route with, including for a
            // session reached purely by navigation, where no history fetch has
            // marked a live session yet.
            const session = runtimeEventLiveSession(
              eventLiveSession(),
              cachedProjectInventory(currentServer.http.url),
              sessionEventScopeId(),
            )
            if (!session || !session.directory && !session.workspaceId) {
              await wait(RECONNECT_DELAY_MS)
              continue
            }
            const sessionWorkspaceKind = workspaceKind(session.workspaceKind)
            const response = await openWorkspaceRuntimeEventResponse({
              session,
              signedControlPlane: signedEventAccess(),
              init,
              serverUrl: currentServer.http.url,
              resolveWorkspaceRuntime: async ({ directory, workspaceId }) => {
                if (fastSessionSwitchAnyNetworkQuiet() && directory && !workspaceId) return null
                if (session.workspaceId && sessionWorkspaceKind) return { workspaceId: session.workspaceId, kind: sessionWorkspaceKind }
                const res = await request(workspaceResolveUrl({ baseUrl: currentServer.http.url, scope: directory, workspaceId }), { headers: { Accept: "application/json" } })
                if (res.status === 404) return null
                if (!res.ok) throw new Error((await res.text()) || `workspace resolve failed: ${res.status}`)
                return await res.json()
              },
              request,
              })
            // Open, not first-frame: a caller waiting to dispatch a turn needs
            // the stream to be listening before the turn's frames exist, and a
            // healthy stream can be quiet for its whole heartbeat interval.
            reportSessionEventStreamOpen("runtime-events", session.sessionID)
            let yielded = Date.now()
            for await (const item of sseJsonStream(response, runtimeAttempt.signal, (id) => {
              lastRuntimeEventId = id
            })) {
              const envelope = runtimeEnvelope(item)
              if (!envelope) {
                reportedContractVersion = reportRuntimeContractMismatch({
                  frame: item, reported: reportedContractVersion, serverUrl: currentServer.http.url,
                  live: eventLiveSession(),
                  publish: (directory, event) => { enqueue(directory, event); flush() },
                })
                continue
              }
              // Address the frame by the workspace THIS stream was opened for,
              // not by whatever session a history fetch last marked live. A
              // relay-backed runtime stamps every frame with its OWN filesystem
              // path — the only path it knows — and this connection is scoped to
              // exactly one `parentSessionId` on one workspace, so `session` is
              // the authority on the address its consumers registered. Reading
              // the live session instead dropped every delta of an ATTACHED
              // turn: the pane registers `workspace:<id>`, the live session was
              // still unmarked, and `conversationScopeKey` is an exact match.
              envelope.directory = eventDirectoryForLiveSession({
                directory: envelope.directory,
                sessionId: envelope.sessionId,
                liveSession: session,
              })
              heartbeat.reset()
              becameReady = true
              streamErrorLogged = false
              if (runtimeReplayGap(envelope)) {
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
                  baseUrl: currentServer.http.url,
                  liveSession: session,
                  subagents,
                  goalScope: liveSessionGoalScope({
                    live: session,
                    serverUrl: currentServer.http.url,
                    signedControlPlane: signedEventAccess(),
                  }),
                })
                lastRuntimeEventId = undefined
                runtimeAttempt.abort()
                break
              }
              if (envelope.payload.type === "goal-updated" || envelope.payload.type === "goal-cleared") {
                applyLiveSessionGoalEvent({
                  live: session,
                  serverUrl: currentServer.http.url,
                  signedControlPlane: signedEventAccess(),
                  sessionId: envelope.sessionId,
                  payload: envelope.payload,
                })
              }
              applySubagentRuntimeEventEnvelope(envelope, subagents)
              for (const event of projectRuntimeDiagnosticEnvelope(envelope)) {
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
            heartbeat.clear()
            reportSessionEventStreamClosed("runtime-events")
          }

          if (!streaming()) return
          failures = becameReady ? 0 : failures + 1
          await wait(reconnectBackoffMs(failures))
        }
      })().finally(() => {
        runtimeRun = undefined
        releaseLane()
        flush()
      })
      return runtimeRun
    }

    const controlEvents = useClaxedoEvents()
    const releaseControlEvents = controlEvents.listenCentral((frame) => {
      if (!streaming()) return
      const event = compatEventEnvelope(frame)
      if (!event) return
      applySubagentCompatLifecycleEvent(event.payload, subagents)
      enqueue(event.directory ?? "global", event.payload)
    })
    onCleanup(releaseControlEvents)

    const start = () => {
      started = true
      return startRuntimeEvents()
    }

    const stop = () => {
      started = false
      runtimeAttempt?.abort()
      heartbeat.clear()
    }

    /**
     * Resolves once the event streams that carry the CURRENT live session's
     * frames are open — the workspace bus and this provider's runtime-events
     * stream, as reported to `session-event-scope`. The composer awaits it
     * before dispatching a turn, so the turn's frames arrive live rather than
     * as a late burst when the stream finally opens.
     *
     * `timeoutMs` bounds how long a user's prompt is held for a stream that is
     * not coming up; the wait is dropped rather than left behind.
     */
    const ready = async (timeoutMs = 8_000) => {
      // `start()` resolves only when the stream loops end (at `stop()`), so
      // awaiting it here would hold the caller for the life of the session.
      // The loops handle their own failures; `ready` waits on the streams
      // being OPEN, which is what the race below does.
      void start()
      const give = new AbortController()
      await Promise.race([
        whenSessionEventStreamsOpen(sessionEventScopeId(), { signal: give.signal }),
        wait(timeoutMs),
      ])
      give.abort()
    }

    onMount(() => {
      queueMicrotask(() => {
        void start()
      })
      const handler = () => {
        if (document.visibilityState !== "visible") return
        if (!started) return
        if (heartbeat.sinceLastEvent() < HEARTBEAT_TIMEOUT_MS) return
        runtimeAttempt?.abort()
      }
      document.addEventListener("visibilitychange", handler)
      onCleanup(() => document.removeEventListener("visibilitychange", handler))
    })

    onCleanup(() => {
      if (liveSessionRestartTimer) clearTimeout(liveSessionRestartTimer)
      stop()
      abort.abort()
      flush()
    })

    const sdk = createServerClient({
      server: server.current.http,
      request: platform.fetch ?? authFetch,
    })

    const setLiveSession = (sessionID: string, opts?: { host?: "workspace"; directory?: string; workspaceId?: string; workspaceKind?: string; sessionRef?: SessionRef }) => {
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
        subagents: { registry: subagents, abortParent: (sessionID: string) => abortSubagentsForParent(sessionID, subagents) },
      },
      createClient(opts: GlobalSdkClientOptions) {
        const s = server.current
        if (!s) throw new Error(language.t("error.globalSDK.serverNotAvailable"))
        const { workspaceId: explicitWorkspaceId, request: explicitRequest, ...clientOptions } = opts
        const workspaceId = globalSdkClientWorkspaceId(cachedProjectInventory(s.http.url), {
          directory: clientOptions.directory,
          workspaceId: explicitWorkspaceId,
        })
        const placement = globalSdkClientPlacement(workspaceId)
        const request = explicitRequest ?? platform.fetch ?? authFetch
        return createServerClient({
          server: s.http,
          request: placement
            ? createTransport({
              placement,
              serverUrl: s.http.url,
              directory: clientOptions.directory,
              request,
              relayRequest: request,
            }).sdkFetch
            : request,
          ...clientOptions,
        })
      },
    }
  },
}
export const { use: useGlobalSDK, provider: GlobalSDKProvider } = createSimpleContext<ReturnType<typeof globalSDKContextInput.init>, Record<string, any>>(globalSDKContextInput)
