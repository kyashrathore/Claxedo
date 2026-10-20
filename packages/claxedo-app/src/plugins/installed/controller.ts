import type { EnabledAppPlugin } from "@/server"
import type { PluginHost } from "../host"
import { installedOriginOf, type PluginBuild } from "../model"

export type InstalledReconciler = { readonly reconcile: (plugins: readonly EnabledAppPlugin[]) => void }

export function createInstalledReconciler(host: Pick<PluginHost, "plugins" | "put" | "drop">, loadBuild: (plugin: EnabledAppPlugin) => Promise<PluginBuild>): InstalledReconciler {
  const requested = new Map<string, string>()

  const load = async (plugin: EnabledAppPlugin) => {
    requested.set(plugin.id, plugin.appSha256)
    const build = await loadBuild(plugin)
    if (requested.get(plugin.id) === plugin.appSha256) host.put(build)
  }

  return {
    reconcile: (plugins) => {
      const listed = new Set(plugins.map((plugin) => plugin.id))
      for (const pluginId of [...requested.keys()]) if (!listed.has(pluginId)) requested.delete(pluginId)
      for (const plugin of host.plugins()) {
        if (!installedOriginOf(plugin) || listed.has(plugin.id)) continue
        requested.delete(plugin.id)
        host.drop(plugin.id)
      }
      for (const plugin of plugins) {
        const current = host.plugins().find((candidate) => candidate.id === plugin.id)
        if (current && installedOriginOf(current)?.hash === plugin.appSha256) continue
        if (requested.get(plugin.id) === plugin.appSha256) continue
        void load(plugin)
      }
    },
  }
}
