/**
 * The forms `/agent-config/providers` answers in. A request that names no view
 * gets the full catalog; the app asks for the summary and then one provider at
 * a time, since opencode's full catalog is 2.3 MB and Pi's 45 KB.
 */
type CatalogProvider = { id: string; name: string; source?: string; refused?: string; models: Record<string, unknown> }

type Catalog<P extends CatalogProvider> = { all: P[]; connected: string[]; default: Record<string, string> }

export type ProviderCatalogView =
  | { kind: "full" }
  | { kind: "provider"; providerId: string }
  | { kind: "summary" }

export class ProviderCatalogViewError extends Error {
  constructor(
    readonly code: "provider_catalog_view_invalid" | "provider_catalog_provider_not_found",
    message: string,
    readonly status: 400 | 404,
  ) {
    super(message)
    this.name = "ProviderCatalogViewError"
  }
}

export function readProviderCatalogView(query: { provider?: string; view?: string }): ProviderCatalogView {
  if (query.provider !== undefined && query.view !== undefined) {
    throw new ProviderCatalogViewError("provider_catalog_view_invalid", "Ask for one provider or for a view, not both", 400)
  }
  if (query.provider !== undefined) {
    if (query.provider === "") throw new ProviderCatalogViewError("provider_catalog_view_invalid", "provider must name a provider", 400)
    return { kind: "provider", providerId: query.provider }
  }
  if (query.view === undefined || query.view === "full") return { kind: "full" }
  if (query.view === "summary") return { kind: "summary" }
  throw new ProviderCatalogViewError("provider_catalog_view_invalid", `Unknown provider catalog view "${query.view}"`, 400)
}

/**
 * `provider` answers that provider alone with every provider's `connected` and
 * `default`, which a caller merges over the summary. `summary` keeps connected
 * providers whole and names the rest, with the refusal of an account the
 * vendor turned away, and no models.
 */
export function projectProviderCatalog<P extends CatalogProvider>(catalog: Catalog<P>, view: ProviderCatalogView) {
  if (view.kind === "full") return catalog
  if (view.kind === "provider") {
    const provider = catalog.all.find((item) => item.id === view.providerId)
    if (!provider) {
      throw new ProviderCatalogViewError("provider_catalog_provider_not_found", `No provider "${view.providerId}" in this catalog`, 404)
    }
    return { ...catalog, all: [provider] }
  }
  const connected = new Set(catalog.connected)
  return {
    ...catalog,
    all: catalog.all.map((provider) =>
      connected.has(provider.id)
        ? provider
        : { id: provider.id, name: provider.name, ...(provider.source ? { source: provider.source } : {}), ...(provider.refused ? { refused: provider.refused } : {}), models: {} },
    ),
  }
}
