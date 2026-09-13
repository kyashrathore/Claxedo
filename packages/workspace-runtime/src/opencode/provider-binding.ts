import type { Plugin } from "@opencode-ai/plugin"

/** Where one provider's requests go and what they authenticate with. */
export type ProviderBindingOverlay = Readonly<{ baseURL: string; apiKey: string }>

/**
 * The engine's provider routing for the accounts Claxedo has bound.
 *
 * The values are placeholders, not credentials: the base URL is a broker
 * binding and the key is a capability scoped to it, so the engine can reach the
 * vendor without ever holding the vendor's own secret. They are applied through
 * the catalog rather than the SDK's credential store for that reason — a stored
 * credential is a plaintext copy this design exists to remove.
 *
 * Overlays are re-read on every catalog build, so a renewed placeholder reaches
 * the next request through `reload` alone.
 */
export function createProviderBindingPolicy() {
  let overlays: Record<string, ProviderBindingOverlay> = {}
  const reloads = new Set<() => Promise<void>>()
  const plugin: Plugin.Plugin = {
    id: "claxedo-provider-binding",
    async setup(context) {
      const reload = () => context.catalog.reload()
      reloads.add(reload)
      await context.catalog.transform((draft) => {
        for (const [providerID, overlay] of Object.entries(overlays)) {
          draft.provider.update(providerID, (provider) => {
            provider.settings = { ...provider.settings, baseURL: overlay.baseURL, apiKey: overlay.apiKey }
          })
        }
      })
      return () => { reloads.delete(reload) }
    },
  }
  return {
    plugin,
    /** Replace the bound set; a provider absent from it runs on the engine's own auth. */
    async apply(next: Record<string, ProviderBindingOverlay>) {
      overlays = next
      // Failure is returned to the caller: never acknowledge a binding change
      // with a catalog still routing the previous one.
      await Promise.all([...reloads].map((reload) => reload()))
    },
    current(): Readonly<Record<string, ProviderBindingOverlay>> {
      return overlays
    },
  }
}
