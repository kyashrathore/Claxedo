import { isProviderUnavailable, type ProviderProjection, type ProviderUnavailable } from "@claxedo/agent-runtime-contract"
import type { ResolvedCredentials } from "./projection"
import type { TurnActor } from "./session"

export function ownerMayUseMachineLogin(owner: TurnActor, options: {
  placement: "desktop" | "loopback" | "self-hosted" | "cloud"
  machineOwnerUserId: string
  canUseOwnLogin: boolean
}): boolean {
  return (owner.kind === "machine-owner" || owner.userId === options.machineOwnerUserId) &&
    options.canUseOwnLogin && (options.placement === "desktop" || options.placement === "loopback")
}

export function selectedProviderProjection(credentials: ResolvedCredentials, providerIds: readonly string[]): ProviderProjection | undefined {
  for (const id of providerIds) {
    const projection = credentials.providers[id]
    if (projection !== undefined) return projection
  }
  return undefined
}

export function providerPlaceholder(projection: ProviderProjection): { baseURL: string; apiKey: string } | ProviderUnavailable {
  return isProviderUnavailable(projection) ? projection :
    { baseURL: `${projection.baseUrl}${projection.apiPath ?? ""}`, apiKey: projection.placeholder }
}
