type ProviderCatalog = {
  all?: unknown[]
  connected?: unknown[]
  default?: Record<string, unknown>
}

export function providerCatalogView(input: unknown, providerId?: string) {
  const catalog = input && typeof input === "object" && !Array.isArray(input) ? input as ProviderCatalog : {}
  const connected = Array.isArray(catalog.connected)
    ? catalog.connected.filter((item): item is string => typeof item === "string")
    : []
  const defaults = catalog.default && typeof catalog.default === "object" && !Array.isArray(catalog.default)
    ? catalog.default
    : {}
  const providers = Array.isArray(catalog.all) ? catalog.all.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return []
    const provider = item as Record<string, unknown>
    if (typeof provider.id !== "string" || typeof provider.name !== "string") return []
    if (providerId && provider.id !== providerId) return []
    const models = provider.models && typeof provider.models === "object" && !Array.isArray(provider.models)
      ? provider.models as Record<string, unknown>
      : {}
    if (providerId) return [{ ...provider, models }]
    const configuredDefault = defaults[provider.id]
    const defaultModel = typeof configuredDefault === "string" ? configuredDefault : undefined
    return [{
      id: provider.id,
      name: provider.name,
      models: connected.includes(provider.id) && defaultModel && models[defaultModel]
        ? { [defaultModel]: models[defaultModel] }
        : {},
    }]
  }) : []
  return { all: providers, connected, default: defaults }
}
