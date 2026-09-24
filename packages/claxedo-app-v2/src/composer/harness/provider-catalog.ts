import { createEffect, createMemo, createSignal, on, type Accessor } from "solid-js"
import type { HarnessConfigApi, ProviderCatalog } from "@/server"

type CatalogState = {
  readonly harness: string
  readonly catalog?: ProviderCatalog
  readonly error?: string
  readonly loading: boolean
  readonly fetched: boolean
}

/**
 * Loads the full model detail for every CONNECTED provider.
 *
 * The catalog is an index (default model per connected provider only), so
 * this is the single mechanism that turns "the picker shows one model per
 * provider" into "the picker shows the provider's whole model set". Failures
 * are per-provider and non-fatal: a provider whose detail fetch fails keeps
 * its index entry rather than emptying the list.
 */
export function hydrateConnectedProviderDetails(providers: {
  connected: () => Array<{ id: string }>
  load: (providerId: string) => Promise<void>
}) {
  return Promise.allSettled(providers.connected().map((provider) => providers.load(provider.id)))
}

/** The provider catalog a catalog harness picks its models from; an empty `harness` reads nothing. */
export function createProviderCatalog(input: { api: HarnessConfigApi; harness: Accessor<string> }) {
  const [state, setState] = createSignal<CatalogState>({ harness: "", loading: false, fetched: false })
  let generation = 0

  const refresh = async () => {
    const harness = input.harness()
    const current = ++generation
    if (!harness) {
      setState({ harness, loading: false, fetched: false })
      return
    }
    setState((previous) => ({ ...previous, harness, loading: true, error: undefined }))
    try {
      const catalog = await input.api.providers(harness)
      if (current === generation) setState({ harness, catalog, loading: false, fetched: true })
    } catch (error) {
      if (current !== generation) return
      setState({ harness, loading: false, fetched: true, error: error instanceof Error ? error.message : `Failed to load ${harness} models` })
    }
  }
  createEffect(on(input.harness, () => void refresh()))

  const load = async (providerId: string) => {
    const harness = input.harness()
    if (!harness) return
    const detail = await input.api.providers(harness, providerId)
    const provider = detail.all.find((item) => item.id === providerId)
    if (!provider) throw new Error(`Provider ${providerId} was not returned by the runtime`)
    setState((current) => {
      if (current.harness !== harness || !current.catalog) return current
      const all = current.catalog.all.map((item) => (item.id === providerId ? provider : item))
      return { ...current, catalog: { all, connected: detail.connected, default: detail.default } }
    })
  }

  const all = createMemo(() => new Map((state().catalog?.all ?? []).map((provider) => [provider.id, provider] as const)))
  const connected = createMemo(() => {
    const ids = new Set(state().catalog?.connected ?? [])
    return [...all().values()].filter((provider) => ids.has(provider.id))
  })

  return {
    resolved: () => state().fetched,
    loading: () => state().loading,
    error: () => state().error,
    refresh,
    load,
    queryKey: () => [state().harness] as const,
    all,
    default: () => state().catalog?.default ?? {},
    connected,
  }
}
