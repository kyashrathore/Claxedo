import { hashKey, type QueryClient } from "@tanstack/solid-query"
import { toAppError } from "./errors"
import { isImageOutdated, isRuntimeUnavailable } from "./wire/connection"
import { queryKeys } from "./query-keys"
import { placementId, sessionId, type PlacementId } from "./ids"
import { openEventStream, type Stream } from "./stream"
import type { RuntimeRoute, Transport } from "./transport"
import type { SessionLocation } from "./types"
import type { Workspaces } from "./workspaces"

const RUNTIME_EVENTS_PATH = "/api/wr/events"
const RUNTIME_STREAM_RECONNECTS = 8

export type PlacementStreams = {
  readonly attach: (ref: SessionLocation) => () => void
  readonly watch: (id: PlacementId) => () => void
  readonly streams: (ref: SessionLocation) => boolean
  readonly retry: () => void
  readonly close: () => void
}

type StreamsInput = {
  readonly transport: Transport
  readonly workspaces: Workspaces
  readonly queryClient: QueryClient
  readonly onFrame: (frame: unknown) => void
  readonly onGap: (ref?: SessionLocation) => void
}

type Refusal =
  | { readonly kind: "outdated"; readonly current: boolean }
  | { readonly kind: "unavailable"; readonly row: string }
  | { readonly kind: "unanswered"; readonly row: string; readonly retried: boolean }

type OpenStream = { readonly stream: Stream; readonly route: string; readonly workspaceId: string; readonly placement: PlacementId; refused?: Refusal }

type StreamsState = {
  readonly input: StreamsInput
  readonly attached: Map<string, Map<string, number>>
  readonly refs: Map<string, SessionLocation>
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
  const sessions = new Map<string, { placement: PlacementId; session: string; route: RuntimeRoute; ref: SessionLocation }>()
  for (const [placement, attachedSessions] of state.attached) {
    for (const session of attachedSessions.keys()) {
      const route = liveRemoteRoute(state.input.workspaces, placement, session)
      const ref = state.refs.get(sessionKey(placement, session))
      if (route && ref) sessions.set(sessionKey(placement, session), { placement: placementId(placement), session, route, ref })
    }
  }
  return sessions
}

function refreshCatalog(input: StreamsInput) {
  void input.workspaces.refresh().catch((error) => console.error("The placement catalog could not be refreshed after its event stream ended", error))
}

function placementRow(input: StreamsInput, placement: PlacementId) {
  return JSON.stringify(input.workspaces.byId(placement) ?? null)
}

function reopens(input: StreamsInput, open: OpenStream) {
  const refused = open.refused
  if (refused?.kind === "outdated") return refused.current
  if (refused?.kind === "unanswered" && refused.retried) return true
  return refused !== undefined && refused.row !== placementRow(input, open.placement)
}

function openRuntimeStream(input: StreamsInput, placement: PlacementId, route: RuntimeRoute, path: string, rerouted: boolean, session?: SessionLocation): OpenStream {
  let missed = rerouted || session !== undefined
  const open: OpenStream = { route: routeKey(route), workspaceId: route.workspaceId, placement, stream: openEventStream({
    open: ({ headers, signal }) => input.transport.runtime(route, path, { headers, signal }),
    onFrame: (frame) => input.onFrame(frame && typeof frame === "object" ? { ...frame, workspaceId: route.workspaceId } : frame),
    onGap: () => input.onGap(session),
    onState: (connection) => {
      if (missed && connection.kind === "connected") {
        missed = false
        input.onGap(session)
      }
      if (!route.sharedSession && connection.kind === "reconnecting" && connection.attempt === 1) refreshCatalog(input)
    },
    onRefused: (error) => {
      if (isImageOutdated(error)) open.refused = { kind: "outdated", current: false }
      else if (isRuntimeUnavailable(error)) {
        open.refused = { kind: "unavailable", row: placementRow(input, placement) }
        refreshCatalog(input)
      } else if (route.sharedSession) void input.workspaces.shared.refresh().then(() => input.onGap(session), (error) => console.error("Shared sessions could not be refreshed", error))
      else refreshCatalog(input)
    },
    reconnects: {
      limit: RUNTIME_STREAM_RECONNECTS,
      onExhausted: (error) => {
        open.refused = { kind: "unanswered", row: placementRow(input, placement), retried: false }
        console.warn("A workspace's live stream stopped asking its machine; it reopens on focus, a reconnect or a change to the workspace", { workspaceId: route.workspaceId, error })
      },
    },
  }) }
  return open
}

