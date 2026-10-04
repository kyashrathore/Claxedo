import type { Hono } from "hono"

/**
 * A product-selected control-plane route family.
 *
 * This is a composition seam, not feature discovery: a deployment entry passes
 * an explicit array, and an empty array means no feature implementation is
 * imported or mounted. The contract deliberately contains no Agent Plugins
 * types so disabled products remain dependency-free.
 */
export type ControlPlaneRouteContribution = {
  id: string
  path: string
  routes: Hono
}

export class ControlPlaneRouteContributionError extends Error {
  constructor(readonly code: "duplicate-contribution-id", message: string) {
    super(message)
    this.name = "ControlPlaneRouteContributionError"
  }
}

export function mountControlPlaneRouteContributions(input: {
  contributions: readonly ControlPlaneRouteContribution[]
  mount(contribution: ControlPlaneRouteContribution): void
}): void {
  const seen = new Set<string>()
  for (const contribution of input.contributions) {
    if (seen.has(contribution.id)) {
      throw new ControlPlaneRouteContributionError(
        "duplicate-contribution-id",
        `Control-plane route contribution ${contribution.id} was supplied more than once`,
      )
    }
    seen.add(contribution.id)
    input.mount(contribution)
  }
}
