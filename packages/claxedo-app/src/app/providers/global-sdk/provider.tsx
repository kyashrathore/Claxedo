import { useClaxedoEvents } from "@/app/integrations/claxedo-events"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { batch, onCleanup, onMount } from "solid-js"
import { createServerClient } from "@/app/connection/server-client"
import { useLanguage } from "@/platform/i18n/provider"
import { usePlatform } from "@/platform/runtime/platform-provider"
import { createTransport } from "@/platform/runtime/transport"
import { useServer } from "@/app/connection/server"
import { authFetch } from "@/platform/api/api"
import { principalHasSignedAccess, usePrincipal } from "@/platform/auth/identity-provider"
import { sessionWorkspaceRuntimeRef } from "@/platform/runtime/session-workspace"
import { sessionEventScopeId, whenSessionEventStreamsOpen } from "@/platform/runtime/session-event-scope"
import { createEventCoalescer } from "@/platform/sync/global-sdk/event-coalescer"
import { createSubagentRegistry } from "@/features/session/subagents/subagent-registry"
import { abortSubagentsForParent, applySubagentCompatLifecycleEvent, applySubagentPresentationEvent } from "@/features/session/subagents/subagent-ingress"
import type { SessionRef } from "@/platform/identity/session-ref"
import { applyLiveSessionGoalEvent, liveSessionGoalScope } from "./goal-events"
import {
  globalSdkClientPlacement,
  globalSdkClientWorkspaceId,
  liveSessionTransition,
  liveSessionWithRelayBacking,
  type GlobalSdkClientOptions,
  type LiveSession,
} from "./live-session"
import {
  cachedProjectInventory,
  initialRouteDirectory,
  initialRouteWorkspace,
  shouldUseSignedEventAccess,
} from "./route-event-scope"
import { isRelayBackedWorkspaceKind, workspaceKind } from "@/platform/runtime/agent/workspace-kind"
export { abortSubagentsForParent, applySubagentCompatLifecycleEvent } from "@/features/session/subagents/subagent-ingress"
export { eventDirectoryForLiveSession, globalSdkClientPlacement, globalSdkClientWorkspaceId, liveSessionTransition, liveSessionWithRelayBacking, nextLiveSession } from "./live-session"
import {
  compatEventEnvelope,
  partUpdateSupersedesDeltas,
  resetStreamGapState,
  type GlobalSdkEvent,
} from "./presentation-frames"
export {
  compatEventEnvelope,
  partUpdateSupersedesDeltas,
  resetStreamGapState,
  type GlobalSdkEvent,
} from "./presentation-frames"
type Event = GlobalSdkEvent

const globalSDKContextInput = {
  name: "GlobalSDK", gate: true,
  init: () => {
    const language = useLanguage()
    const server = useServer()
    const platform = usePlatform()
    const principal = usePrincipal()

    let liveSession: LiveSession | undefined
    // Without workspaceId/kind a hosted live session's frames would be
    // addressed by the host's own path, which names nothing here.
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
    const currentServer = server.current
    if (!currentServer) throw new Error(language.t("error.globalSDK.noServerAvailable"))

    const emitter = createGlobalEmitter<{
      [key: string]: Event
    }>()

    const FLUSH_FRAME_MS = 16

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

    const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
    const subagents = createSubagentRegistry()

    let started = false

    // Every frame the two streams deliver enters here: session presentation
    // frames go through the coalescer to the conversation ingress; subagent
    // revisions and goal changes feed their registries; a gap notice from
    // either stream resets what those registries and the live session's read
    // models believe, after the reader has already asked the session
    // controller to re-read history.
    const streams = useClaxedoEvents()
    const releaseStreams = streams.listen((frame) => {
      if (!started) return
      if (frame.type === "stream.replay-gap") {
        const live = eventLiveSession()
        if (!live || live.sessionID === "route") {
          subagents.replayGap()
          return
        }
        const kind = workspaceKind(live.workspaceKind)
        void resetStreamGapState({
          baseUrl: currentServer.http.url,
          directory: live.directory ?? "global",
          sessionId: live.sessionID,
          subagents,
          goalScope: liveSessionGoalScope({
            live,
            serverUrl: currentServer.http.url,
            signedControlPlane: signedEventAccess(),
          }),
          projection: {
            signedControlPlane: signedEventAccess(),
            ...(live.workspaceId ? { workspaceId: live.workspaceId } : {}),
            ...(isRelayBackedWorkspaceKind(kind) ? { workspaceKind: kind } : {}),
          },
        })
        return
      }
      const event = compatEventEnvelope(frame)
      if (!event) return
      if (event.payload.type === "subagent.updated") {
        applySubagentPresentationEvent(event.payload, subagents)
        return
      }
      if (event.payload.type === "goal.updated" || event.payload.type === "goal.cleared") {
        applyLiveSessionGoalEvent({
          live: eventLiveSession(),
          serverUrl: currentServer.http.url,
          signedControlPlane: signedEventAccess(),
          sessionId: event.payload.properties.sessionID,
          payload: event.payload.type === "goal.updated"
            ? { type: "goal-updated", sessionId: event.payload.properties.sessionID, goal: event.payload.properties.goal }
            : { type: "goal-cleared", sessionId: event.payload.properties.sessionID },
        })
        return
      }
      applySubagentCompatLifecycleEvent(event.payload, subagents)
      enqueue(event.directory ?? "global", event.payload)
    })
    onCleanup(releaseStreams)

    const start = () => {
      started = true
    }

    const stop = () => {
      started = false
    }

    /**
     * Resolves once the streams that carry the CURRENT live session's frames
     * are open — `cp` and the session's `wr`, as reported to
     * `session-event-scope`. The composer awaits it before dispatching a turn,
     * so the turn's frames arrive live rather than as a late burst.
     *
     * `timeoutMs` bounds how long a user's prompt is held for a stream that is
     * not coming up; the wait is dropped rather than left behind.
     */
    const ready = async (timeoutMs = 8_000) => {
      start()
      const give = new AbortController()
      await Promise.race([
        whenSessionEventStreamsOpen(sessionEventScopeId(), { signal: give.signal }),
        wait(timeoutMs),
      ])
      give.abort()
    }

    onMount(() => {
      queueMicrotask(start)
    })

    onCleanup(() => {
      stop()
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
