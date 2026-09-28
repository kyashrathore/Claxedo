import { hashKey, type QueryClient } from "@tanstack/solid-query"
import { queryKeys } from "./query-keys"
import { openEventStream, type Stream } from "./stream"
import type { Transport } from "./transport"
import type { SessionRef } from "./types"
import type { Workspaces } from "./workspaces"

const RUNTIME_EVENTS_PATH = "/api/wr/events"
const WORKSPACE_EVENT_STREAM_DENIED = "workspace_event_stream_denied"

export type PlacementStreams = {
  readonly attach: (ref: SessionRef) => () => void
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
  readonly open: Map<string, Stream>
  readonly sessionScoped: Set<string>
  readonly sessions: Map<string, Stream>
}

function liveRemoteRoute(workspaces: Workspaces, id: string) {
  const record = workspaces.catalog()?.placements.find((candidate) => candidate.placement.id === id)
  return record?.route.remote && record.placement.reachable ? record.route : undefined
}

function sessionKey(placement: string, session: string) {
  return JSON.stringify([placement, session])
}

function wanted(state: StreamsState) {
  const workspace = new Set<string>()
  const sessions = new Map<string, { placement: string; session: string }>()
  for (const [placement, attachedSessions] of state.attached) {
    if (!liveRemoteRoute(state.input.workspaces, placement)) continue
    if (!state.sessionScoped.has(placement)) {
      workspace.add(placement)
      continue
    }
    for (const session of attachedSessions.keys()) sessions.set(sessionKey(placement, session), { placement, session })
  }
  return { workspace, sessions }
}

function reconcileStreams(state: StreamsState) {
  const { input, open, sessions } = state
  const want = wanted(state)
  for (const [id, stream] of open) {
    if (want.workspace.has(id)) continue
    stream.close()
    open.delete(id)
  }
  for (const [key, stream] of sessions) {
    if (want.sessions.has(key)) continue
    stream.close()
    sessions.delete(key)
  }
  for (const id of want.workspace) {
    const route = liveRemoteRoute(input.workspaces, id)
    if (!route || open.has(id)) continue
    open.set(id, openEventStream({
      open: ({ headers, signal }) => input.transport.runtime(route, RUNTIME_EVENTS_PATH, { headers, signal }),
      onFrame: input.onFrame,
      onGap: input.onGap,
      onRefused: (error) => {
        if (error.code !== WORKSPACE_EVENT_STREAM_DENIED) return
        state.sessionScoped.add(id)
        reconcileStreams(state)
      },
    }))
  }
  for (const [key, { placement, session }] of want.sessions) {
    const route = liveRemoteRoute(input.workspaces, placement)
    if (!route || sessions.has(key)) continue
    const path = `${RUNTIME_EVENTS_PATH}?sessionID=${encodeURIComponent(session)}`
    sessions.set(key, openEventStream({
      open: ({ headers, signal }) => input.transport.runtime(route, path, { headers, signal }),
      onFrame: input.onFrame,
      onGap: input.onGap,
    }))
  }
}

export function createPlacementStreams(input: StreamsInput): PlacementStreams {
  const state: StreamsState = { input, attached: new Map(), open: new Map(), sessionScoped: new Set(), sessions: new Map() }
  const catalogKey = hashKey(queryKeys.bootstrap(input.transport.serverUrl))
  const unsubscribe = input.queryClient.getQueryCache().subscribe((event) => {
    if (event.query.queryHash === catalogKey && event.type === "updated") reconcileStreams(state)
  })
  return {
    attach: (ref) => {
      const placement = String(ref.placementId)
      const session = String(ref.sessionId)
      const counts = state.attached.get(placement) ?? new Map<string, number>()
      counts.set(session, (counts.get(session) ?? 0) + 1)
      state.attached.set(placement, counts)
      reconcileStreams(state)
      return () => {
        const count = (counts.get(session) ?? 1) - 1
        if (count > 0) counts.set(session, count)
        else counts.delete(session)
        if (counts.size === 0) state.attached.delete(placement)
        reconcileStreams(state)
      }
    },
    close: () => {
      unsubscribe()
      state.attached.clear()
      reconcileStreams(state)
    },
  }
}
