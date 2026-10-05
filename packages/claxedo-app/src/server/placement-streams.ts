import { hashKey, type QueryClient } from "@tanstack/solid-query"
import { toAppError } from "./errors"
import { queryKeys } from "./query-keys"
import { placementId, sessionId, type PlacementId } from "./ids"
import { openEventStream, type Stream } from "./stream"
import type { RuntimeRoute, Transport } from "./transport"
import type { SessionLocation } from "./types"
import type { Workspaces } from "./workspaces"

const RUNTIME_EVENTS_PATH = "/api/wr/events"

export type PlacementStreams = {
  readonly attach: (ref: SessionLocation) => () => void
  readonly watch: (id: PlacementId) => () => void
  readonly streams: (ref: SessionLocation) => boolean
  readonly close: () => void
}

type StreamsInput = {
  readonly transport: Transport
  readonly workspaces: Workspaces
  readonly queryClient: QueryClient
  readonly onFrame: (frame: unknown) => void
  readonly onGap: () => void
}

type OpenStream = { readonly stream: Stream; readonly route: string }

type StreamsState = {
  readonly input: StreamsInput
  readonly attached: Map<string, Map<string, number>>
  readonly sessions: Map<string, OpenStream>
  readonly watched: Map<PlacementId, number>
  readonly workspaces: Map<PlacementId, OpenStream>
}

function routeKey(route: RuntimeRoute): string {
  return JSON.stringify([route.workspaceId, route.directory, route.sessionHost?.sessionId, route.sharedSession?.sessionId])
}

function liveRemoteRoute(workspaces: Workspaces, placement: string, session: string) {
  return workspaces.streamRoute({ placementId: placementId(placement), sessionId: sessionId(session) })
}

function sessionKey(placement: string, session: string) {
  return JSON.stringify([placement, session])
}

function wanted(state: StreamsState) {
  const sessions = new Map<string, { session: string; route: RuntimeRoute }>()
  for (const [placement, attachedSessions] of state.attached) {
    for (const session of attachedSessions.keys()) {
      const route = liveRemoteRoute(state.input.workspaces, placement, session)
      if (route) sessions.set(sessionKey(placement, session), { session, route })
    }
  }
  return sessions
}

function refreshCatalog(input: StreamsInput) {
  void input.workspaces.refresh().catch((error) => console.error("The placement catalog could not be refreshed after its event stream ended", error))
}

function openRuntimeStream(input: StreamsInput, route: RuntimeRoute, path: string): OpenStream {
  return { route: routeKey(route), stream: openEventStream({
    open: ({ headers, signal }) => input.transport.runtime(route, path, { headers, signal }),
    onFrame: (frame) => input.onFrame(frame && typeof frame === "object" ? { ...frame, workspaceId: route.workspaceId } : frame),
    onGap: input.onGap,
    onState: (connection) => {
      if (!route.sharedSession && connection.kind === "reconnecting" && connection.attempt === 1) refreshCatalog(input)
    },
    onRefused: () => {
      if (route.sharedSession) void input.workspaces.shared.refresh().then(input.onGap, (error) => console.error("Shared sessions could not be refreshed", error))
      else refreshCatalog(input)
    },
  }) }
}

function reconcileKeyed<K, W extends { readonly route: RuntimeRoute }>(open: Map<K, OpenStream>, want: Map<K, W>, start: (wanted: W) => OpenStream) {
  for (const [key, current] of open) {
    const route = want.get(key)?.route
    if (route && routeKey(route) === current.route) continue
    current.stream.close()
    open.delete(key)
  }
  for (const [key, wanted] of want) if (!open.has(key)) open.set(key, start(wanted))
}

function watchedWorkspaces(state: StreamsState) {
  return new Map([...state.watched.keys()].flatMap((id) => {
    const route = state.input.workspaces.workspaceStreamRoute(id)
    return route ? [[id, { route }] as const] : []
  }))
}

function reconcileStreams(state: StreamsState) {
  const { input } = state
  reconcileKeyed(state.sessions, wanted(state), ({ session, route }) =>
    openRuntimeStream(input, route, `${RUNTIME_EVENTS_PATH}?sessionID=${encodeURIComponent(session)}`))
  reconcileKeyed(state.workspaces, watchedWorkspaces(state), ({ route }) => openRuntimeStream(input, route, `${RUNTIME_EVENTS_PATH}?sessions=none`))
}

function retain<K>(counts: Map<K, number>, key: K): () => void {
  counts.set(key, (counts.get(key) ?? 0) + 1)
  return () => {
    const count = (counts.get(key) ?? 1) - 1
    if (count > 0) counts.set(key, count)
    else counts.delete(key)
  }
}

function followCatalog(state: StreamsState): () => void {
  const { input } = state
  const catalogKeys = new Set([queryKeys.bootstrap(input.transport.serverUrl), queryKeys.accountCatalog(input.transport.serverUrl), queryKeys.sharedSessions(input.transport.serverUrl)].map(hashKey))
  const unsubscribeCatalog = input.queryClient.getQueryCache().subscribe((event) => {
    if (catalogKeys.has(event.query.queryHash) && event.type === "updated") reconcileStreams(state)
  })
  const unsubscribeHosts = input.workspaces.onSessionHostLearned(() => reconcileStreams(state))
  return () => {
    unsubscribeCatalog()
    unsubscribeHosts()
  }
}

export function createPlacementStreams(input: StreamsInput): PlacementStreams {
  const state: StreamsState = { input, attached: new Map(), sessions: new Map(), watched: new Map(), workspaces: new Map() }
  const unfollow = followCatalog(state)
  return {
    attach: (ref) => {
      const placement = String(ref.placementId)
      const session = String(ref.sessionId)
      const counts = state.attached.get(placement) ?? new Map<string, number>()
      state.attached.set(placement, counts)
      const release = retain(counts, session)
      reconcileStreams(state)
      void input.workspaces.home(ref).then(() => reconcileStreams(state), (error: unknown) => {
        console.warn("A session's host could not be resolved for its live stream", { sessionId: session, error: toAppError(error) })
      })
      return () => {
        release()
        if (counts.size === 0) state.attached.delete(placement)
        reconcileStreams(state)
      }
    },
    watch: (id) => {
      const release = retain(state.watched, id)
      reconcileStreams(state)
      return () => {
        release()
        reconcileStreams(state)
      }
    },
    streams: (ref) => state.sessions.has(sessionKey(String(ref.placementId), String(ref.sessionId))),
    close: () => {
      unfollow()
      state.attached.clear()
      state.watched.clear()
      reconcileStreams(state)
    },
  }
}
