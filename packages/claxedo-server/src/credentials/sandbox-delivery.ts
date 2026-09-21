import type { SandboxBrokeredSecret } from "@claxedo/sandbox-manager"
import {
  nativeDeliveryDigest,
  nativeDeliveryDigestEntries,
  nativeProviderDeliveries,
  nativeProviderSecrets,
  unreadableDeliveries,
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
 * it, and the runtime's next projection says the same.
 *
 * `installed` is the digest this workspace's sandbox already holds, which is
 * what separates "nothing to say" from "everything is gone".
 */
export async function sandboxBrokeredSecrets(input: {
  stated?: readonly SandboxBrokeredSecret[]
  org?: string
  secretBrokering?: SandboxSecretBrokering
  installed?: string
}): Promise<SandboxSecretPlan> {
  // A driver that cannot broker is told nothing: the manager fails closed on a
  // native secret it is handed, which would leave the workspace unprovisionable
  // instead of refusing the turn. Anything short of an explicit `"native"` —
  // an unstated or unrecognized capability — cannot broker.
  if (input.secretBrokering !== "native") {
    return input.stated ? { secrets: [...input.stated] } : {}
  }
  const deliveries = await nativeProviderDeliveries({
    ...(input.org ? { org: input.org } : {}),
    secretBrokering: input.secretBrokering,
  })
  // Nothing installed and no marked account: say nothing at all, because an
  // empty set tells the driver to withdraw what the workspace holds and secrets
  // another caller installed are not ours to remove. Once something of ours IS
  // installed, having no account left is a change, and the empty set is how the
  // last one reaches the provider edge as a withdrawal.
  if (!input.stated && deliveries.length === 0 && input.installed === undefined) return {}
  const unreadable = new Set(unreadableDeliveries(deliveries))
  // An account whose secret could not be read is not a withdrawn one. Stating a
  // set without it would write the revoked value over a credential nobody
  // revoked, so a sandbox that already holds a set keeps it and the next ensure
  // after the backend answers again reconciles. A caller that stated secrets of
  // its own is asking for a reconcile this round and gets one.
  //
  // Holding the whole set is only safe while nothing else changed: an account
  // revoked while another one's backend is down stays installed at the provider
  // edge for as long as that backend stays down, which is the one direction
  // this must never defer. So the installed entries are compared against what
  // resolved now, and anything stranded that is not merely unreadable forces
  // the reconcile through — the unreadable account loses its secret for a round
  // rather than the revoked one keeping its own.
  if (unreadable.size > 0 && input.installed !== undefined && !input.stated) {
    const current = new Set(nativeDeliveryDigestEntries(nativeDeliveryDigest(deliveries)).map((row) => row.entry))
    const stranded = nativeDeliveryDigestEntries(nativePart(input.installed))
      .filter((row) => !current.has(row.entry) && !unreadable.has(row.credentialId))
    if (stranded.length === 0) return { digest: input.installed }
  }
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

/**
 * The provider half of a plan digest. The caller's own stated names lead it,
 * separated by the one byte a brokered secret name cannot contain.
 */
function nativePart(digest: string) {
  return digest.slice(digest.indexOf("\n") + 1)
}
