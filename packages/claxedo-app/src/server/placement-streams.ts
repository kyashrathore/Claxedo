import { hashKey, type QueryClient } from "@tanstack/solid-query"
import { toAppError } from "./errors"
import { queryKeys } from "./query-keys"
import { placementId, sessionId } from "./ids"
import { openEventStream, type Stream } from "./stream"
import type { Transport } from "./transport"
import type { SessionLocation } from "./types"
import type { Workspaces } from "./workspaces"

const RUNTIME_EVENTS_PATH = "/api/wr/events"

export type PlacementStreams = {
  readonly attach: (ref: SessionLocation) => () => void
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

type StreamsState = {
  readonly input: StreamsInput
  readonly attached: Map<string, Map<string, number>>
  readonly sessions: Map<string, Stream>
}

function liveRemoteRoute(workspaces: Workspaces, placement: string, session: string) {
  return workspaces.streamRoute({ placementId: placementId(placement), sessionId: sessionId(session) })
}

function sessionKey(placement: string, session: string) {
  return JSON.stringify([placement, session])
}

function wanted(state: StreamsState) {
  const sessions = new Map<string, { placement: string; session: string }>()
  for (const [placement, attachedSessions] of state.attached) {
    for (const session of attachedSessions.keys()) {
      if (liveRemoteRoute(state.input.workspaces, placement, session)) sessions.set(sessionKey(placement, session), { placement, session })
    }
  }
  return sessions
}

function refreshCatalog(input: StreamsInput) {
  void input.workspaces.refresh().catch((error) => console.error("The placement catalog could not be refreshed after its event stream ended", error))
}

function reconcileStreams(state: StreamsState) {
  const { input, sessions } = state
  const want = wanted(state)
  for (const [key, stream] of sessions) {
    if (want.has(key)) continue
    stream.close()
    sessions.delete(key)
  }
  for (const [key, { placement, session }] of want) {
    const route = liveRemoteRoute(input.workspaces, placement, session)
    if (!route || sessions.has(key)) continue
    const path = `${RUNTIME_EVENTS_PATH}?sessionID=${encodeURIComponent(session)}`
    sessions.set(key, openEventStream({
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
    }))
  }
}

export function createPlacementStreams(input: StreamsInput): PlacementStreams {
  const state: StreamsState = { input, attached: new Map(), sessions: new Map() }
  const catalogKeys = new Set([queryKeys.bootstrap(input.transport.serverUrl), queryKeys.accountCatalog(input.transport.serverUrl), queryKeys.sharedSessions(input.transport.serverUrl)].map(hashKey))
  const unsubscribe = input.queryClient.getQueryCache().subscribe((event) => {
    if (catalogKeys.has(event.query.queryHash) && event.type === "updated") reconcileStreams(state)
  })
  return {
    attach: (ref) => {
      const placement = String(ref.placementId)
      const session = String(ref.sessionId)
      const counts = state.attached.get(placement) ?? new Map<string, number>()
      counts.set(session, (counts.get(session) ?? 0) + 1)
      state.attached.set(placement, counts)
      reconcileStreams(state)
      void input.workspaces.home(ref).then(() => reconcileStreams(state), (error: unknown) => {
        console.warn("A session's host could not be resolved for its live stream", { sessionId: session, error: toAppError(error) })
      })
      return () => {
        const count = (counts.get(session) ?? 1) - 1
        if (count > 0) counts.set(session, count)
        else counts.delete(session)
        if (counts.size === 0) state.attached.delete(placement)
        reconcileStreams(state)
      }
    },
    streams: (ref) => state.sessions.has(sessionKey(String(ref.placementId), String(ref.sessionId))),
    close: () => {
      unsubscribe()
      state.attached.clear()
      reconcileStreams(state)
    },
  }
}
