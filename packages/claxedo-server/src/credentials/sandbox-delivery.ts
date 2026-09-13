import type { SandboxBrokeredSecret } from "@claxedo/sandbox-manager"
import { nativeProviderDeliveries, nativeProviderSecrets } from "@claxedo/server-core/credentials/native-delivery"

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
 * Nothing at all — no stated secret and no marked account — answers `undefined`
 * rather than an empty set, because an empty set tells the driver to withdraw
 * what the workspace holds, and a deployment with no accounts has no standing
 * to say that about secrets another caller installed.
 */
export async function sandboxBrokeredSecrets(input: {
  stated?: readonly SandboxBrokeredSecret[]
  org?: string
}): Promise<SandboxBrokeredSecret[] | undefined> {
  const deliveries = await nativeProviderDeliveries(input.org)
  if (!input.stated && deliveries.length === 0) return undefined
  return [...(input.stated ?? []), ...nativeProviderSecrets(deliveries)]
}
