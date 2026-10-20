import type { PluginDefinition } from "@claxedo/plugin-api"
import type { Translations } from "@/i18n"
import { bundleDefinition, importBundle, NOT_A_PLUGIN } from "./bundle"
import { moduleDictionary } from "./dictionary"

export class PluginModuleError extends Error {
  constructor(readonly pluginId: string, message: string) {
    super(`${pluginId}: ${message}`)
    this.name = "PluginModuleError"
  }
}

export type InAppModule = { readonly definition: PluginDefinition; readonly dictionary?: Translations }

export async function importInApp(pluginId: string, code: string): Promise<InAppModule> {
  const { installPluginRuntime } = await import("./live/runtime")
  installPluginRuntime()
  const module = await importBundle(code)
  const definition = bundleDefinition(module)
  if (!definition) throw new PluginModuleError(pluginId, NOT_A_PLUGIN)
  const dictionary = moduleDictionary(module)
  return dictionary ? { definition, dictionary } : { definition }
}
