import { builtInProviderRow } from "./built-in-destinations"
import { isSubscriptionKind } from "./secret-material"
import type { CredentialKind } from "./types"

/**
 * Where an account can actually be spent.
 *
 * `local` is always true: the loopback broker holds the value in this process
 * and every stored account reaches it. `cloud` is the narrower question, and it
 * is answered here rather than inferred from "we have it stored", because a
 * provider edge attaches one header per secret and a destination that also
 * needs a fixed companion header cannot be delivered through one at all.
 *
 * Asked of the row's shape with no secret: an operator-declared provider is
 * reached only where its org's declarations are read, which is delivery, not
 * this list.
 */
export type CredentialReach = { local: true; cloud: boolean; reason?: string }

export function credentialReach(row: { provider_id: string; kind: CredentialKind }): CredentialReach {
  const destination = builtInProviderRow(row.provider_id)?.({ token: "", form: isSubscriptionKind(row.kind) ? "subscription" : "api-key" })
  if (!destination) return { local: true, cloud: false, reason: "no_destination" }
  if (destination.injection.headers) {
    return { local: true, cloud: false, reason: "native_delivery_needs_companion_header" }
  }
  return { local: true, cloud: true }
}
