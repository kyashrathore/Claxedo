import { hashKey, type QueryClient } from "@tanstack/solid-query"
import { createSignal, type Accessor } from "solid-js"
import type { PlacementsApi } from "./api"
import { ServerError } from "./errors"
import type { PlacementId } from "./ids"
import { queryKeys } from "./query-keys"
import type { RuntimeRoute, Transport } from "./transport"
import type { SessionRef } from "./types"
import { isStoppedCloud } from "./placement-runtime"
import { workspaceStopped } from "./wire/connection"
import { bootstrapCatalog, type BootstrapCatalog, type PlacementRecord } from "./wire/placements"
import type { Address } from "./wire/session-row"

export type SessionHome = {
  readonly route: RuntimeRoute
  readonly central: boolean
  readonly live: boolean
}

export type Workspaces = Pick<PlacementsApi, "byId" | "list"> & {
  readonly address: Address
  readonly route: (ref: SessionRef | PlacementId) => Promise<RuntimeRoute>
  readonly locate: (id: PlacementId) => Promise<RuntimeRoute>
  readonly home: (ref: SessionRef) => Promise<SessionHome>
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

function recordAt(records: readonly PlacementRecord[], directory: string, workspaceId?: string) {
  const byWorkspace = workspaceId ? records.find((record) => record.route.workspaceId === workspaceId) : undefined
  const wanted = directoryKey(directory)
  return byWorkspace ?? records.find((record) => locatedAt(record, wanted))
}

function watchQuery(queryClient: QueryClient, key: readonly unknown[]): { readonly revision: Accessor<number>; readonly dispose: () => void } {
  const hash = hashKey(key)
  const [revision, setRevision] = createSignal(0)
  let seen: unknown
  const dispose = queryClient.getQueryCache().subscribe((event) => {
    if (event.query.queryHash !== hash || event.query.state.data === seen) return
    seen = event.query.state.data
    setRevision((value) => value + 1)
  })
  return { revision, dispose }
}

function placementReads(records: () => readonly PlacementRecord[]) {
  const recordOf = (id: PlacementId) => records().find((record) => record.placement.id === id)
  return {
    recordOf,
    byId: (id: PlacementId) => recordOf(id)?.placement,
    list: () => records().map((record) => record.placement),
    address: {
      placementFor: (directory: string, workspaceId?: string) => {
        const record = recordAt(records(), directory, workspaceId)
        return record ? { placementId: record.placement.id, projectId: record.placement.projectId } : undefined
      },
    },
  }
}

function placementRoutes(find: (id: PlacementId) => Promise<PlacementRecord | undefined>): Pick<Workspaces, "route" | "locate" | "home"> {
  const placed = async (id: PlacementId) => {
    const record = await find(id)
    if (!record) throw new ServerError({ class: "not_found", message: `Placement ${id} is not in the catalog` })
    return record
  }
  return {
    route: async (ref) => {
      const record = await placed(typeof ref === "string" ? ref : ref.placementId)
      if (isStoppedCloud(record.placement)) throw workspaceStopped(record.route.workspaceId)
      return record.route
    },
    locate: async (id) => (await placed(id)).route,
    home: async (ref) => {
      const record = await placed(ref.placementId)
      return { route: record.route, central: record.placement.kind === "cloud", live: !isStoppedCloud(record.placement) }
    },
  }
}

export function createWorkspaces(transport: Transport, queryClient: QueryClient): Workspaces {
  const key = queryKeys.bootstrap(transport.serverUrl)
  const watched = watchQuery(queryClient, key)
  const relearned = new Set<string>()
  const read = async () => bootstrapCatalog(await transport.json<unknown>(BOOTSTRAP_PATH))
  const reread = () => queryClient.fetchQuery({ queryKey: key, queryFn: read, staleTime: 0 })
  const load = () => queryClient.fetchQuery({ queryKey: key, queryFn: read, staleTime: Number.POSITIVE_INFINITY })
  const catalog = () => {
    watched.revision()
    return queryClient.getQueryData<BootstrapCatalog>(key)
  }
  const { recordOf, byId, list, address } = placementReads(() => catalog()?.placements ?? [])
  return {
    byId,
    list,
    address,
    ...placementRoutes(async (id) => {
      await load()
      return recordOf(id)
    }),
    learn: async (directory) => {
      if (relearned.has(directory)) return
      await reread()
      relearned.add(directory)
    },
    catalog,
    load,
    refresh: async () => {
      relearned.clear()
      await reread()
      await queryClient.invalidateQueries({ queryKey: queryKeys.placements(transport.serverUrl) })
      await queryClient.invalidateQueries({ queryKey: queryKeys.projects(transport.serverUrl) })
    },
    dispose: watched.dispose,
  }
}
