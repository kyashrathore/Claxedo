import { hashKey, QueryObserver, type QueryClient } from "@tanstack/solid-query"
import { createSignal, type Accessor } from "solid-js"
import type { LinkedCatalog } from "./account-link"
import { withAccountPlacements, type AccountPlacements } from "./account-placements"
import { toAppError } from "./errors"
import { queryKeys } from "./query-keys"
import type { BootstrapCatalog } from "./wire/placements"

type Catalog = "local" | "account"

function placementCatalogKey(serverUrl: string, catalog: Catalog) {
  return catalog === "local" ? queryKeys.bootstrap(serverUrl) : queryKeys.accountCatalog(serverUrl)
}

function observeCatalog(queryClient: QueryClient, serverUrl: string, catalog: Catalog): { readonly revision: Accessor<number>; readonly dispose: () => void } {
  const [revision, setRevision] = createSignal(0)
  let seen: unknown
  const dispose = new QueryObserver(queryClient, { queryKey: placementCatalogKey(serverUrl, catalog), enabled: false }).subscribe((result) => {
    if (result.data === seen) return
    seen = result.data
    setRevision((value) => value + 1)
  })
  return { revision, dispose }
}

function rereadWhenInvalidated(queryClient: QueryClient, rereads: ReadonlyMap<string, () => Promise<unknown>>): () => void {
  return queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== "updated" || event.action.type !== "invalidate") return
    const reread = rereads.get(event.query.queryHash)
    if (!reread) return
    void reread().catch((error: unknown) => console.warn("An invalidated workspace catalog could not be read again", { queryHash: event.query.queryHash, error: toAppError(error) }))
  })
}

export function mergedCatalog(queryClient: QueryClient, serverUrl: string, reread: () => Promise<unknown>, accountPlacements: AccountPlacements | undefined) {
  const catalogs: readonly Catalog[] = accountPlacements ? ["local", "account"] : ["local"]
  const watched = catalogs.map((catalog) => observeCatalog(queryClient, serverUrl, catalog))
  const rereads = new Map<string, () => Promise<unknown>>([[hashKey(placementCatalogKey(serverUrl, "local")), reread]])
  if (accountPlacements) rereads.set(hashKey(placementCatalogKey(serverUrl, "account")), accountPlacements.reread)
  const forgetInvalidations = rereadWhenInvalidated(queryClient, rereads)
  let last: { local: BootstrapCatalog; linked: LinkedCatalog | undefined; merged: BootstrapCatalog } | undefined
  const merge = (current: BootstrapCatalog) => {
    const linked = accountPlacements?.link(current.placements)
    if (last?.local !== current || last.linked !== linked) last = { local: current, linked, merged: withAccountPlacements(current, linked) }
    return last.merged
  }
  const read = () => queryClient.getQueryData<BootstrapCatalog>(placementCatalogKey(serverUrl, "local"))
  const catalog = () => {
    for (const watch of watched) watch.revision()
    const current = read()
    return current && merge(current)
  }
  const linked = () => {
    const current = read()
    return current && accountPlacements?.link(current.placements)
  }
  return {
    merge,
    linked,
    published: {
      catalog,
      complete: () => catalog() !== undefined && (accountPlacements === undefined || linked() !== undefined),
    },
    dispose: () => {
      forgetInvalidations()
      watched.forEach((watch) => watch.dispose())
    },
  }
}
