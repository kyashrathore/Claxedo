import { QueryClient } from "@tanstack/solid-query"
import { createSignal } from "solid-js"
import { createBrowserHostedAccount, createHostedAccount, type HostedAccount } from "./account"
import { createAccountsApi } from "./accounts"
import { createCapabilities } from "./capabilities"
import { createCloudApi } from "./cloud"
import { createAgentConnectionsApi } from "./agent-connections"
import { createIntegrationsApi } from "./integrations"
import { createProviderConnectApi } from "./provider-connect"
import { createProviderCatalogsApi } from "./provider-catalogs"
import { createFoldersApi } from "./folders"
import type { ServerConfig } from "./config"
import { isRetryableServerError } from "./errors"
import { createEventIntake, type EventIntake } from "./event-intake"
import type { ConnectionState } from "./events"
import { createGitApi } from "./git"
import { createMarketplaceApi } from "./marketplace"
import { createTasksApi } from "./tasks"
import { createHarnessConfigApi } from "./harness-config"
import { createLivePluginsApi } from "./live-plugins"
import { createOperations } from "./operations"
import type { ProjectId } from "./ids"
import type { SessionLocation } from "./types"
import type { Server, ServerQueries } from "./api"
import { createProjectsApi } from "./projects"
import { createProjectEnvironmentApi } from "./project-environment"
import { queryKeys } from "./query-keys"
import { createQueries } from "./queries"
import { createPlacementStreams, type PlacementStreams } from "./placement-streams"
import { createSessionProjection, type SessionProjection } from "./session-projection"
import { createSessionsApi } from "./sessions"
import type { SnapshotCoverage } from "./snapshot-coverage"
import { createStatusOwner, type StatusOwner } from "./status"
import { createEventStreams } from "./streams"
import { createStartup } from "./startup"
import { createProductTelemetry } from "./telemetry"
import { createTerminalsApi } from "./terminals"
import { createTransport, type Transport } from "./transport"
import { createWorkspaces, type Workspaces } from "./workspaces"
import { createWorkspaceWakes } from "./workspace-wakes"
import { createWorktreeCreator } from "./worktrees"

const QUERY_GC_TIME_MS = 10 * 60_000
const QUERY_RETRY_LIMIT = 2

function createQueryClient() {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: Number.POSITIVE_INFINITY,
        gcTime: QUERY_GC_TIME_MS,
        retry: (failures, error) => failures < QUERY_RETRY_LIMIT && isRetryableServerError(error),
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
      },
      mutations: { retry: false },
    },
  })
  client.setQueryDefaults(queryKeys.localFilesAll(), { gcTime: 0 })
  return client
}

export type ServerHandle = Server & {
  readonly config: ServerConfig
  readonly ready: Promise<void>
  readonly closeStreams: () => void
  readonly dispose: () => void
}

function serverApis(transport: Transport, workspaces: Workspaces, status: StatusOwner, coverage: SnapshotCoverage, events: EventIntake["subscribe"], queryClient: QueryClient, queries: ServerQueries, projection: SessionProjection, account: HostedAccount | undefined, port: HostedAccount | undefined) {
  const telemetry = createProductTelemetry(account)
  const operations = createOperations(transport, port)
  const project = (id: ProjectId) => queryClient.fetchQuery(queries.projects.byId(id))
  const wakes = createWorkspaceWakes(transport, workspaces, events)
  const cloud = createCloudApi(transport, workspaces, wakes, project, account)
  return {
    telemetry,
    sessions: createSessionsApi(transport, workspaces, status, coverage, wakes, projection, telemetry, account),
    sharedSessions: workspaces.shared,
    projects: { ...createProjectsApi(transport, queryClient, workspaces, cloud.create), ...createProjectEnvironmentApi(transport, queryClient, workspaces, account) },
    placements: {
      byId: workspaces.byId,
      list: workspaces.list,
      complete: workspaces.complete,
      openable: workspaces.openable,
      load: async () => {
        await workspaces.load()
        return workspaces.list()
      },
      createWorktree: createWorktreeCreator(transport, workspaces),
    },
    terminals: createTerminalsApi(transport, workspaces, telemetry, wakes),
    git: createGitApi(transport, workspaces, queryClient),
    cloud,
    accounts: createAccountsApi(transport, queryClient, account),
    marketplace: createMarketplaceApi(transport, queryClient, telemetry),
    tasks: createTasksApi(transport, queryClient, workspaces, wakes),
    folders: createFoldersApi(transport),
    integrations: createIntegrationsApi(transport, queryClient),
    agentConnections: createAgentConnectionsApi(transport, queryClient),
    providerConnect: createProviderConnectApi(transport, queryClient),
    providerCatalogs: createProviderCatalogsApi(transport, workspaces, queryClient),
    livePlugins: createLivePluginsApi(transport),
    harnessConfig: createHarnessConfigApi(transport, workspaces, account),
    request: transport.request,
    operation: operations.run,
    acceptOrgInvitation: (token: string) => operations.run("org.invitations.accept", { token }),
  }
}

function retryConnections(startup: Pick<ReturnType<typeof createStartup>, "retry">, placementStreams: Pick<PlacementStreams, "retry">) {
  return () => {
    placementStreams.retry()
    return startup.retry()
  }
}

function createServerQueries(queryClient: QueryClient, transport: Transport, workspaces: Workspaces, account: HostedAccount | undefined): ServerQueries {
  const queries = createQueries(transport, workspaces, account)
  if (account) {
    void queryClient.prefetchQuery(queries.machines.list())
    void queryClient.prefetchQuery(queries.agentConnections.list())
  }
  return queries
}

export function createServer(config: ServerConfig): ServerHandle {
  const queryClient = createQueryClient()
  const transport = createTransport(config)
  const port = config.account ? createHostedAccount(config.account) : undefined
  const account = port ?? (config.cookies ? createBrowserHostedAccount(transport) : undefined)
  const workspaces = createWorkspaces(transport, queryClient, account)
  const status = createStatusOwner(transport)
  const streamed = (ref: SessionLocation) => workspaces.servedHere(ref.placementId) || placementStreams.streams(ref)
  const intake = createEventIntake({ serverUrl: transport.serverUrl, queryClient, workspaces, status, streamed })
  const [connection, setConnection] = createSignal<ConnectionState>({ kind: "connecting" })
  const streams = createEventStreams({ config, transport, hostedAccount: account !== undefined, onFrame: intake.frame, onGap: intake.gap, onState: setConnection })
  const capabilities = createCapabilities({ hostedAccount: account !== undefined })
  const queries = createServerQueries(queryClient, transport, workspaces, account)
  const startup = createStartup({ workspaces, streams, capabilities, setConnection })
  const projection = createSessionProjection(workspaces, account)
  const stopProjecting = intake.subscribe(projection.observe)
  const placementStreams = createPlacementStreams({ transport, workspaces, queryClient, onFrame: intake.frame, onGap: intake.gap })
  const closeStreams = () => {
    placementStreams.close()
    streams.close()
  }
  return {
    config,
    connection,
    capabilities: capabilities.value,
    startup: startup.state,
    queryClient,
    subscribe: intake.subscribe,
    ...serverApis(transport, workspaces, status, placementStreams.coverage, intake.subscribe, queryClient, queries, projection, account, port),
    attachPlacement: placementStreams.attach,
    watchPlacement: placementStreams.watch,
    queries,
    retryConnection: retryConnections(startup, placementStreams),
    ready: startup.ready,
    closeStreams,
    dispose: () => {
      stopProjecting()
      closeStreams()
      intake.dispose()
      workspaces.dispose()
      queryClient.clear()
    },
  }
}
