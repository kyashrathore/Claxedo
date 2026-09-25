import { isProviderUnavailable, type ProviderUnavailable } from "@claxedo/agent-runtime-contract"
import type { Plugin } from "@opencode-ai/plugin"

export type ProviderBindingBound = Readonly<{ baseURL: string; apiKey: string }>
export type ProviderBindingOverlay = ProviderBindingBound | ProviderUnavailable

type CatalogDraft = Parameters<Parameters<Plugin.Context["catalog"]["transform"]>[0]>[0]
type CatalogProvider = Parameters<Parameters<CatalogDraft["provider"]["update"]>[1]>[0]
type Location = { reload: () => Promise<void>; settle: () => Promise<void> }

class BindingPolicy {
  private overlays: Record<string, ProviderBindingOverlay> = {}
  private readonly locations = new Set<Location>()

  readonly plugin: Plugin.Plugin = {
    id: "claxedo-provider-binding",
    setup: (context) => this.setup(context),
  }

  private applyOverlays = (draft: CatalogDraft): void => {
    for (const [providerID, overlay] of Object.entries(this.overlays)) {
      draft.provider.update(providerID, (provider) => {
        if (isProviderUnavailable(overlay)) {
          provider.activation = "disabled"
          return
        }
        provider.settings = { ...provider.settings, baseURL: overlay.baseURL, apiKey: overlay.apiKey }
      })
    }
  }

  private holds(provider: Pick<CatalogProvider, "settings" | "activation">, overlay: ProviderBindingOverlay): boolean {
    return isProviderUnavailable(overlay)
      ? provider.activation === "disabled"
      : provider.settings?.baseURL === overlay.baseURL && provider.settings?.apiKey === overlay.apiKey
  }

  private async setup(context: Plugin.Context): Promise<() => Promise<void>> {
    let registration = await context.catalog.transform(this.applyOverlays)
    let settling: Promise<void> | undefined
    const settle = () => {
      if (settling) return settling
      settling = (async () => {
        for (const [providerID, overlay] of Object.entries(this.overlays)) {
          const row = (await context.catalog.provider.get({ providerID })).data
          if (row && !this.holds(row, overlay)) {
            await registration.dispose()
            registration = await context.catalog.transform(this.applyOverlays)
            return
          }
        }
      })().finally(() => { settling = undefined })
      return settling
    }
    const location = { reload: () => context.catalog.reload(), settle }
    this.locations.add(location)
    const subscription = this.watchUpdates(context, settle)
    return async () => {
      this.locations.delete(location)
      await subscription.close()
    }
  }

  private watchUpdates(context: Plugin.Context, settle: () => Promise<void>) {
    let open = true
    const events = context.event.subscribe()[Symbol.asyncIterator]()
    const reading = (async () => {
      for (let next = await events.next(); !next.done; next = await events.next()) {
        if (!open) return
        if (next.value.type === "catalog.updated") await settle()
      }
    })()
    void reading.catch((error: unknown) => console.error("OpenCode catalog watch failed", error))
    return {
      async close() {
        open = false
        await events.return?.()
        await reading.catch((error: unknown) => console.error("OpenCode catalog watch failed", error))
      },
    }
  }

  async apply(next: Record<string, ProviderBindingOverlay>): Promise<void> {
    this.overlays = next
    await Promise.all([...this.locations].map(async (location) => {
      await location.reload()
      await location.settle()
    }))
  }

  unavailableReason(providerID: string): string | undefined {
    const overlay = this.overlays[providerID]
    return overlay && isProviderUnavailable(overlay) ? overlay.reason : undefined
  }
}

export function createProviderBindingPolicy(): BindingPolicy {
  return new BindingPolicy()
}
