import { hashKey, type QueryClient } from "@tanstack/solid-query"
import { createSignal } from "solid-js"
import { ServerError } from "./errors"
import type { PlacementId } from "./ids"
import type { PlacementsApi } from "./index"
import { queryKeys } from "./query-keys"
import type { RuntimeRoute, Transport } from "./transport"
import type { SessionRef } from "./types"
import { bootstrapCatalog, type BootstrapCatalog, type PlacementRecord } from "./wire/placements"
import type { Address } from "./wire/session-row"

export type Workspaces = Pick<PlacementsApi, "byId" | "list"> & {
  readonly address: Address
  readonly route: (ref: SessionRef | PlacementId) => Promise<RuntimeRoute>
  readonly learn: (directory: string) => Promise<void>
  readonly catalog: () => BootstrapCatalog | undefined
  readonly load: () => Promise<BootstrapCatalog>
  readonly refresh: () => Promise<void>
  readonly dispose: () => void
}

const BOOTSTRAP_PATH = "/api/claxedo/bootstrap"
const WORKSPACE_DIRECTORY_PREFIX = "workspace:"

function directoryKey(directory: string) {
  return directory.replace(/\/+$/, "") || "/"
}

function locatedAt(record: PlacementRecord, directory: string) {
  const workspaceRef = directory.startsWith(WORKSPACE_DIRECTORY_PREFIX) ? directory.slice(WORKSPACE_DIRECTORY_PREFIX.length) : undefined
  return directoryKey(record.route.directory) === directory
    || (record.placement.path !== undefined && directoryKey(record.placement.path) === directory)
    || (workspaceRef !== undefined && record.route.workspaceId === workspaceRef)
}

export function createWorkspaces(transport: Transport, queryClient: QueryClient): Workspaces {
  const key = queryKeys.bootstrap(transport.serverUrl)
  const hash = hashKey(key)
  const [revision, setRevision] = createSignal(0)
  const relearned = new Set<string>()
  let seen: unknown

  const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
    if (event.query.queryHash !== hash || event.query.state.data === seen) return
    seen = event.query.state.data
    setRevision((value) => value + 1)
  })

  const catalog = () => {
    revision()
    return queryClient.getQueryData<BootstrapCatalog>(key)
  }
  const records = () => catalog()?.placements ?? []
  const recordOf = (id: PlacementId) => records().find((record) => record.placement.id === id)

  const recordAt = (directory: string, workspaceId?: string) => {
    const all = records()
    const byWorkspace = workspaceId ? all.find((record) => record.route.workspaceId === workspaceId) : undefined
    const wanted = directoryKey(directory)
    return byWorkspace ?? all.find((record) => locatedAt(record, wanted))
  }

  const read = async () => bootstrapCatalog(await transport.json<unknown>(BOOTSTRAP_PATH))
  const load = () => queryClient.fetchQuery({ queryKey: key, queryFn: read, staleTime: Number.POSITIVE_INFINITY })

  const refresh = async () => {
    relearned.clear()
    await queryClient.fetchQuery({ queryKey: key, queryFn: read, staleTime: 0 })
    await queryClient.invalidateQueries({ queryKey: queryKeys.placements(transport.serverUrl) })
  }

  const learn = async (directory: string) => {
    if (relearned.has(directory)) return
    await queryClient.fetchQuery({ queryKey: key, queryFn: read, staleTime: 0 })
    relearned.add(directory)
  }

  const route = async (ref: SessionRef | PlacementId): Promise<RuntimeRoute> => {
    const id = typeof ref === "string" ? ref : ref.placementId
    await load()
    const record = recordOf(id)
    if (!record) throw new ServerError({ class: "not_found", message: `Placement ${id} is not in the catalog` })
    return record.route
  }

  return {
    byId: (id) => recordOf(id)?.placement,
    list: () => records().map((record) => record.placement),
    address: {
      placementFor: (directory, workspaceId) => {
        const record = recordAt(directory, workspaceId)
        return record ? { placementId: record.placement.id, projectId: record.placement.projectId } : undefined
      },
    },
    route,
    learn,
    catalog,
    load,
    refresh,
    dispose: unsubscribe,
  }
}
