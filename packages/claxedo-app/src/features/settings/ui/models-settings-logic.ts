export type ModelListItem = {
  id: string
  name: string
}

/** How many popular disconnected providers to hydrate for preview rows. */
export const MODELS_PREVIEW_DISCONNECTED_PROVIDERS = 4

export function modelsSettingsHydrationTargets(input: {
  connectedIds: string[]
  popularProviders: readonly string[]
  previewDisconnectedCount?: number
}) {
  const previewCount = input.previewDisconnectedCount ?? MODELS_PREVIEW_DISCONNECTED_PROVIDERS
  const connectedIds = [...input.connectedIds].sort()
  const preview = input.popularProviders
    .filter((id) => !connectedIds.includes(id))
    .slice(0, previewCount)
  return {
    key: `${connectedIds.join(",")}|${preview.join(",")}`,
    providerIds: [...connectedIds, ...preview],
  }
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
