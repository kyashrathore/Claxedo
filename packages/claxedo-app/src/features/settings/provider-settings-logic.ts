export type ProviderConfigSlice = {
  provider?: Record<string, { npm?: string; models?: Record<string, unknown> } | undefined>
  disabled_providers?: string[]
}

export type ProviderSource = "env" | "api" | "config" | "custom"

export type ProviderDisconnectStrategy = "disabled_providers" | "auth_remove"

/** Config-file openai-compatible providers (e.g. Cline pass) disconnect via disabled_providers. */
export function isOpenAiCompatibleConfigProvider(
  config: Pick<ProviderConfigSlice, "provider"> | undefined,
  providerId: string,
): boolean {
  const provider = config?.provider?.[providerId]
  if (!provider) return false
  if (provider.npm !== "@ai-sdk/openai-compatible") return false
  if (!provider.models || Object.keys(provider.models).length === 0) return false
  return true
}

export function resolveProviderDisconnectStrategy(input: {
  source?: ProviderSource
  config: ProviderConfigSlice | undefined
  providerId: string
}): ProviderDisconnectStrategy {
  if (input.source === "config" || input.source === "custom") return "disabled_providers"
  if (isOpenAiCompatibleConfigProvider(input.config, input.providerId)) return "disabled_providers"
  return "auth_remove"
}

export function nextDisabledProviders(before: readonly string[] | undefined, providerId: string): string[] {
  const list = before ? [...before] : []
  return list.includes(providerId) ? list : [...list, providerId]
}

export function providerSourceTagKey(input: {
  source?: ProviderSource
  config: ProviderConfigSlice | undefined
  providerId: string
}): string {
  const source = input.source
  if (source === "env") return "settings.providers.tag.environment"
  if (source === "api") return "settings.providers.tag.apiKey"
  if (source === "config") {
    return isOpenAiCompatibleConfigProvider(input.config, input.providerId)
      ? "settings.providers.tag.custom"
      : "settings.providers.tag.config"
  }
  if (source === "custom") return "settings.providers.tag.custom"
  return "settings.providers.tag.other"
}

export function canDisconnectProvider(source?: ProviderSource): boolean {
  return source !== "env"
}

export function patchDisabledProvidersBody(disabledProviders: readonly string[]) {
  return JSON.stringify({ config: { disabled_providers: [...disabledProviders] } })
}

export async function patchGlobalDisabledProviders(input: {
  serverUrl: string
  disabledProviders: readonly string[]
  request: (url: URL, init?: RequestInit) => Promise<Response>
}) {
  const res = await input.request(new URL("/global/config", input.serverUrl), {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: patchDisabledProvidersBody(input.disabledProviders),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(text || `Request failed: ${res.status}`)
  }
  await res.text().catch(() => undefined)
}

export async function removeProviderAuthEntry(input: {
  serverUrl: string
  providerId: string
  request: (url: URL, init?: RequestInit) => Promise<Response>
}) {
  const res = await input.request(
    new URL(`/auth/${encodeURIComponent(input.providerId)}`, input.serverUrl),
    { method: "DELETE", headers: { Accept: "application/json" } },
  )
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(text || `Request failed: ${res.status}`)
  }
  await res.text().catch(() => undefined)
}

export type DisconnectProviderDeps = {
  providerId: string
  name: string
  source?: ProviderSource
  config: Pick<ProviderConfigSlice, "provider" | "disabled_providers">
  serverUrl: string
  deleteCredential: (providerId: string) => Promise<void>
  patchDisabledProviders: (disabledProviders: string[]) => Promise<void>
  removeAuth: (providerId: string) => Promise<void>
  markDisconnected: (providerId: string) => void
  refresh: () => Promise<void>
  onSuccess: (name: string) => void
  onError: (message: string) => void
}

/** Orchestrates Settings → Providers disconnect for one OpenCode row. */
export async function disconnectOpenCodeProvider(deps: DisconnectProviderDeps) {
  try {
    await deps.deleteCredential(deps.providerId).catch(() => undefined)

    const strategy = resolveProviderDisconnectStrategy({
      source: deps.source,
      config: deps.config,
      providerId: deps.providerId,
    })

    if (strategy === "disabled_providers") {
      const before = deps.config.disabled_providers ?? []
      const next = nextDisabledProviders(before, deps.providerId)
      deps.markDisconnected(deps.providerId)
      await deps.patchDisabledProviders(next)
      deps.onSuccess(deps.name)
      await deps.refresh()
      // Provider list refetch can still report the row connected until the
      // engine instance reloads; re-apply the optimistic patch after refresh.
      deps.markDisconnected(deps.providerId)
      return
    }

    await deps.removeAuth(deps.providerId)
    deps.markDisconnected(deps.providerId)
    deps.onSuccess(deps.name)
    await deps.refresh()
    deps.markDisconnected(deps.providerId)
  } catch (err: unknown) {
    deps.onError(err instanceof Error ? err.message : String(err))
  }
}
