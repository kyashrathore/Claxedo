import { isProviderUnavailable, type ProviderUnavailable } from "@claxedo/agent-runtime-contract"
import type { Plugin } from "@opencode-ai/plugin"
import { watchPluginEvents } from "./plugin-events.js"

export type ProviderBindingBound = Readonly<{ baseURL: string; apiKey: string }>
export type ProviderBindingPlan = Readonly<{ baseURL: string; plan: string }>
export type ProviderBindingOverlay = ProviderBindingBound | ProviderBindingPlan | ProviderUnavailable
export type ProviderBinding = Readonly<{
  overlays: Readonly<Record<string, ProviderBindingOverlay>>
  unbound: "engine" | "disabled"
}>

export const noProviderBinding: ProviderBinding = Object.freeze({ overlays: Object.freeze({}), unbound: "engine" })

type CatalogDraft = Parameters<Parameters<Plugin.Context["catalog"]["transform"]>[0]>[0]
type IntegrationDraft = Parameters<Parameters<Plugin.Context["integration"]["transform"]>[0]>[0]
type CatalogProvider = Parameters<Parameters<CatalogDraft["provider"]["update"]>[1]>[0]
type Registration = Awaited<ReturnType<Plugin.Context["catalog"]["transform"]>>
type Location = { reload: () => Promise<void>; settle: () => Promise<void> }
const catalogEvent = (type: string) => type === "catalog.updated" || type === "integration.updated"

type HeldTransform = { register: () => Promise<Registration>; holds: () => Promise<boolean> }

function holds(provider: Pick<CatalogProvider, "settings" | "activation">, overlay: ProviderBindingOverlay): boolean {
  return isProviderUnavailable(overlay)
    ? provider.activation === "disabled"
    : provider.activation !== "auto" && provider.settings?.baseURL === overlay.baseURL
      && ("plan" in overlay || provider.settings?.apiKey === overlay.apiKey)
}

class BindingPolicy {
  private binding: ProviderBinding = noProviderBinding
  private readonly locations = new Set<Location>()

  readonly plugin: Plugin.Plugin = {
    id: "claxedo-provider-binding",
    setup: (context) => this.setup(context),
  }

  private applyCatalog = (draft: CatalogDraft): void => {
    for (const [providerID, overlay] of Object.entries(this.binding.overlays)) {
      draft.provider.update(providerID, (provider) => {
        if (isProviderUnavailable(overlay)) {
          provider.activation = "disabled"
          return
        }
        if (provider.activation !== "disabled") provider.activation = "enabled"
        provider.settings = { ...provider.settings, baseURL: overlay.baseURL, ...("plan" in overlay ? {} : { apiKey: overlay.apiKey }) }
      })
    }
    if (this.binding.unbound !== "disabled") return
    for (const row of draft.provider.list()) {
      const providerID = String(row.provider.id)
      if (providerID in this.binding.overlays) continue
      draft.provider.update(providerID, (provider) => { provider.activation = "disabled" })
    }
  }

  private applyIntegrations = (draft: IntegrationDraft): void => {
    for (const providerID of Object.keys(this.binding.overlays)) {
      if (!draft.get(providerID)) continue
      draft.method.update({ integrationID: providerID, method: { type: "env", names: [] } })
    }
  }

  private async catalogHolds(context: Plugin.Context): Promise<boolean> {
    for (const [providerID, overlay] of Object.entries(this.binding.overlays)) {
      const row = (await context.catalog.provider.get({ providerID })).data
      if (row && !holds(row, overlay)) return false
    }
    if (this.binding.unbound !== "disabled") return true
    const available = (await context.catalog.provider.list()).data
    return available.every((row) => row.id in this.binding.overlays)
  }

  private async integrationsHold(context: Plugin.Context): Promise<boolean> {
    const rows = (await context.integration.list()).data
    for (const providerID of Object.keys(this.binding.overlays)) {
      const entry = rows.find((row) => row.id === providerID)
      if (entry?.methods.some((method) => method.type === "env" && method.names.length > 0)) return false
    }
    return true
  }

  private async setup(context: Plugin.Context): Promise<() => Promise<void>> {
    const transforms: HeldTransform[] = [
      { register: () => context.catalog.transform(this.applyCatalog), holds: () => this.catalogHolds(context) },
      { register: () => context.integration.transform(this.applyIntegrations), holds: () => this.integrationsHold(context) },
    ]
    const registrations = await Promise.all(transforms.map((transform) => transform.register()))
    let settling: Promise<void> | undefined
    const settle = () => {
      if (settling) return settling
      settling = (async () => {
        for (const [index, transform] of transforms.entries()) {
          if (await transform.holds()) continue
          await registrations[index]!.dispose()
          registrations[index] = await transform.register()
        }
      })().finally(() => { settling = undefined })
      return settling
    }
    const location = { reload: async () => { await context.integration.reload(); await context.catalog.reload() }, settle }
    this.locations.add(location)
    const subscription = watchPluginEvents(context, catalogEvent, settle, "OpenCode catalog watch failed")
    return async () => {
      this.locations.delete(location)
      await subscription.close()
    }
  }

  async apply(next: ProviderBinding): Promise<void> {
    this.binding = next
    await Promise.all([...this.locations].map(async (location) => {
      await location.reload()
      await location.settle()
    }))
  }

  unavailableReason(providerID: string): string | undefined {
    const overlay = this.binding.overlays[providerID]
    return overlay && isProviderUnavailable(overlay) ? overlay.reason : undefined
  }
}

export function createProviderBindingPolicy(): BindingPolicy {
  return new BindingPolicy()
}
