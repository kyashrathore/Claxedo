import { createSignal } from "solid-js"
import { placementId, projectId, sessionId } from "./ids"
import type { RuntimeRoute } from "./transport"
import type { SessionLocation, SharedSessionRow } from "./types"
import { QueryObserver, type QueryClient } from "@tanstack/solid-query"
import type { HostedAccount } from "./account"
import { linkAccountCatalog, type LinkedCatalog } from "./account-link"
import { readArray } from "@claxedo/helpers/readers"
import { queryKeys } from "./query-keys"
import { accountCatalogFromWire, type AccountCatalog } from "./wire/account-catalog"
import type { BootstrapCatalog, PlacementRecord } from "./wire/placements"

export type AccountPlacements = {
  readonly key: readonly unknown[]
  readonly load: () => Promise<void>
  readonly reread: () => Promise<void>
  readonly link: (local: readonly PlacementRecord[]) => LinkedCatalog | undefined
}

export function createAccountPlacements(account: HostedAccount, serverUrl: string, queryClient: QueryClient): AccountPlacements {
  const key = queryKeys.accountCatalog(serverUrl)
  const read = async () => {
    const [provisioned, machines] = await Promise.all([account.run("workspace.list.provisioner"), account.run("workspace.list.machine")])
    return accountCatalogFromWire([...(readArray(provisioned, "workspaces") ?? []), ...(readArray(machines, "workspaces") ?? [])])
  }
  const fetch = async (staleTime: number) => { await queryClient.fetchQuery({ queryKey: key, queryFn: read, staleTime }) }
  let last: { local: readonly PlacementRecord[]; account: AccountCatalog; linked: LinkedCatalog } | undefined
  return {
    key,
    load: () => fetch(Number.POSITIVE_INFINITY),
    reread: () => fetch(0),
    link: (local) => {
      const catalog = queryClient.getQueryData<AccountCatalog>(key)
      if (!catalog) return undefined
      if (last?.local !== local || last.account !== catalog) last = { local, account: catalog, linked: linkAccountCatalog(local, catalog) }
      return last.linked
    },
  }
}

export function withAccountPlacements(local: BootstrapCatalog, linked: LinkedCatalog | undefined): BootstrapCatalog {
  return linked ? { ...local, placements: [...local.placements, ...linked.placements] } : local
}

export function createSharedSessions(account: HostedAccount | undefined, serverUrl: string, client: QueryClient) {
  const key = queryKeys.sharedSessions(serverUrl)
  const [revision, revise] = createSignal(0)
  const read = async (): Promise<readonly SharedSessionRow[]> => {
    if (!account) return []
    return (await account.run("session.shared.list")).sessions.map((row) => ({
      ref: { placementId: placementId(row.workspace_id), projectId: projectId(row.project_id), sessionId: sessionId(row.session_id) },
      title: row.title, ownerName: row.owner_name, level: row.level,
    }))
  }
  const dispose = new QueryObserver(client, { queryKey: key, queryFn: read, enabled: account !== undefined, staleTime: Number.POSITIVE_INFINITY, retry: false }).subscribe(() => revise((value) => value + 1))
  const list = () => {
    revision()
    return client.getQueryData<readonly SharedSessionRow[]>(key) ?? []
  }
  const find = (ref: Pick<SessionLocation, "placementId" | "sessionId">) => list().find((row) => row.ref.placementId === ref.placementId && row.ref.sessionId === ref.sessionId)
  const route = (ref: Pick<SessionLocation, "placementId" | "sessionId">): RuntimeRoute | undefined => {
    const row = find(ref)
    return row && { directory: `workspace:${row.ref.placementId}`, workspaceId: row.ref.placementId, remote: true, sharedSession: { sessionId: row.ref.sessionId, level: row.level } }
  }
  const fetch = async (staleTime: number) => { await client.fetchQuery({ queryKey: key, queryFn: read, staleTime }) }
  const error = () => { revision(); return client.getQueryState(key)?.error }
  return { enabled: account !== undefined, error, list, find, route, load: () => fetch(Number.POSITIVE_INFINITY), refresh: () => fetch(0), dispose }
}

export type SharedSessions = ReturnType<typeof createSharedSessions>
