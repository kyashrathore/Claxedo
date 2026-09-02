export type ProviderSource = "env" | "api" | "config" | "custom"

export function providerSourceTagKey(source?: ProviderSource): string {
  if (source === "env") return "settings.providers.tag.environment"
  if (source === "api") return "settings.providers.tag.apiKey"
  if (source === "config") return "settings.providers.tag.config"
  if (source === "custom") return "settings.providers.tag.custom"
  return "settings.providers.tag.other"
}

export function canDisconnectProvider(source?: ProviderSource): boolean {
  return source !== "env"
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
  deleteCredential: (providerId: string) => Promise<void>
  removeAuth: (providerId: string) => Promise<void>
  markDisconnected: (providerId: string) => void
  refresh: () => Promise<void>
  onSuccess: (name: string) => void
  onError: (message: string) => void
}

/**
 * Orchestrates Settings → Providers disconnect for one OpenCode row: drop the
 * stored credential, then remove the harness auth entry.
 */
export async function disconnectOpenCodeProvider(deps: DisconnectProviderDeps) {
  try {
    await deps.deleteCredential(deps.providerId).catch(() => undefined)
    await deps.removeAuth(deps.providerId)
    deps.markDisconnected(deps.providerId)
    deps.onSuccess(deps.name)
    await deps.refresh()
    // A provider list refetch can still report the row connected until the
    // engine instance reloads; re-apply the optimistic patch after refresh.
    deps.markDisconnected(deps.providerId)
  } catch (err: unknown) {
    deps.onError(err instanceof Error ? err.message : String(err))
  }
}
