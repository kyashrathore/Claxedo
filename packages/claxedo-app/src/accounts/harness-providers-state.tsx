import { createEffect } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { createProviderCatalog } from "@/composer"
import { toAppError, useServer, type CatalogProvider, type PlacementId } from "@/server"
import { ClaxedoIcon as Icon, showToast } from "@/ui"
import { createCatalogAccountSources } from "./catalog-account-sources"
import { useAccountsText } from "./i18n"
import { createKeyActions } from "./key-actions"
import { providerOwnKeys } from "./model"
import type { KeyRowStore } from "./view/key-row"

export function createHarnessProviders(harness: () => string, placementId?: () => PlacementId | undefined) {
  const server = useServer()
  const catalog = createProviderCatalog({ server, harness, ...(placementId ? { placementId } : {}), eager: true })
  const detailed = new Set<string>()
  createEffect(() => {
    const unsourced = catalog.connected().filter((provider) => provider.source === undefined && !detailed.has(provider.id))
    for (const provider of unsourced) detailed.add(provider.id)
    if (unsourced.length > 0) void Promise.allSettled(unsourced.map((provider) => catalog.load(provider.id)))
  })
  const t = useAccountsText()
  const sources = createCatalogAccountSources(harness, () => catalog.refresh())
  const stored = useQuery(() => server.queries.accounts.list())
  const { activity, liveChecks, run, verify } = createKeyActions<"checking">(server.accounts.check)
  const keys: KeyRowStore = { activity, liveChecks, check: (id) => void run("checking", id, () => verify(id)) }
  const disconnect = async (provider: CatalogProvider) => {
    try {
      await server.providerConnect.disconnect(harness(), provider)
      showToast({
        variant: "success",
        icon: <Icon name="circle-check" />,
        title: t("provider.disconnect.toast.disconnected.title", { provider: provider.name }),
        description: t("provider.disconnect.toast.disconnected.description", { provider: provider.name }),
      })
      await catalog.refresh()
    } catch (error) {
      showToast({ title: t("common.requestFailed"), description: toAppError(error).message })
    }
  }
  return { harness, catalog, sources, disconnect, keys, ownKeys: (provider: CatalogProvider) => providerOwnKeys(provider, stored.data ?? []), connected: () => catalog.connected().length > 0, machine: () => server.capabilities()?.servingMachine?.name ?? "" }
}

export type HarnessProviders = ReturnType<typeof createHarnessProviders>
