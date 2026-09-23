import type { QueryClient } from "@tanstack/solid-query"
import { ServerError } from "./errors"
import { placementId as asPlacementId, projectId as asProjectId, type PlacementId, type ProjectId } from "./ids"
import type { PlacementsApi } from "./index"
import type { Placement, SessionRef } from "./types"
import type { RuntimeRoute, Transport } from "./transport"
import { bootstrapCatalog, type BootstrapCatalog, type PlacementRecord } from "./wire/placements"
import type { Address } from "./wire/session-row"
import { queryKeys } from "./query-keys"

export type Workspaces = PlacementsApi & {
  readonly address: Address
  readonly routeFor: (ref: SessionRef | PlacementId) => RuntimeRoute
  readonly learn: (directory: string) => Promise<void>
  readonly catalog: () => BootstrapCatalog | undefined
  readonly load: () => Promise<BootstrapCatalog>
  readonly refresh: () => Promise<void>
}

export async function readBootstrap(transport: Transport): Promise<BootstrapCatalog> {
  const body = await transport.json<unknown>("/api/claxedo/bootstrap")
  return bootstrapCatalog(body)
}

function directoryKey(directory: string) {
  return directory.replace(/\/+$/, "") || "/"
}

export function createWorkspaces(input: { readonly transport: Transport; readonly queryClient: QueryClient }): Workspaces {
  const { transport, queryClient } = input
  const key = queryKeys.bootstrap(transport.serverUrl)
  const pending = new Map<string, Promise<void>>()

  const catalog = () => queryClient.getQueryData<BootstrapCatalog>(key)
  const records = () => catalog()?.placements ?? []

  const byId = (id: PlacementId) => records().find((record) => record.placement.id === id)

  const byDirectory = (directory: string, workspaceId?: string): PlacementRecord | undefined => {
    const all = records()
    if (workspaceId) {
      const hit = all.find((record) => record.route.workspaceId === workspaceId)
      if (hit) return hit
    }
    const wanted = directoryKey(directory)
    const workspaceRef = wanted.startsWith("workspace:") ? wanted.slice("workspace:".length) : undefined
    return all.find((record) =>
      directoryKey(record.route.directory) === wanted
      || (record.placement.path !== undefined && directoryKey(record.placement.path) === wanted)
      || (workspaceRef !== undefined && record.route.workspaceId === workspaceRef),
    )
  }

  const load = () => queryClient.fetchQuery({ queryKey: key, queryFn: () => readBootstrap(transport), staleTime: Number.POSITIVE_INFINITY })

  const learn = (directory: string) => {
    const existing = pending.get(directory)
    if (existing) return existing
    const task = queryClient.invalidateQueries({ queryKey: key }).then(() => load()).then(() => undefined).finally(() => pending.delete(directory))
    pending.set(directory, task)
    return task
  }

  const routeFor = (ref: SessionRef | PlacementId): RuntimeRoute => {
    const id = typeof ref === "string" ? ref : ref.placementId
    const record = byId(id)
    if (!record) throw new ServerError({ class: "not_found", message: `Placement ${id} is not in the catalog` })
    return record.route
  }

  return {
    byId: (id) => byId(id)?.placement,
    address: {
      placementFor: (directory, workspaceId) => {
        const record = byDirectory(directory, workspaceId)
        return record ? { placementId: record.placement.id, projectId: record.placement.projectId } : undefined
      },
    },
    routeFor,
    learn,
    catalog,
    load,
    refresh: async () => {
      await queryClient.invalidateQueries({ queryKey: key })
    },
  }
}

export function placementsOf(catalog: BootstrapCatalog | undefined): readonly Placement[] {
  return (catalog?.placements ?? []).map((record) => record.placement)
}

export function projectIdOf(value: string): ProjectId {
  return asProjectId(value)
}

export function placementIdOf(value: string): PlacementId {
  return asPlacementId(value)
}
