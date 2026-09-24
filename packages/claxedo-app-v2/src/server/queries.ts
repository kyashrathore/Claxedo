import type { QueryClient } from "@tanstack/solid-query"
import { fetchQuery } from "./fetch-query"
import { accountQueries } from "./accounts"
import { cloudQueries } from "./cloud"
import { documentQueries } from "./documents"
import type { ServerEvent } from "./events"
import { fileQueries } from "./files"
import { gitQueries } from "./git"
import { harnessQueries } from "./harness-options"
import type { ServerQueries } from "./api"
import type { ProjectId } from "./ids"
import { machineQueries } from "./machines"
import { marketplaceQueries } from "./marketplace"
import { projectQueries } from "./projects"
import { queryKeys } from "./query-keys"
import { taskQueries } from "./tasks"
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

export function createQueries(transport: Transport, workspaces: Workspaces): ServerQueries {
  const cloud = cloudQueries(transport)
  return {
    projects: projectQueries(transport),
    placements: placementQueries(transport, workspaces),
    machines: machineQueries(transport, workspaces),
    accounts: accountQueries(transport),
    usage: usageQueries(transport),
    marketplace: marketplaceQueries(transport),
    tasks: taskQueries(transport),
    documents: documentQueries(transport),
    codeHost: cloud.codeHost,
    cloud: cloud.cloud,
    files: fileQueries(transport, workspaces),
    git: gitQueries(transport, workspaces),
    harnesses: harnessQueries(transport, workspaces),
  }
}

function invalidationKeys(server: string, event: ServerEvent): readonly (readonly unknown[])[] {
  switch (event.type) {
    case "filesChanged":
      return [queryKeys.filesOf(server, event.placementId), queryKeys.gitOf(server, event.placementId)]
    case "statusChanged":
      return event.status.kind === "idle" ? [queryKeys.gitOf(server, event.ref.placementId)] : []
    case "projectChanged":
      return [queryKeys.projects(server), queryKeys.project(server, event.projectId), queryKeys.bootstrap(server), queryKeys.placements(server), queryKeys.placementsOf(server, event.projectId)]
    case "placementsChanged":
    case "cloudWorkspaceChanged":
      return [queryKeys.bootstrap(server), queryKeys.placements(server), queryKeys.projects(server), queryKeys.machines(server), queryKeys.cloud(server)]
    case "pluginsChanged":
      return [queryKeys.marketplaceAll(server)]
    case "documentsChanged":
      return [queryKeys.documents(server)]
    case "usageChanged":
      return [queryKeys.usageAll(server)]
    case "streamGap":
      return [queryKeys.bootstrap(server), queryKeys.placements(server), queryKeys.projects(server), queryKeys.machines(server), queryKeys.documents(server), queryKeys.cloud(server)]
    default:
      return []
  }
}

export function invalidateFor(queryClient: QueryClient, server: string, event: ServerEvent) {
  for (const queryKey of invalidationKeys(server, event)) {
    void queryClient.invalidateQueries({ queryKey })
  }
}
