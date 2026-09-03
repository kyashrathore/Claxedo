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

/**
 * Drop one harness auth entry, on the machine serving one scope.
 *
 * The entry belongs to (that machine, that harness), the same triple the
 * catalog and the auth read carry, so both ride the request: a DELETE without
 * them names no entry in particular.
 */
export async function removeProviderAuthEntry(input: {
  serverUrl: string
  providerId: string
  harness: string
  directory?: string
  request: (url: URL, init?: RequestInit) => Promise<Response>
}) {
  const url = new URL(`/auth/${encodeURIComponent(input.providerId)}`, input.serverUrl)
  url.searchParams.set("harness", input.harness)
  if (input.directory) url.searchParams.set("directory", input.directory)
  const res = await input.request(url, { method: "DELETE", headers: { Accept: "application/json" } })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(text || `Request failed: ${res.status}`)
  }
  await res.text().catch(() => undefined)
}

/**
 * The workspace runtime's provider-configuration route.
 *
 * Provider configuration is per (workspace, harness) and lives with the runtime
 * that serves the workspace, so this write is dispatched by the same
 * `?harness=`/`?directory=` pair the catalog read carries. There is no central
 * provider config to write.
 */
const PROVIDER_CONFIG_PATH = "/api/wr/provider-config"

/**
 * Disable one provider in the configuration of the runtime serving one scope.
 *
 * Returns the resulting disabled list so a caller can reconcile a cached
 * catalog without a second read.
 */
export async function setProviderDisabled(input: {
  serverUrl: string
  providerId: string
  harness: string
  directory?: string
  disabled: boolean
  request: (url: URL, init?: RequestInit) => Promise<Response>
}): Promise<string[]> {
  const url = new URL(PROVIDER_CONFIG_PATH, input.serverUrl)
  url.searchParams.set("harness", input.harness)
  if (input.directory) url.searchParams.set("directory", input.directory)
  const res = await input.request(url, {
    method: "PATCH",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ provider: input.providerId, disabled: input.disabled }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(text || `Request failed: ${res.status}`)
  }
  const body = await res.json().catch(() => undefined) as { disabled_providers?: unknown } | undefined
  return Array.isArray(body?.disabled_providers)
    ? body.disabled_providers.filter((item): item is string => typeof item === "string")
    : []
}

/**
 * Whether a row is connected by a config DECLARATION rather than a credential.
 *
 * `env` and `api` rows exist because a key does; `custom` rows are contributed
 * by a plugin at runtime. Only a `config` row exists because the harness config
 * names it, and the only way to disconnect that is to disable it there.
 */
export function providerDisconnectsThroughConfig(source?: ProviderSource): boolean {
  return source === "config"
}

export type DisconnectProviderDeps = {
  providerId: string
  name: string
  /** How the row is connected; decides which disconnect it needs. */
  source?: ProviderSource
  deleteCredential: (providerId: string) => Promise<void>
  removeAuth: (providerId: string) => Promise<void>
  disableInConfig: (providerId: string) => Promise<void>
  markDisconnected: (providerId: string) => void
  refresh: () => Promise<void>
  onSuccess: (name: string) => void
  onError: (message: string) => void
}

/**
 * Orchestrates a Settings → Providers disconnect for one row.
 *
 * A credential-backed row drops the stored credential, then the harness auth
 * entry. A config-declared row has neither, so it is disabled in the scoped
 * provider configuration instead — the same (workspace, harness) the catalog is
 * read for, so the refetch below reflects the write.
 */
export async function disconnectProvider(deps: DisconnectProviderDeps) {
  try {
    if (providerDisconnectsThroughConfig(deps.source)) {
      await deps.disableInConfig(deps.providerId)
    } else {
      await deps.deleteCredential(deps.providerId).catch(() => undefined)
      await deps.removeAuth(deps.providerId)
    }
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
