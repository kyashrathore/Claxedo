import type { ProviderUnavailable } from "@claxedo/agent-runtime-contract"
import type { Plugin } from "@opencode-ai/plugin"
import { isProviderUnavailable } from "@claxedo/agent-sdk-runtime"

export type ProviderBindingBound = Readonly<{ baseURL: string; apiKey: string }>

export type ProviderBindingOverlay = ProviderBindingBound | ProviderUnavailable

type CatalogDraft = Parameters<Parameters<Plugin.Context["catalog"]["transform"]>[0]>[0]
type CatalogProvider = Parameters<Parameters<CatalogDraft["provider"]["update"]>[1]>[0]

export function createProviderBindingPolicy() {
  let overlays: Record<string, ProviderBindingOverlay> = {}
  const locations = new Set<{ reload: () => Promise<void>; settle: () => Promise<void> }>()

  const applyOverlays = (draft: CatalogDraft) => {
    for (const [providerID, overlay] of Object.entries(overlays)) {
      draft.provider.update(providerID, (provider) => {
        if (isProviderUnavailable(overlay)) {

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
    
    async apply(next: Record<string, ProviderBindingOverlay>) {
      overlays = next

      await Promise.all([...locations].map(async (location) => {
        await location.reload()
        await location.settle()
      }))
    },
    
    unavailableReason(providerID: string): string | undefined {
      const overlay = overlays[providerID]
      return overlay && isProviderUnavailable(overlay) ? overlay.reason : undefined
    },
  }
}
