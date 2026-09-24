import { QueryClient } from "@tanstack/solid-query"
import { batch, createSignal } from "solid-js"
import { createCapabilities } from "./capabilities"
import type { ServerConfig } from "./config"
import { isRetryable } from "./errors"
import type { ConnectionState, ServerEvent } from "./events"
import type { Server } from "./index"
import { createProjectsApi } from "./projects"
import { createQueries, invalidateFor } from "./queries"
import { createSessionsApi } from "./sessions"
import { createStatusOwner } from "./status"
import { createEventStreams } from "./streams"
import { createTransport } from "./transport"
import { createWorkspaces } from "./workspaces"
import { createCoalescer } from "./wire/coalesce"
import { frameNeedsAddress, frameOf, serverEventFromFrame, type Frame } from "./wire/frames"

export const QUERY_GC_TIME_MS = 10 * 60_000
export const QUERY_RETRY_LIMIT = 2

export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: Number.POSITIVE_INFINITY,
        gcTime: QUERY_GC_TIME_MS,
        retry: (failures, error) => failures < QUERY_RETRY_LIMIT && isRetryable(error),
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
      },
      mutations: { retry: false },
    },
  })
}

export type ServerHandle = Server & {
  readonly config: ServerConfig
  readonly retryConnection: () => void
  readonly ready: Promise<void>
  readonly dispose: () => void
}

export function createServer(config: ServerConfig): ServerHandle {
  const queryClient = createQueryClient()
  const transport = createTransport(config)
  const workspaces = createWorkspaces({ transport, queryClient })
  const status = createStatusOwner(transport)
  const listeners = new Set<(event: ServerEvent) => void>()
  const [connection, setConnection] = createSignal<ConnectionState>({ kind: "connecting" })

  const publish = (events: readonly ServerEvent[]) => {
    batch(() => {
      for (const event of events) {
        const admitted = status.apply(event)
        if (!admitted) continue
        invalidateFor(queryClient, transport.serverUrl, admitted)
        for (const listener of listeners) listener(admitted)
      }
    })
  }
  const coalescer = createCoalescer(publish)

  let queue: Promise<void> = Promise.resolve()
  const handleFrame = (frame: Frame) => {
    let event = serverEventFromFrame(frame, workspaces.address)
    if (event || !frameNeedsAddress(frame)) return event ? coalescer.push(event) : undefined
    return workspaces.learn(frame.directory as string).then(() => {
      event = serverEventFromFrame(frame, workspaces.address)
      if (event) coalescer.push(event)
    })
  }
  const onFrame = (raw: unknown) => {
    const frame = frameOf(raw)
    if (!frame) return
    queue = queue.then(() => handleFrame(frame))
  }

  const streams = createEventStreams({
    config,
    transport,
    workspaces,
    onFrame,
    onGap: () => coalescer.push({ type: "streamGap" }),
    onState: setConnection,
  })

  const capabilities = createCapabilities({ transport, workspaces, queryClient })
  const projects = createProjectsApi({ transport, queryClient, onChanged: () => workspaces.refresh() })
  const sessions = createSessionsApi({ transport, workspaces, status })
  const ready = workspaces.load().then((catalog) => {
    streams.open(catalog.declaration)
    capabilities.load()
  })

  return {
    config,
    connection,
    capabilities: capabilities.value,
    queryClient,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    sessions,
    projects,
    placements: { byId: workspaces.byId, list: workspaces.list },
    queries: createQueries(transport, workspaces),
    retryConnection: streams.retry,
    ready,
    dispose: () => {
      streams.close()
      coalescer.flush()
      listeners.clear()
      queryClient.clear()
    },
  }
}
