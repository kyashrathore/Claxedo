import { QueryObserver, type QueryClient } from "@tanstack/solid-query"
import { createSignal, type Accessor } from "solid-js"
import type { HostedAccount } from "./account"
import type { LinkedCatalog } from "./account-link"
import { createAccountPlacements, withAccountPlacements, type AccountPlacements } from "./account-placements"
import type { PlacementsApi } from "./api"
import { ServerError } from "./errors"
import type { PlacementId, ProjectId } from "./ids"
import { queryKeys } from "./query-keys"
import type { RuntimeRoute, Transport } from "./transport"
import type { Project, SessionLocation } from "./types"
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
  readonly route: (ref: SessionLocation | PlacementId) => Promise<RuntimeRoute>
  readonly locate: (id: PlacementId) => Promise<RuntimeRoute>
  readonly home: (ref: SessionLocation) => Promise<SessionHome>
  readonly learn: (directory: string) => Promise<void>
  readonly catalog: () => BootstrapCatalog | undefined
  readonly load: () => Promise<BootstrapCatalog>
  readonly refresh: () => Promise<void>
  readonly accountProjects: () => Promise<readonly Project[]>
  readonly accountProjectIds: (projectId: ProjectId) => readonly ProjectId[]
  readonly dispose: () => void
}

const BOOTSTRAP_PATH = "/api/claxedo/bootstrap"
const WORKSPACE_DIRECTORY_PREFIX = "workspace:"

function trimmedDirectory(directory: string) {
  return directory.replace(/\/+$/, "") || "/"
}

function locatedAt(record: PlacementRecord, directory: string) {
  const workspaceRef = directory.startsWith(WORKSPACE_DIRECTORY_PREFIX) ? directory.slice(WORKSPACE_DIRECTORY_PREFIX.length) : undefined
  return trimmedDirectory(record.route.directory) === directory
    || (record.placement.path !== undefined && trimmedDirectory(record.placement.path) === directory)
    || (workspaceRef !== undefined && record.route.workspaceId === workspaceRef)
}

function placementRecordAt(records: readonly PlacementRecord[], directory: string, workspaceId?: string) {
  const byWorkspace = workspaceId ? records.find((record) => record.route.workspaceId === workspaceId) : undefined
  const wanted = trimmedDirectory(directory)
  return byWorkspace ?? records.find((record) => locatedAt(record, wanted))
}

function observeQuery(queryClient: QueryClient, key: readonly unknown[]): { readonly revision: Accessor<number>; readonly dispose: () => void } {
  const [revision, setRevision] = createSignal(0)
  let seen: unknown
  const dispose = new QueryObserver(queryClient, { queryKey: key, enabled: false }).subscribe((result) => {
    if (result.data === seen) return
    seen = result.data
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
        const record = placementRecordAt(records(), directory, workspaceId)
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
      const offlineMachine = record.route.remote && record.placement.kind !== "cloud" && !record.placement.reachable
      return { route: record.route, central: record.placement.kind === "cloud", live: !isStoppedCloud(record.placement) && !offlineMachine }
    },
  }
}

function mergedCatalog(queryClient: QueryClient, key: readonly unknown[], accountPlacements: AccountPlacements | undefined) {
  const watched = [observeQuery(queryClient, key), ...(accountPlacements ? [observeQuery(queryClient, accountPlacements.key)] : [])]
  let last: { local: BootstrapCatalog; linked: LinkedCatalog | undefined; merged: BootstrapCatalog } | undefined
  const merge = (local: BootstrapCatalog) => {
    const linked = accountPlacements?.link(local.placements)
    if (last?.local !== local || last.linked !== linked) last = { local, linked, merged: withAccountPlacements(local, linked) }
    return last.merged
  }
  const local = () => queryClient.getQueryData<BootstrapCatalog>(key)
  return {
    merge,
    catalog: () => {
      for (const watch of watched) watch.revision()
      const current = local()
      return current && merge(current)
    },
    linked: () => {
      const current = local()
      return current && accountPlacements?.link(current.placements)
    },
    dispose: () => watched.forEach((watch) => watch.dispose()),
  }
}

function accountReads(linked: () => LinkedCatalog | undefined, signed: boolean, load: () => Promise<unknown>): Pick<Workspaces, "accountProjects" | "accountProjectIds"> {
  return {
    accountProjects: async () => {
      if (!signed) return []
      await load()
      return linked()?.projects ?? []
    },
    accountProjectIds: (projectId) => linked()?.accountProjectIds(projectId) ?? [],
  }
}

export function createWorkspaces(transport: Transport, queryClient: QueryClient, account?: HostedAccount): Workspaces {
  const key = queryKeys.bootstrap(transport.serverUrl)
  const accountPlacements = account ? createAccountPlacements(account, transport.serverUrl, queryClient) : undefined
  const merged = mergedCatalog(queryClient, key, accountPlacements)
  const relearned = new Set<string>()
  const read = async () => bootstrapCatalog(await transport.json<unknown>(BOOTSTRAP_PATH))
  const reread = () => queryClient.fetchQuery({ queryKey: key, queryFn: read, staleTime: 0 })
  const load = async () => {
    const [local] = await Promise.all([queryClient.fetchQuery({ queryKey: key, queryFn: read, staleTime: Number.POSITIVE_INFINITY }), accountPlacements?.load()])
    return merged.merge(local)
  }
  const { recordOf, byId, list, address } = placementReads(() => merged.catalog()?.placements ?? [])
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
    catalog: merged.catalog,
    load,
    refresh: async () => {
      relearned.clear()
      await Promise.all([reread(), accountPlacements?.reread()])
      await queryClient.invalidateQueries({ queryKey: queryKeys.placements(transport.serverUrl) })
      await queryClient.invalidateQueries({ queryKey: queryKeys.projects(transport.serverUrl) })
    },
    ...accountReads(merged.linked, accountPlacements !== undefined, load),
    dispose: merged.dispose,
  }
}
