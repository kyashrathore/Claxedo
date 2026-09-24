import { QueryClient } from "@tanstack/solid-query"
import { createSignal } from "solid-js"
import { createCapabilities } from "./capabilities"
import { createCloudApi } from "./cloud"
import type { ServerConfig } from "./config"
import { isRetryable, toAppError } from "./errors"
import { createEventIntake } from "./event-intake"
import type { ConnectionState } from "./events"
import { createGitApi } from "./git"
import type { ProjectId } from "./ids"
import type { Server } from "./index"
import { createProjectsApi } from "./projects"
import { createQueries } from "./queries"
import { createSessionsApi } from "./sessions"
import { createStatusOwner } from "./status"
import { createEventStreams } from "./streams"
import { createTerminalsApi } from "./terminals"
import { createTransport } from "./transport"
import { createWorkspaces } from "./workspaces"
import { createWorktreeCreator } from "./worktrees"

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
  const workspaces = createWorkspaces(transport, queryClient)
  const status = createStatusOwner(transport)
  const intake = createEventIntake({ serverUrl: transport.serverUrl, queryClient, workspaces, status })
  const [connection, setConnection] = createSignal<ConnectionState>({ kind: "connecting" })
  const streams = createEventStreams({ config, transport, onFrame: intake.frame, onGap: intake.gap, onState: setConnection })
  const capabilities = createCapabilities(transport, workspaces)
  const queries = createQueries(transport, workspaces)
  const project = (id: ProjectId) => queryClient.fetchQuery(queries.projects.byId(id))

  let opened = false
  const start = async () => {
    try {
      const catalog = await workspaces.load()
      if (!opened) streams.open(catalog.declaration)
      opened = true
      await capabilities.load()
    } catch (error) {
      const failure = toAppError(error)
      if (!opened) setConnection({ kind: "offline", reason: failure.message })
      else console.error("The server's capabilities could not be read", failure)
    }
  }
  const ready = start()

  return {
    config,
    connection,
    capabilities: capabilities.value,
    queryClient,
    subscribe: intake.subscribe,
    sessions: createSessionsApi(transport, workspaces, status),
    projects: createProjectsApi(transport, queryClient, workspaces.refresh),
    placements: { byId: workspaces.byId, list: workspaces.list, createWorktree: createWorktreeCreator(transport, workspaces) },
    terminals: createTerminalsApi(transport, workspaces),
    git: createGitApi(transport, workspaces),
    cloud: createCloudApi(transport, workspaces, project),
    queries,
    retryConnection: () => {
      if (!opened) {
        setConnection({ kind: "connecting" })
        void start()
        return
      }
      streams.retry()
    },
    ready,
    dispose: () => {
      streams.close()
      intake.dispose()
      workspaces.dispose()
      queryClient.clear()
    },
  }
}
