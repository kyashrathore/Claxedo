export type ModelListItem = {
  id: string
  name: string
}

/** How many popular disconnected providers to hydrate for preview rows. */
export const MODELS_PREVIEW_DISCONNECTED_PROVIDERS = 4

/**
 * Above this size a harness catalog is the models.dev registry (~179 entries)
 * rather than a harness's own binding set. A catalog small enough to read is
 * shown whole; only the registry needs the connected-plus-popular preview.
 */
export const MODELS_FULL_CATALOG_LIMIT = 24

/**
 * Which providers Settings → Models shows for one (workspace, harness).
 *
 * Connected providers always; a small catalog contributes the rest of itself,
 * so a harness whose providers are not "popular" is not rendered as an empty
 * page.
 */
export function settingsModelCatalogProviders<T extends { id: string }>(input: {
  all: readonly T[]
  connectedIds: readonly string[]
  popularProviders: readonly string[]
  previewDisconnectedCount?: number
  fullCatalogLimit?: number
}): T[] {
  const connected = new Set(input.connectedIds)
  const limit = input.fullCatalogLimit ?? MODELS_FULL_CATALOG_LIMIT
  const previewCount = input.previewDisconnectedCount ?? MODELS_PREVIEW_DISCONNECTED_PROVIDERS
  const known = input.all.filter((provider) => connected.has(provider.id))
  if (input.all.length <= limit) {
    return [...known, ...input.all.filter((provider) => !connected.has(provider.id))]
  }
  const preview = input.popularProviders
    .filter((id) => !connected.has(id))
    .slice(0, previewCount)
    .flatMap((id) => input.all.filter((provider) => provider.id === id))
  return [...known, ...preview]
}

/** Preview count when a provider has many models (search finds the rest). */
export const MODELS_PREVIEW_COUNT = 10
/** Providers with more than this many models get inline search instead of listing all. */
export const MODELS_SEARCH_THRESHOLD = 10

export function providerUsesInlineSearch(modelCount: number, pageFilterActive: boolean) {
  return modelCount > MODELS_SEARCH_THRESHOLD && !pageFilterActive
}

/**
 * Which models to render for one provider group in Settings → Models.
 *
 * - Page search active: show everything the group filter already matched.
 * - Small provider (≤ threshold): show all models.
 * - Large provider, no query: first N only + hint to search.
 * - Large provider, with query: name/id substring match.
 */
export function visibleModelsForProvider<T extends ModelListItem>(input: {
  items: T[]
  query: string
  pageFilterActive: boolean
  previewCount?: number
  searchThreshold?: number
}): T[] {
  const previewCount = input.previewCount ?? MODELS_PREVIEW_COUNT
  const searchThreshold = input.searchThreshold ?? MODELS_SEARCH_THRESHOLD

  if (input.pageFilterActive) return input.items
  if (input.items.length <= searchThreshold) return input.items

  const q = input.query.trim().toLowerCase()
  if (q) {
    return input.items.filter(
      (item) => item.name.toLowerCase().includes(q) || item.id.toLowerCase().includes(q),
    )
  }
  return input.items.slice(0, previewCount)
}
