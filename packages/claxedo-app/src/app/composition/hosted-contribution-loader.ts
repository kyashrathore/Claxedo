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
    const hosted = await import("../integrations/hosted-content-surfaces")
    return { contentSurfaces: hosted.hostedContentSurfaces }
  }
}
