import { isDeepStrictEqual } from "node:util"
import { isProviderUnavailable, type ProviderProjection } from "@claxedo/agent-runtime-contract"
import { selectedProviderProjection } from "./credentials"
import type { StartInput } from "./session"

function providerLaunch(projection: ProviderProjection | undefined) {
  if (!projection || isProviderUnavailable(projection)) return projection
  const { expiresAt: _expiresAt, account, ...binding } = projection
  return { ...binding, ...(account ? { account: { credentialId: account.credentialId, providerId: account.providerId } } : {}) }
}

function launchConfig(input: StartInput, providerIds?: readonly string[]) {
  const { leaseGeneration: _lease, providers, ...credentials } = input.credentials
  const { notApplied: _notApplied, ...projection } = input.projection
  const selected = providerIds ? providerLaunch(selectedProviderProjection(input.credentials, providerIds))
    : Object.fromEntries(Object.entries(providers).map(([id, binding]) => [id, providerLaunch(binding)]))
  return { credentials: { ...credentials, providers: selected }, projection }
}

export function launchConfigChanged(previous: StartInput, next: StartInput, providerIds?: readonly string[]): boolean {
  return !isDeepStrictEqual(launchConfig(previous, providerIds), launchConfig(next, providerIds))
}