function reconcileKeyed<K, W extends { readonly route: RuntimeRoute }>(input: StreamsInput, open: Map<K, OpenStream>, want: Map<K, W>, start: (wanted: W, rerouted: boolean) => OpenStream) {
  const rerouted = new Set<K>()
  for (const [key, current] of open) {
    const route = want.get(key)?.route
    if (route && routeKey(route) === current.route && !reopens(input, current)) continue
    if (route) rerouted.add(key)
    current.stream.close()
    open.delete(key)
  }
  for (const [key, wanted] of want) if (!open.has(key)) open.set(key, start(wanted, rerouted.has(key)))
}

function watchedWorkspaces(state: StreamsState) {
  return new Map([...state.watched.keys()].flatMap((id) => {
    const route = state.input.workspaces.workspaceStreamRoute(id)
    return route ? [[id, { id, route }] as const] : []
  }))
}

function reconcileStreams(state: StreamsState) {
  const { input } = state
  reconcileKeyed(input, state.sessions, wanted(state), ({ placement, session, route, ref }, rerouted) =>
    openRuntimeStream(input, placement, route, `${RUNTIME_EVENTS_PATH}?sessionID=${encodeURIComponent(session)}`, rerouted, ref))
  reconcileKeyed(input, state.workspaces, watchedWorkspaces(state), ({ id, route }, rerouted) =>
    openRuntimeStream(input, id, route, `${RUNTIME_EVENTS_PATH}?sessions=none`, rerouted))
}

function retain<K>(counts: Map<K, number>, key: K): () => void {
  counts.set(key, (counts.get(key) ?? 0) + 1)
  return () => {
    const count = (counts.get(key) ?? 1) - 1
    if (count > 0) counts.set(key, count)
    else counts.delete(key)
  }
}

function markImageCurrent(state: StreamsState, workspaceId: string): boolean {
  const outdated = [...state.sessions.values(), ...state.workspaces.values()].filter((open) => open.workspaceId === workspaceId && open.refused?.kind === "outdated")
  for (const open of outdated) open.refused = { kind: "outdated", current: true }
  return outdated.length > 0
}

function retryUnanswered(state: StreamsState) {
  for (const open of [...state.sessions.values(), ...state.workspaces.values()]) {
    if (open.refused?.kind === "unanswered") open.refused = { ...open.refused, retried: true }
  }
  reconcileStreams(state)
}

function followCatalog(state: StreamsState): () => void {
  const { input } = state
  const catalogKeys = new Set([queryKeys.bootstrap(input.transport.serverUrl), queryKeys.accountCatalog(input.transport.serverUrl), queryKeys.sharedSessions(input.transport.serverUrl)].map(hashKey))
  const unsubscribeCatalog = input.queryClient.getQueryCache().subscribe((event) => {
    if (catalogKeys.has(event.query.queryHash) && event.type === "updated") reconcileStreams(state)
  })
  const unsubscribeHosts = input.workspaces.onSessionHostLearned(() => reconcileStreams(state))
  const unsubscribeImage = input.transport.onRuntimeImage((workspaceId, outdated) => {
    if (!outdated && markImageCurrent(state, workspaceId)) reconcileStreams(state)
  })
  return () => {
    unsubscribeCatalog()
    unsubscribeHosts()
    unsubscribeImage()
  }
}

function attachSession(state: StreamsState, ref: SessionLocation): () => void {
  const placement = String(ref.placementId)
  const session = String(ref.sessionId)
  const counts = state.attached.get(placement) ?? new Map<string, number>()
  state.attached.set(placement, counts)
  state.refs.set(sessionKey(placement, session), ref)
  const release = retain(counts, session)
  reconcileStreams(state)
  void state.input.workspaces.home(ref).then(() => reconcileStreams(state), (error: unknown) => {
    console.warn("A session's host could not be resolved for its live stream", { sessionId: session, error: toAppError(error) })
  })
  return () => {
    release()
    if (!counts.has(session)) state.refs.delete(sessionKey(placement, session))
    if (counts.size === 0) state.attached.delete(placement)
    reconcileStreams(state)
  }
}

export function createPlacementStreams(input: StreamsInput): PlacementStreams {
  const state: StreamsState = { input, attached: new Map(), refs: new Map(), sessions: new Map(), watched: new Map(), workspaces: new Map() }
  const unfollow = followCatalog(state)
  return {
    attach: (ref) => attachSession(state, ref),
    watch: (id) => {
      const release = retain(state.watched, id)
      reconcileStreams(state)
      return () => {
        release()
        reconcileStreams(state)
      }
    },
    streams: (ref) => {
      const open = state.sessions.get(sessionKey(String(ref.placementId), String(ref.sessionId)))
      return open !== undefined && open.refused === undefined
    },
    retry: () => retryUnanswered(state),
    close: () => {
      unfollow()
      state.attached.clear()
      state.refs.clear()
      state.watched.clear()
      reconcileStreams(state)
    },
  }
}
