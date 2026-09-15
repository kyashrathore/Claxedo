import type { Plugin } from "@opencode-ai/plugin"
import { isProviderUnavailable, type ProviderUnavailable } from "@claxedo/agent-sdk-runtime"

/** Where one provider's requests go and what they authenticate with. */
export type ProviderBindingBound = Readonly<{ baseURL: string; apiKey: string }>

/**
 * The engine's own field names for a bound provider, or the refusal that
 * replaces one.
 *
 * The refusal is the projection's own `ProviderUnavailable` and not a restated
 * copy: it means the same thing here as everywhere else — the operator selected
 * an account for this provider and it cannot be bound. Distinct from absent,
 * which keeps the engine's own auth and is the right answer when nobody chose
 * an account; leaving a withdrawn one absent instead runs the turn on whatever
 * login this machine holds.
 */
export type ProviderBindingOverlay = ProviderBindingBound | ProviderUnavailable

type CatalogDraft = Parameters<Parameters<Plugin.Context["catalog"]["transform"]>[0]>[0]
type CatalogProvider = Parameters<Parameters<CatalogDraft["provider"]["update"]>[1]>[0]

/**
 * The engine's provider routing for the accounts Claxedo has bound.
 *
 * The values are placeholders, not credentials: the base URL is a broker
 * binding and the key is a capability scoped to it, so the engine can reach the
 * vendor without ever holding the vendor's own secret. They go through the
 * catalog rather than the SDK's credential store for that reason — a stored
 * credential is a plaintext copy of the operator's key.
 *
 * The catalog transform reads `overlays` on every build, so a renewed
 * placeholder reaches the next request through `reload` alone.
 *
 * The engine applies catalog transforms in registration order and its own
 * config plugin registers after every config file has loaded, which lands it
 * behind this one: an `opencode.json` naming `apiKey` or `baseURL` for a bound
 * provider then overwrites the placeholder and the turn runs on the file's key,
 * not the selected account. So after every catalog rebuild the final rows are
 * read back, and a bound provider that lost its placeholder moves this
 * transform to the end of the order and rebuilds once more.
 */
export function createProviderBindingPolicy() {
  let overlays: Record<string, ProviderBindingOverlay> = {}
  const locations = new Set<{ reload: () => Promise<void>; settle: () => Promise<void> }>()

  const applyOverlays = (draft: CatalogDraft) => {
    for (const [providerID, overlay] of Object.entries(overlays)) {
      draft.provider.update(providerID, (provider) => {
        if (isProviderUnavailable(overlay)) {
          // Activation is the SDK's authoritative availability switch, so
          // the engine cannot fall back to its own auth for this provider.
          provider.activation = "disabled"
          return
        }
        provider.settings = { ...provider.settings, baseURL: overlay.baseURL, apiKey: overlay.apiKey }
      })
    }
  }

  const holds = (provider: Pick<CatalogProvider, "settings" | "activation">, overlay: ProviderBindingOverlay) =>
    isProviderUnavailable(overlay)
      ? provider.activation === "disabled"
      : provider.settings?.baseURL === overlay.baseURL && provider.settings?.apiKey === overlay.apiKey

  const plugin: Plugin.Plugin = {
    id: "claxedo-provider-binding",
    async setup(context) {
      let registration = await context.catalog.transform(applyOverlays)
      const overridden = async () => {
        for (const [providerID, overlay] of Object.entries(overlays)) {
          // A provider the catalog no longer lists cannot run a turn, so there
          // is nothing to hold.
          const row = await context.catalog.provider.get({ providerID }).then((output) => output.data, () => undefined)
          if (row && !holds(row, overlay)) return true
        }
        return false
      }
      let settling: Promise<void> | undefined
      const settle = () => {
        if (settling) return settling
        settling = (async () => {
          if (!(await overridden())) return
          await registration.dispose()
          registration = await context.catalog.transform(applyOverlays)
        })().finally(() => { settling = undefined })
        return settling
      }
      const location = { reload: () => context.catalog.reload(), settle }
      locations.add(location)

      let open = true
      const events = context.event.subscribe()[Symbol.asyncIterator]()
      void (async () => {
        for (let next = await events.next(); !next.done; next = await events.next()) {
          if (!open) return
          if (next.value.type === "catalog.updated") await settle()
        }
      })().catch(() => {})

      return async () => {
        open = false
        locations.delete(location)
        await events.return?.()
      }
    },
  }
  return {
    plugin,
    /** Replace the bound set; a provider absent from it runs on the engine's own auth. */
    async apply(next: Record<string, ProviderBindingOverlay>) {
      overlays = next
      // Failure is returned to the caller: never acknowledge a binding change
      // with a catalog still routing the previous one.
      await Promise.all([...locations].map(async (location) => {
        await location.reload()
        await location.settle()
      }))
    },
    /** Why a turn on this provider must be refused, or nothing when it may run. */
    unavailableReason(providerID: string): string | undefined {
      const overlay = overlays[providerID]
      return overlay && isProviderUnavailable(overlay) ? overlay.reason : undefined
    },
  }
}
