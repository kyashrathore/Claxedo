import { useQuery } from "@tanstack/solid-query"
import type { ModelReference } from "@claxedo/tasks"
import { useServer, type CatalogProvider } from "@/server"

export type CloudModelChoice = { readonly model: ModelReference; readonly provider: string; readonly name: string }

export type CloudModelOffer = { readonly choices: readonly CloudModelChoice[]; readonly planUnlisted: boolean }

export type CloudCatalogModels =
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly message: string }
  | ({ readonly kind: "ready" } & CloudModelOffer)

type Catalog = { readonly all: readonly CatalogProvider[]; readonly connected: readonly string[] }

const isPlanReached = (provider: CatalogProvider) => provider.source === "harness" && provider.harness === "codex"

export function cloudModelOffer(catalog: Catalog): CloudModelOffer {
  const connected = catalog.all.filter((provider) => catalog.connected.includes(provider.id))
  const choices = connected.flatMap((provider) =>
    Object.values(provider.models)
      .filter((model) => model.connected !== false)
      .map((model) => ({ model: { providerID: provider.id, modelID: model.id }, provider: provider.name, name: model.name })),
  )
  return { choices, planUnlisted: connected.some((provider) => isPlanReached(provider) && Object.keys(provider.models).length === 0) }
}

export function useCloudCatalogModels(harness: () => string): () => CloudCatalogModels {
  const server = useServer()
  const catalog = useQuery(() => server.queries.providerCatalogs.catalog(harness()))
  return () => {
    if (catalog.error) return { kind: "failed", message: catalog.error.message }
    if (!catalog.data) return { kind: "loading" }
    return { kind: "ready", ...cloudModelOffer(catalog.data) }
  }
}
