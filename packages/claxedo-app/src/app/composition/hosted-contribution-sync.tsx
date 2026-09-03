import { createEffect, type Component } from "solid-js"
import { useAccountPort } from "@/platform/account/account-provider"
import { productContributions } from "./product-contributions"
import { configuredServiceContributions } from "./service-contributions"

/**
 * Keeps the product contributions in step with the account.
 *
 * This is the consumer that makes the hosted-contribution lifecycle real. The
 * port can remove a hosted set; only something that can SEE the account knows
 * when to. The account port is a Solid context, so the reader has to be a
 * component — the same shape as `TelemetryIdentityRecorder`, and mounted beside
 * it inside `AccountPortProvider`.
 *
 * It renders nothing. `productContributions()` throws when the entry never
 * configured it, deliberately: a contribution seam that degrades quietly is how
 * the hosted doorbell shipped inert with a green suite.
 *
 * The asymmetry between activating and removing lives in `followAccount`, which
 * is where it can be read next to the composition it applies to.
 */
export const HostedContributionSync: Component = () => {
  const account = useAccountPort()
  const contributions = productContributions()

  createEffect(() => {
    const state = account.state()
    contributions.followAccount(state)
    // A signed bootstrap is the only authority allowed to activate an optional
    // service. Account sign-out is nevertheless authoritative for immediate
    // removal, without waiting for another bootstrap request.
    if (state.status !== "signed") configuredServiceContributions()?.signOut()
  })

  return null
}
