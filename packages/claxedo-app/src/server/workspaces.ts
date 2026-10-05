import { QueryObserver, type QueryClient } from "@tanstack/solid-query"
import { createSignal, type Accessor } from "solid-js"
import type { HostedAccount } from "./account"
import type { LinkedCatalog } from "./account-link"
import { createAccountPlacements, withAccountPlacements, type AccountPlacements } from "./account-placements"
import type { PlacementsApi } from "./api"
import { ServerError, toAppError } from "./errors"
import { placementId, sessionId as asSessionId, type PlacementId, type ProjectId } from "./ids"
import { queryKeys } from "./query-keys"
import { createSharedSessions, type SharedSessions } from "./shared-sessions"
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
  readonly shared: SharedSessions
  readonly streamRoute: (ref: Pick<SessionLocation, "placementId" | "sessionId">) => RuntimeRoute | undefined
  readonly servedHere: (id: PlacementId) => boolean
  readonly address: Address
  readonly route: (ref: Pick<SessionLocation, "placementId" | "sessionId"> | PlacementId) => Promise<RuntimeRoute>
  readonly locate: (id: PlacementId) => Promise<RuntimeRoute>
  readonly home: (ref: SessionLocation) => Promise<SessionHome>
  readonly learn: (directory: string) => Promise<void>
  readonly hostSession: (ref: Pick<SessionLocation, "placementId" | "sessionId">, root: string | undefined) => void
  readonly onSessionHostLearned: (listener: () => void) => () => void
  readonly catalog: () => BootstrapCatalog | undefined
  readonly load: () => Promise<BootstrapCatalog>
  readonly refresh: () => Promise<void>
  readonly accountProjects: () => Promise<readonly Project[]>
  readonly accountProjectIds: (projectId: ProjectId) => readonly ProjectId[]
  readonly accountKnows: (workspaceId: string) => boolean
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
  const hosts: SessionHosts = { roots: new Map(), askedOrServedByWorkspace: new Map(), learned: new Set() }
  const answer = (key: string, root: string | undefined) => {
    if (root) rememberSessionHost(hosts, key, root)
    hosts.askedOrServedByWorkspace.set(key, Promise.resolve())
  }
  const learnSessionHost = (workspaceId: string, sessionId: string, root: string) => {
    const placement = records().find((record) => record.route.workspaceId === workspaceId)?.placement.id ?? placementId(workspaceId)
    answer(sessionHostKey({ placementId: placement, sessionId: asSessionId(sessionId) }), root)
  }
  const published: Pick<Workspaces, "byId" | "list" | "hostSession"> = {
    byId: (id: PlacementId) => recordOf(id)?.placement,
    list: () => records().map((record) => record.placement),
    hostSession: (ref, root) => answer(sessionHostKey(ref), root),
  }
  const onSessionHostLearned = (listener: () => void) => {
    hosts.learned.add(listener)
    return () => void hosts.learned.delete(listener)
  }
  return {
    recordOf,
    hosts,
    learnSessionHost,
    onSessionHostLearned,
    published,
    address: {
      placementFor: (directory: string, workspaceId?: string) => {
        const record = placementRecordAt(records(), directory, workspaceId)
        return record ? { placementId: record.placement.id, projectId: record.placement.projectId } : undefined
      },
    },
  }
}

type SessionHosts = { readonly roots: Map<string, string>; readonly askedOrServedByWorkspace: Map<string, Promise<unknown>>; readonly learned: Set<() => void> }

function rememberSessionHost(hosts: SessionHosts, key: string, root: string) {
  if (hosts.roots.get(key) === root) return
  hosts.roots.set(key, root)
  for (const listener of hosts.learned) listener()
}

const sessionHostKey = (ref: Pick<SessionLocation, "placementId" | "sessionId">) => JSON.stringify([ref.placementId, ref.sessionId])

function hostedRoute(record: PlacementRecord, hosts: SessionHosts, ref: Pick<SessionLocation, "placementId" | "sessionId">): RuntimeRoute | undefined {
  const root = hosts.roots.get(sessionHostKey(ref))
  return root ? { ...record.route, sessionHost: { sessionId: root } } : undefined
}

type HostFinder = Transport["findSessionHost"]

function cloudSessionHosts(find: HostFinder, hosts: SessionHosts) {
  return async (record: PlacementRecord, ref: Pick<SessionLocation, "placementId" | "sessionId">) => {
    if (record.placement.kind !== "cloud") return hostedRoute(record, hosts, ref)
    const key = sessionHostKey(ref)
    const pending = hosts.askedOrServedByWorkspace.get(key) ?? find(record.route.workspaceId, ref.sessionId).then((root) => {
      if (root) rememberSessionHost(hosts, key, root)
    }, (error: unknown) => {
      hosts.askedOrServedByWorkspace.delete(key)
      throw error
    })
    hosts.askedOrServedByWorkspace.set(key, pending)
    await pending
    return hostedRoute(record, hosts, ref)
  }
}

