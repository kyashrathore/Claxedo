import { hashKey, type QueryClient } from "@tanstack/solid-query"
import type { PlacementId } from "./ids"
import { queryKeys } from "./query-keys"
import { openStream, type Stream } from "./stream"
import type { Transport } from "./transport"
import type { Workspaces } from "./workspaces"

const RUNTIME_EVENTS_PATH = "/api/wr/events"

export type PlacementStreams = {
  readonly attach: (id: PlacementId) => () => void
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
  readonly attached: Map<string, number>
  readonly open: Map<string, Stream>
}

function liveRemoteRoute(workspaces: Workspaces, id: string) {
  const record = workspaces.catalog()?.placements.find((candidate) => candidate.placement.id === id)
  return record?.route.remote && record.placement.reachable ? record.route : undefined
}

function sync(state: StreamsState) {
  const { input, attached, open } = state
  for (const [id, stream] of open) {
    if (attached.has(id) && liveRemoteRoute(input.workspaces, id)) continue
    stream.close()
    open.delete(id)
  }
  for (const id of attached.keys()) {
    const route = liveRemoteRoute(input.workspaces, id)
    if (!route || open.has(id)) continue
    open.set(id, openStream({
      open: ({ headers, signal }) => input.transport.runtime(route, RUNTIME_EVENTS_PATH, { headers, signal }),
      onFrame: input.onFrame,
      onGap: input.onGap,
    }))
  }
}

export function createPlacementStreams(input: StreamsInput): PlacementStreams {
  const state: StreamsState = { input, attached: new Map(), open: new Map() }
  const catalogKey = hashKey(queryKeys.bootstrap(input.transport.serverUrl))
  const unsubscribe = input.queryClient.getQueryCache().subscribe((event) => {
    if (event.query.queryHash === catalogKey && event.type === "updated") sync(state)
  })
  return {
    attach: (id) => {
      state.attached.set(id, (state.attached.get(id) ?? 0) + 1)
      sync(state)
      return () => {
        const count = (state.attached.get(id) ?? 1) - 1
        if (count > 0) state.attached.set(id, count)
        else state.attached.delete(id)
        sync(state)
      }
    },
    close: () => {
      unsubscribe()
      state.attached.clear()
      sync(state)
    },
  }
}
