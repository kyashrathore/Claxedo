import type { Account, ProviderSource } from "@/server"

export function canDisconnectProvider(source: ProviderSource | undefined): boolean {
  return source === "api" || source === "custom"
}

export function providerOwnKeys(provider: { readonly id: string; readonly source?: ProviderSource }, stored: readonly Account[]): readonly Account[] {
  if (!canDisconnectProvider(provider.source)) return []
  return stored.filter((account) => account.providerId === provider.id && account.hasSecret)
}
