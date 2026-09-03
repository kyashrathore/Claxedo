import type { HostedContributionLoader } from "./product-contributions"

/**
 * The hosted product's only value edge to its implementation set.
 *
 * This deliberately lives outside `product-contributions.ts`: the local entry
 * uses that registry contract, and a dynamic import inside the shared module is
 * still an emitted chunk even when its runtime branch never executes.
 */
export function hostedContributionLoader(): HostedContributionLoader {
  return async () => {
    const [workgraph, documents] = await Promise.all([
      import("../integrations/hosted-content-surfaces"),
      import("../integrations/documents-content-surfaces"),
    ])
    return { contentSurfaces: [...workgraph.workGraphContentSurfaces, ...documents.documentsContentSurfaces] }
  }
}

export const hostedServiceContributionLoaders = {
  workgraph: async () => {
    const module = await import("../integrations/hosted-content-surfaces")
    return { contentSurfaces: module.workGraphContentSurfaces }
  },
  documents: async () => {
    const module = await import("../integrations/documents-content-surfaces")
    return { contentSurfaces: module.documentsContentSurfaces }
  },
} as const
