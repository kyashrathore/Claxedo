import { QueryClient } from "@tanstack/solid-query"
import { createSignal } from "solid-js"
import { createHostedAccount, type HostedAccount } from "./account"
import { createAccountsApi } from "./accounts"
import { createCapabilities, type CapabilitiesOwner } from "./capabilities"
import { createCloudApi } from "./cloud"
import { createAgentConnectionsApi } from "./agent-connections"
import { createIntegrationsApi } from "./integrations"
import { createProviderConnectApi } from "./provider-connect"
import { createProviderCatalogsApi } from "./provider-catalogs"
import { createFoldersApi } from "./folders"
import type { ServerConfig } from "./config"
import { isRetryableServerError, toAppError } from "./errors"
import { createEventIntake } from "./event-intake"
import type { ConnectionState } from "./events"
import { createGitApi } from "./git"
import { createMarketplaceApi } from "./marketplace"
import { createTasksApi } from "./tasks"
import { createHarnessConfigApi } from "./harness-config"
import { createLivePluginsApi } from "./live-plugins"
import { createOperations } from "./operations"
import type { ProjectId } from "./ids"
import type { Server, ServerQueries } from "./api"
import { createProjectsApi } from "./projects"
import { createQueries } from "./queries"
import { createPlacementStreams } from "./placement-streams"
import { createSessionProjection, type SessionProjection } from "./session-projection"
import { createSessionsApi } from "./sessions"
import { createStatusOwner, type StatusOwner } from "./status"
import { createEventStreams, type EventStreams } from "./streams"
import { createTerminalsApi } from "./terminals"
import { createTransport, type Transport } from "./transport"
import { createWorkspaces, type Workspaces } from "./workspaces"
import { createWorkspaceWakes } from "./workspace-wakes"
import { createWorktreeCreator } from "./worktrees"

const QUERY_GC_TIME_MS = 10 * 60_000
const QUERY_RETRY_LIMIT = 2

function createQueryClient() {
  return new QueryClient({
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
}

export type ServerHandle = Server & {
  readonly config: ServerConfig
  readonly retryConnection: () => void
  readonly ready: Promise<void>
  readonly dispose: () => void
}

type Startup = { readonly ready: Promise<void>; readonly retry: () => void }

function createStartup(input: {
  readonly workspaces: Workspaces
  readonly streams: EventStreams
  readonly capabilities: CapabilitiesOwner
  readonly setConnection: (state: ConnectionState) => void
}): Startup {
  let opened = false
  const start = async () => {
    try {
      const catalog = await input.workspaces.load()
      if (!opened) input.streams.open(catalog.declaration)
      opened = true
      await input.capabilities.load()
    } catch (error) {
      const failure = toAppError(error)
      if (!opened) input.setConnection({ kind: "offline", reason: failure.message })
      else console.error("The server's capabilities could not be read", failure)
    }
  }
  const retry = () => {
    if (opened) return input.streams.retry()
    input.setConnection({ kind: "connecting" })
    void start()
  }
  return { ready: start(), retry }
}

function serverApis(transport: Transport, workspaces: Workspaces, status: StatusOwner, queryClient: QueryClient, queries: ServerQueries, projection: SessionProjection, account: HostedAccount | undefined) {
  const operations = createOperations(transport, account)
  const project = (id: ProjectId) => queryClient.fetchQuery(queries.projects.byId(id))
  const wakes = createWorkspaceWakes(transport, workspaces)
  return {
    sessions: createSessionsApi(transport, workspaces, status, wakes, projection, account),
    projects: createProjectsApi(transport, queryClient, workspaces.refresh),
    placements: {
      byId: workspaces.byId,
      list: workspaces.list,
      load: async () => {
        await workspaces.load()
        return workspaces.list()
      },
      createWorktree: createWorktreeCreator(transport, workspaces),
    },
    terminals: createTerminalsApi(transport, workspaces),
    git: createGitApi(transport, workspaces, queryClient),
    cloud: createCloudApi(transport, workspaces, wakes, project, account),
    accounts: createAccountsApi(transport, queryClient),
    marketplace: createMarketplaceApi(transport, queryClient),
    tasks: createTasksApi(transport),
    folders: createFoldersApi(transport),
    integrations: createIntegrationsApi(transport, queryClient),
    agentConnections: createAgentConnectionsApi(transport, queryClient),
    providerConnect: createProviderConnectApi(transport, queryClient),
    providerCatalogs: createProviderCatalogsApi(transport, workspaces, queryClient),
    livePlugins: createLivePluginsApi(transport),
    harnessConfig: createHarnessConfigApi(transport, workspaces),
    request: transport.request,
    operation: operations.run,
    acceptOrgInvitation: (token: string) => operations.run("org.invitations.accept", { token }),
  }
}

export function createServer(config: ServerConfig): ServerHandle {
  const queryClient = createQueryClient()
  const transport = createTransport(config)
  const account = config.account ? createHostedAccount(config.account) : undefined
  const workspaces = createWorkspaces(transport, queryClient, account)
  const status = createStatusOwner(transport)
  const intake = createEventIntake({ serverUrl: transport.serverUrl, queryClient, workspaces, status })
  const [connection, setConnection] = createSignal<ConnectionState>({ kind: "connecting" })
  const streams = createEventStreams({ config, transport, onFrame: intake.frame, onGap: intake.gap, onState: setConnection })
  const capabilities = createCapabilities(transport, workspaces)
  const queries = createQueries(transport, workspaces, config.thisMachineReport)
  const startup = createStartup({ workspaces, streams, capabilities, setConnection })
  const projection = createSessionProjection(transport, workspaces)
  const stopProjecting = intake.subscribe(projection.observe)
  const placementStreams = createPlacementStreams({ transport, workspaces, queryClient, onFrame: intake.frame, onGap: intake.gap })
  return {
    config,
    connection,
    capabilities: capabilities.value,
    queryClient,
    subscribe: intake.subscribe,
    ...serverApis(transport, workspaces, status, queryClient, queries, projection, account),
    attachPlacement: placementStreams.attach,
    queries,
    retryConnection: startup.retry,
    ready: startup.ready,
    dispose: () => {
      stopProjecting()
      placementStreams.close()
      streams.close()
      intake.dispose()
      workspaces.dispose()
      queryClient.clear()
    },
  }
}
