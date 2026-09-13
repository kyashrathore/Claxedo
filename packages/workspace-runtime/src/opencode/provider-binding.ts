import type { Plugin } from "@opencode-ai/plugin"

/** Where one provider's requests go and what they authenticate with. */
export type ProviderBindingBound = Readonly<{ baseURL: string; apiKey: string }>

/**
 * The operator selected an account for this provider and it cannot be bound.
 *
 * Distinct from absent: an absent provider keeps the engine's own auth, which
 * is the right answer when nobody chose an account. Leaving a withdrawn one
 * absent instead runs the turn on whatever login this machine holds, under an
 * identity the operator did not choose.
 */
export type ProviderBindingUnavailable = Readonly<{ unavailable: true; reason: string }>

export type ProviderBindingOverlay = ProviderBindingBound | ProviderBindingUnavailable

function isUnavailable(overlay: ProviderBindingOverlay): overlay is ProviderBindingUnavailable {
  return "unavailable" in overlay
}

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
            if (isUnavailable(overlay)) {
              // Activation is the SDK's authoritative availability switch, so
              // the engine cannot fall back to its own auth for this provider.
              provider.activation = "disabled"
              return
            }
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
    /** Why a turn on this provider must be refused, or nothing when it may run. */
    unavailableReason(providerID: string): string | undefined {
      const overlay = overlays[providerID]
      return overlay && isUnavailable(overlay) ? overlay.reason : undefined
    },
  }
}
