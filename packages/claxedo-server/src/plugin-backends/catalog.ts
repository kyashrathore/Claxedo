import type { PluginIndexEntry } from "@claxedo/plugin-api/registry-index"
import { AppPluginRegistryError, fetchVerifiedIndex, type AppPluginRegistry } from "./registry"

export type AppPluginCatalogEntry = PluginIndexEntry & Readonly<{ available: boolean }>

export type AppPluginCatalog = Readonly<{ registry: "listed" | "unavailable"; plugins: readonly AppPluginCatalogEntry[] }>

/**
 * What the registry publishes, each entry marked `available` unless it ships
 * a backend this deployment cannot run. A registry that does not answer, or
 * answers an index that does not verify, is `unavailable`: the Marketplace
 * still lists the organization's installs, which come from its own rows.
 */
export async function readAppPluginCatalog(registry: AppPluginRegistry, runsBackends: boolean): Promise<AppPluginCatalog> {
  try {
    const index = await fetchVerifiedIndex(registry)
    return { registry: "listed", plugins: index.entries.map((entry) => ({ ...entry, available: runsBackends || !entry.manifest.backend })) }
  } catch (error) {
    if (!(error instanceof AppPluginRegistryError)) throw error
    console.warn(`[plugin-backends] the plugin registry index is unavailable: ${error.message}`)
    return { registry: "unavailable", plugins: [] }
  }
}
