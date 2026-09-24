export const PLUGIN_RUNTIME_GLOBAL = "__claxedoPluginRuntime" as const

export const PLUGIN_RUNTIME_MODULES = [
  "solid-js",
  "solid-js/web",
  "solid-js/store",
  "@claxedo/plugin-api",
  "@claxedo/app-v2/ui",
] as const

export type PluginRuntimeModule = (typeof PLUGIN_RUNTIME_MODULES)[number]

export type PluginRuntime = Record<PluginRuntimeModule, object>

export function isPluginRuntimeModule(specifier: string): specifier is PluginRuntimeModule {
  return (PLUGIN_RUNTIME_MODULES as readonly string[]).includes(specifier)
}
