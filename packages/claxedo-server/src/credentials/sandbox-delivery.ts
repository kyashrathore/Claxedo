import type { SandboxBrokeredSecret } from "@claxedo/sandbox-manager"
import {
  nativeDeliveryDigest,
  nativeProviderDeliveries,
  nativeProviderSecrets,
  type SandboxSecretBrokering,
} from "@claxedo/server-core/credentials/native-delivery"

export type SandboxSecretPlan = {
  /** The whole desired set, or nothing when this deployment states none. */
  secrets?: SandboxBrokeredSecret[]
  /**
   * Identity of the set this deployment states, or absent when it states none.
   * A sandbox already holding this digest needs no driver call; any other value
   * — including none recorded — does.
   */
  digest?: string
}

/**
 * Every brokered secret a cloud sandbox of this deployment must hold: what the
 * caller stated for this ensure — a repository clone token, an MCP runtime
 * token — and the operator's active provider accounts, which no caller states
 * because they are this deployment's own selection rather than the request's.
 *
 * Always the whole desired set, never an addition. A driver reconciles the
 * workspace's secrets against exactly this list, so an account the operator
 * revoked or replaced is withdrawn from the provider edge by being absent from
 * it, and the runtime's next projection says the same. A revoked account is
 * still a marked account, so it keeps this deployment stating the set — which
 * is what withdraws the value it used to carry.
 *
 * Nothing at all — no stated secret and no marked account — answers with no set
 * and no digest, because an empty set tells the driver to withdraw what the
 * workspace holds, and a deployment with no accounts has no standing to say
 * that about secrets another caller installed. A driver that cannot broker is
 * answered the same way: its turns are refused through the projection, and
 * handing the manager a native secret it must fail closed on would leave the
 * workspace unprovisionable instead.
 */
export async function sandboxBrokeredSecrets(input: {
  stated?: readonly SandboxBrokeredSecret[]
  org?: string
  secretBrokering?: SandboxSecretBrokering
}): Promise<SandboxSecretPlan> {
  if (input.secretBrokering === "none") {
    return input.stated ? { secrets: [...input.stated] } : {}
  }
  const deliveries = await nativeProviderDeliveries(input.org ? { org: input.org } : {})
  if (!input.stated && deliveries.length === 0) return {}
  const delivered = nativeProviderSecrets(deliveries)
  const stated = input.stated ?? []
  const collision = delivered.find((secret) => stated.some((row) => row.name === secret.name))
  // Refused rather than merged: the Cloudflare Worker rejects a registration
  // set holding one name twice, so a collision would take down delivery of
  // every credential in it rather than the one that collided.
  if (collision) {
    throw new Error(`brokered secret name ${collision.name} is claimed by both the caller and a provider account`)
  }
  return {
    secrets: [...stated, ...delivered],
    digest: `${stated.map((row) => row.name).toSorted().join(" ")}\n${nativeDeliveryDigest(deliveries)}`,
  }
}
