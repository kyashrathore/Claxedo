import { isProviderUnavailable, turnAccountFor, type NativeSdkHarnessId, type ProviderProjection, type ProviderUnavailable, type TurnAccount } from "@claxedo/agent-runtime-contract"
import type { ResolvedCredentials } from "./projection"
import type { TurnActor } from "./session"

export type RuntimePlacement = "desktop" | "loopback" | "self-hosted" | "cloud"

export type MachineLoginPolicy = { placement: RuntimePlacement; machineOwnerUserId: string; canUseOwnLogin: boolean }

export function ownerMayUseMachineLogin(owner: TurnActor, options: MachineLoginPolicy): boolean {
  return (owner.kind === "machine-owner" || owner.userId === options.machineOwnerUserId) &&
    options.canUseOwnLogin && (options.placement === "desktop" || options.placement === "loopback")
}

export function selectedProviderProjection(credentials: ResolvedCredentials, providerIds: readonly string[]): ProviderProjection | undefined {
  const bound = providerIds.flatMap((id) => Object.hasOwn(credentials.providers, id) ? [credentials.providers[id]!] : [])
  return bound.find((projection) => !isProviderUnavailable(projection)) ?? bound[0]
}

export function selectedTurnAccount(harnessId: NativeSdkHarnessId, credentials: ResolvedCredentials, providerIds: readonly string[]): TurnAccount | undefined {
  return turnAccountFor(harnessId, selectedProviderProjection(credentials, providerIds))
}

export function providerPlaceholder(projection: ProviderProjection): { baseURL: string; apiKey: string } | ProviderUnavailable {
  return isProviderUnavailable(projection) ? projection :
    { baseURL: `${projection.baseUrl}${projection.apiPath ?? ""}`, apiKey: projection.placeholder }
}
