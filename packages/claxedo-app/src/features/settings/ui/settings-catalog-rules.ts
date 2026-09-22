export type ModelListItem = {
  id: string
  name: string
}

/**
 * Above this size a catalog is the models.dev registry (~203 entries) rather
 * than a harness's own binding set. A catalog small enough to read is shown
 * whole; only the registry needs the popular-plus-connected view.
 */
export const FULL_CATALOG_LIMIT = 24

/**
 * Which providers a catalog harness shows before the user searches, for both
 * the accounts list and the models list.
 *
 * Connected first, then the popular ones, because the answer to "which of
 * these am I using" has to be readable without scrolling past 180 rows the
 * user never connected. Everything else is reachable by search alone.
 */
export function settingsCatalogProviders<T extends { id: string; name: string }>(input: {
  all: readonly T[]
  connectedIds: readonly string[]
  popularProviders: readonly string[]
  query?: string
  fullCatalogLimit?: number
}): T[] {
  const query = input.query?.trim().toLowerCase()
  if (query) {
    return input.all.filter(
      (provider) => provider.id.toLowerCase().includes(query) || provider.name.toLowerCase().includes(query),
    )
  }
  const connected = new Set(input.connectedIds)
  if (input.all.length <= (input.fullCatalogLimit ?? FULL_CATALOG_LIMIT)) {
    return [...input.all.filter((p) => connected.has(p.id)), ...input.all.filter((p) => !connected.has(p.id))]
  }
  const popular = new Set(input.popularProviders)
  return [
    ...input.all.filter((provider) => connected.has(provider.id)),
    ...input.all.filter((provider) => !connected.has(provider.id) && popular.has(provider.id)),
  ]
}

/** Whether a catalog is large enough that the unsearched view is a subset. */
export function catalogNeedsSearch(count: number, fullCatalogLimit = FULL_CATALOG_LIMIT) {
  return count > fullCatalogLimit
}

/**
 * The key a group's enable/disable answer is stored under.
 *
 * A catalog harness's group is a real provider, so its id is the key. A
 * harness that reports one list across many vendors carries one provider id
 * for all of them, so the vendor prefix of its model ids is the only thing
 * that tells one group from another.
 */
export function modelGroupKey(input: { providerId: string; sampleModelId?: string }) {
  const slash = input.sampleModelId?.indexOf("/") ?? -1
  return slash > 0 ? `${input.providerId}/${input.sampleModelId!.slice(0, slash)}` : input.providerId
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
}): T[] {
  if (input.pageFilterActive) return input.items
  if (input.items.length <= MODELS_SEARCH_THRESHOLD) return input.items

  const q = input.query.trim().toLowerCase()
  if (q) {
    return input.items.filter(
      (item) => item.name.toLowerCase().includes(q) || item.id.toLowerCase().includes(q),
    )
  }
  return input.items.slice(0, MODELS_PREVIEW_COUNT)
}
