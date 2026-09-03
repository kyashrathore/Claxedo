/**
 * The hosted product's only value edge to its implementation set.
 *
 * This deliberately lives outside `product-contributions.ts`: the local entry
 * uses that registry contract, and a dynamic import inside the shared module is
 * still an emitted chunk even when its runtime branch never executes.
 */
export const hostedServiceContributionLoaders = {
  documents: async () => {
    const module = await import("../integrations/documents-content-surfaces")
    return { contentSurfaces: module.documentsContentSurfaces }
  },
} as const
