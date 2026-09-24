import type { ProviderSource } from "@/server"
import type { AccountsKey } from "./i18n"

const FULL_CATALOG_LIMIT = 24

const POPULAR_PROVIDERS: readonly string[] = ["opencode", "opencode-go", "anthropic", "github-copilot", "openai", "google", "openrouter", "vercel"]

export const MODELS_PREVIEW_COUNT = 10

const MODELS_SEARCH_THRESHOLD = 10

export function catalogNeedsSearch(count: number): boolean {
  return count > FULL_CATALOG_LIMIT
}

export function visibleModels<T extends { readonly id: string; readonly name: string }>(items: readonly T[], query: string, pageFilterActive: boolean): readonly T[] {
  if (pageFilterActive || items.length <= MODELS_SEARCH_THRESHOLD) return items
  const needle = query.trim().toLowerCase()
  if (!needle) return items.slice(0, MODELS_PREVIEW_COUNT)
  return items.filter((item) => item.name.toLowerCase().includes(needle) || item.id.toLowerCase().includes(needle))
}

export function usesInlineSearch(modelCount: number, pageFilterActive: boolean): boolean {
  return modelCount > MODELS_SEARCH_THRESHOLD && !pageFilterActive
}

export function catalogProviders<T extends { readonly id: string; readonly name: string }>(all: readonly T[], connectedIds: readonly string[], query: string, popular: readonly string[] = POPULAR_PROVIDERS): T[] {
  const needle = query.trim().toLowerCase()
  if (needle) return all.filter((provider) => provider.id.toLowerCase().includes(needle) || provider.name.toLowerCase().includes(needle))
  const connected = new Set(connectedIds)
  const first = all.filter((provider) => connected.has(provider.id))
  if (all.length <= FULL_CATALOG_LIMIT) return [...first, ...all.filter((provider) => !connected.has(provider.id))]
  return [...first, ...all.filter((provider) => !connected.has(provider.id) && popular.includes(provider.id))]
}

const PROVIDER_NOTES: readonly { readonly match: (id: string) => boolean; readonly key: AccountsKey }[] = [
  { match: (id) => id === "opencode", key: "dialog.provider.opencode.note" },
  { match: (id) => id === "opencode-go", key: "dialog.provider.opencodeGo.tagline" },
  { match: (id) => id === "anthropic", key: "dialog.provider.anthropic.note" },
  { match: (id) => id.startsWith("github-copilot"), key: "dialog.provider.copilot.note" },
  { match: (id) => id === "openai", key: "dialog.provider.openai.note" },
  { match: (id) => id === "google", key: "dialog.provider.google.note" },
  { match: (id) => id === "openrouter", key: "dialog.provider.openrouter.note" },
  { match: (id) => id === "vercel", key: "dialog.provider.vercel.note" },
]

export function providerNote(id: string): AccountsKey | undefined {
  return PROVIDER_NOTES.find((item) => item.match(id))?.key
}

export function providerSourceTag(source: ProviderSource | undefined): AccountsKey {
  if (source === "env") return "settings.providers.tag.environment"
  if (source === "api") return "settings.providers.tag.apiKey"
  if (source === "config") return "settings.providers.tag.config"
  if (source === "custom") return "settings.providers.tag.custom"
  return "settings.providers.tag.other"
}

export function canDisconnectProvider(source: ProviderSource | undefined): boolean {
  return source === "api" || source === "custom"
}