function placementRoutes(find: (id: PlacementId) => Promise<PlacementRecord | undefined>, shared: Workspaces["shared"], hosts: SessionHosts,
  findHost: HostFinder): Pick<Workspaces, "route" | "locate" | "home"> {
  const hostOf = cloudSessionHosts(findHost, hosts)
  const resolve = async (ref: Pick<SessionLocation, "placementId" | "sessionId"> | PlacementId) => {
    const id = typeof ref === "string" ? ref : ref.placementId
    const record = await find(id)
    const hosted = record && typeof ref !== "string" ? await hostOf(record, ref) : undefined
    if (hosted) return { route: hosted, central: false, live: true, stopped: false }
    if (!record && typeof ref !== "string") {
      await shared.load()
      const route = shared.route(ref)
      if (route) return { route, central: false, live: true, stopped: false }
    }
    if (!record) throw new ServerError({ class: "not_found", message: `Placement ${id} is not in the catalog` })
    const stopped = isStoppedCloud(record.placement)
    const offlineMachine = record.route.remote && record.placement.kind !== "cloud" && !record.placement.reachable
    return { route: record.route, central: record.placement.kind === "cloud", live: !stopped && !offlineMachine, stopped }
  }
  return {
    route: async (ref) => {
      const home = await resolve(ref)
      if (home.stopped) throw workspaceStopped(home.route.workspaceId)
      return home.route
    },
    locate: async (id) => (await resolve(id)).route,
    home: resolve,
  }
}

function sharedAware(reads: ReturnType<typeof placementReads>, shared: SharedSessions, hosts: SessionHosts): Pick<Workspaces, "address" | "streamRoute" | "servedHere"> {
  return {
    address: {
      placementFor: (directory, workspaceId, sessionId) => {
        const owned = reads.address.placementFor(directory, workspaceId)
        if (owned) return owned
        return workspaceId && sessionId ? shared.find({ placementId: placementId(workspaceId), sessionId: asSessionId(sessionId) })?.ref : undefined
      },
    },
    servedHere: (id) => reads.recordOf(id)?.route.remote === false,
    streamRoute: (ref) => {
      const record = reads.recordOf(ref.placementId)
      if (!record) return shared.route(ref)
      if (record.placement.kind === "cloud" && !hosts.askedOrServedByWorkspace.has(sessionHostKey(ref))) return undefined
      return hostedRoute(record, hosts, ref) ?? (record.route.remote && record.placement.reachable ? record.route : undefined)
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

async function readCatalogs(local: Promise<BootstrapCatalog>, account: Promise<void> | undefined): Promise<BootstrapCatalog> {
  const [read, accountRead] = await Promise.allSettled([local, account])
  if (read.status === "rejected") throw read.reason
  if (accountRead.status === "rejected") {
    if (read.value.declaration.serverKind === "hosted") throw accountRead.reason
    console.error("The account's workspace catalog could not be read; the rail lists this machine's placements alone", { error: toAppError(accountRead.reason) })
  }
  return read.value
}

function accountReads(linked: () => LinkedCatalog | undefined, signed: boolean, load: () => Promise<unknown>): Pick<Workspaces, "accountProjects" | "accountProjectIds" | "accountKnows"> {
  return {
    accountProjects: async () => {
      if (!signed) return []
      await load()
      return linked()?.projects ?? []
    },
    accountProjectIds: (projectId) => linked()?.accountProjectIds(projectId) ?? [],
    accountKnows: (workspaceId) => linked()?.knowsWorkspace(workspaceId) ?? false,
  }
}

async function invalidatePlacementReads(queryClient: QueryClient, serverUrl: string) {
  await queryClient.invalidateQueries({ queryKey: queryKeys.placements(serverUrl) })
  await queryClient.invalidateQueries({ queryKey: queryKeys.projects(serverUrl) })
  await queryClient.invalidateQueries({ queryKey: queryKeys.cloud(serverUrl) })
}

export function createWorkspaces(transport: Transport, queryClient: QueryClient, account?: HostedAccount): Workspaces {
  const shared = createSharedSessions(account, transport.serverUrl, queryClient)
  const key = queryKeys.bootstrap(transport.serverUrl)
  const accountPlacements = account ? createAccountPlacements(account, transport.serverUrl, queryClient) : undefined
  const merged = mergedCatalog(queryClient, key, accountPlacements)
  const relearned = new Set<string>()
  const read = async () => bootstrapCatalog(await transport.json(BOOTSTRAP_PATH))
  const reread = () => queryClient.fetchQuery({ queryKey: key, queryFn: read, staleTime: 0 })
  const load = async () => {
    return merged.merge(await readCatalogs(queryClient.fetchQuery({ queryKey: key, queryFn: read, staleTime: Number.POSITIVE_INFINITY }), accountPlacements?.load()))
  }
  const reads = placementReads(() => merged.catalog()?.placements ?? [])
  const { recordOf, hosts } = reads
  const forgetSessionHosts = transport.onSessionHost(reads.learnSessionHost)
  return {
    shared,
    ...reads.published,
    onSessionHostLearned: reads.onSessionHostLearned,
    ...sharedAware(reads, shared, hosts),
    ...placementRoutes(async (id) => {
      await load()
      return recordOf(id)
    }, shared, hosts, transport.findSessionHost),
    learn: async (directory) => {
      if (relearned.has(directory)) return
      await reread()
      relearned.add(directory)
    },
    catalog: merged.catalog,
    load,
    refresh: async () => {
      relearned.clear()
      await readCatalogs(reread(), accountPlacements?.reread())
      await invalidatePlacementReads(queryClient, transport.serverUrl)
      await shared.refresh()
    },
    ...accountReads(merged.linked, accountPlacements !== undefined, load),
    dispose: () => { forgetSessionHosts(); shared.dispose(); merged.dispose() },
  }
}
