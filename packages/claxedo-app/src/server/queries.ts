import type { QueryClient } from "@tanstack/solid-query"
import type { HostedAccount } from "./account"
import { agentConnectionQueries } from "./agent-connections"
import { integrationQueries } from "./integrations"
import { providerConnectQueries } from "./provider-connect"
import { providerCatalogQueries } from "./provider-catalogs"
import { folderQueries } from "./folders"
import { fetchQuery } from "./fetch-query"
import { accountQueries } from "./accounts"
import { cloudQueries } from "./cloud"
import type { ServerEvent } from "./events"
import { fileQueries } from "./files"
import { livePluginQueries } from "./live-plugins"
import { gitQueries } from "./git"
import { harnessQueries } from "./harness-options"
import type { ServerQueries } from "./api"
import type { ProjectId } from "./ids"
import { machineQueries } from "./machines"
import { marketplaceQueries } from "./marketplace"
import { organizationQueries } from "./organizations"
import { projectQueries } from "./projects"
import { projectEnvironmentQuery } from "./project-environment"
import { queryKeys } from "./query-keys"
import { taskQueries } from "./tasks"
import { terminalQueries } from "./terminals"
import type { Transport } from "./transport"
import type { FetchQuery, Placement } from "./types"
import { usageQueries } from "./usage"
import type { Workspaces } from "./workspaces"
import type { BootstrapCatalog } from "./wire/placements"

function placementsOf(catalog: BootstrapCatalog) {
  return catalog.placements.map((record) => record.placement)
}

function placementQueries(transport: Transport, workspaces: Workspaces) {
  const server = transport.serverUrl
  const list = (): FetchQuery<readonly Placement[]> => fetchQuery(queryKeys.placements(server), async () => placementsOf(await workspaces.load()))
  const byProject = (projectId: ProjectId): FetchQuery<readonly Placement[]> =>
    fetchQuery(queryKeys.placementsOf(server, projectId), async () => placementsOf(await workspaces.load()).filter((placement) => placement.projectId === projectId))
  return { list, byProject }
}

export function createQueries(transport: Transport, workspaces: Workspaces, account: HostedAccount | undefined): ServerQueries {
  const cloud = cloudQueries(transport)
  return {
    livePlugins: livePluginQueries(transport),
    projects: { ...projectQueries(transport, workspaces), environment: projectEnvironmentQuery(transport, workspaces, account) },
    placements: placementQueries(transport, workspaces),
    machines: machineQueries(transport, workspaces, account),
    organizations: organizationQueries(transport.serverUrl, account),
    accounts: accountQueries(transport),
    usage: usageQueries(transport),
    marketplace: marketplaceQueries(transport),
    tasks: taskQueries(transport),
    codeHost: cloud.codeHost,
    cloud: cloud.cloud,
    terminals: terminalQueries(transport, workspaces),
    files: fileQueries(transport, workspaces),
    git: gitQueries(transport, workspaces),
    harnesses: harnessQueries(transport, workspaces),
    folders: folderQueries(transport),
    integrations: integrationQueries(transport),
    agentConnections: agentConnectionQueries(transport),
    providerConnect: providerConnectQueries(transport),
    providerCatalogs: providerCatalogQueries(transport, workspaces),
  }
}

function invalidationKeys(server: string, event: ServerEvent, endsWritingTurn: boolean): readonly (readonly unknown[])[] {
  switch (event.type) {
    case "sessionsChanged":
      return [queryKeys.sharedSessions(server)]
    case "filesChanged":
      return [queryKeys.filesOf(server, event.placementId), queryKeys.gitOf(server, event.placementId)]
    case "statusChanged":
      return endsWritingTurn ? [queryKeys.filesOf(server, event.ref.placementId), queryKeys.gitOf(server, event.ref.placementId)] : []
    case "projectChanged":
      return [queryKeys.projects(server), queryKeys.project(server, event.projectId), queryKeys.bootstrap(server), queryKeys.placements(server), queryKeys.placementsOf(server, event.projectId)]
    case "placementsChanged":
    case "cloudWorkspaceChanged":
      return [queryKeys.bootstrap(server), queryKeys.accountCatalog(server), queryKeys.placements(server), queryKeys.projects(server), queryKeys.machines(server), queryKeys.cloud(server)]
    case "pluginsChanged":
      return [queryKeys.livePlugins(server)]
    case "usageChanged":
      return [queryKeys.usageAll(server)]
    case "streamGap":
      return [
        queryKeys.sharedSessions(server),
        queryKeys.bootstrap(server),
        queryKeys.accountCatalog(server),
        queryKeys.placements(server),
        queryKeys.projects(server),
        queryKeys.machines(server),
        queryKeys.cloud(server),
        queryKeys.filesAll(server),
        queryKeys.gitAll(server),
      ]
    default:
      return []
  }
}

export function invalidateFor(queryClient: QueryClient, server: string, event: ServerEvent, endsWritingTurn: boolean) {
  for (const queryKey of invalidationKeys(server, event, endsWritingTurn)) {
    void queryClient.invalidateQueries({ queryKey })
  }
}
