import type { QueryClient } from "@tanstack/solid-query"
import { queryOptions } from "@tanstack/solid-query"
import { accountQueries } from "./accounts"
import { documentQueries } from "./documents"
import type { ServerEvent } from "./events"
import { fileQueries } from "./files"
import { gitQueries } from "./git"
import { machineQueries } from "./machines"
import { marketplaceQueries } from "./marketplace"
import { projectQueries } from "./projects"
import { queryKeys } from "./query-keys"
import { taskQueries } from "./tasks"
import type { Transport } from "./transport"
import { usageQueries } from "./usage"
import { placementsOf, readBootstrap, type Workspaces } from "./workspaces"

export type ServerQueries = {
  readonly projects: ReturnType<typeof projectQueries>
  readonly placements: { readonly list: () => ReturnType<typeof placementQueries>["list"] extends () => infer R ? R : never }
  readonly machines: ReturnType<typeof machineQueries>
  readonly accounts: ReturnType<typeof accountQueries>
  readonly usage: ReturnType<typeof usageQueries>
  readonly marketplace: ReturnType<typeof marketplaceQueries>
  readonly tasks: ReturnType<typeof taskQueries>
  readonly documents: ReturnType<typeof documentQueries>
  readonly files: ReturnType<typeof fileQueries>
  readonly git: ReturnType<typeof gitQueries>
}

function placementQueries(transport: Transport, workspaces: Workspaces) {
  return {
    list: () => queryOptions({
      queryKey: queryKeys.bootstrap(transport.serverUrl),
      queryFn: () => readBootstrap(transport),
      select: (catalog: Awaited<ReturnType<typeof readBootstrap>>) => placementsOf(catalog ?? workspaces.catalog()),
    }),
  }
}

export function createQueries(transport: Transport, workspaces: Workspaces): ServerQueries {
  return {
    projects: projectQueries(transport),
    placements: placementQueries(transport, workspaces),
    machines: machineQueries(transport, workspaces),
    accounts: accountQueries(transport),
    usage: usageQueries(transport),
    marketplace: marketplaceQueries(transport),
    tasks: taskQueries(transport),
    documents: documentQueries(transport),
    files: fileQueries(transport, workspaces),
    git: gitQueries(transport, workspaces),
  }
}

export function invalidationKeys(server: string, event: ServerEvent): readonly (readonly unknown[])[] {
  switch (event.type) {
    case "filesChanged":
      return [queryKeys.filesOf(server, event.placementId), queryKeys.gitOf(server, event.placementId)]
    case "projectChanged":
      return [queryKeys.projects(server), queryKeys.project(server, event.projectId), queryKeys.bootstrap(server)]
    case "placementsChanged":
      return [queryKeys.bootstrap(server), queryKeys.projects(server), queryKeys.machines(server)]
    case "pluginsChanged":
      return [queryKeys.marketplaceAll(server)]
    case "documentsChanged":
      return [queryKeys.documents(server)]
    case "usageChanged":
      return [queryKeys.usageAll(server)]
    case "streamGap":
      return [queryKeys.bootstrap(server), queryKeys.projects(server), queryKeys.machines(server), queryKeys.documents(server)]
    default:
      return []
  }
}

export function invalidateFor(queryClient: QueryClient, server: string, event: ServerEvent) {
  for (const queryKey of invalidationKeys(server, event)) {
    void queryClient.invalidateQueries({ queryKey })
  }
}
