import type { QueryClient } from "@tanstack/solid-query"
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
