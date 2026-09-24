import type { PluginApi } from "./api"
import type { Disposer } from "./contributions"
import type { PluginManifest } from "./manifest"

export type PluginActivation = void | Disposer | Promise<void | Disposer>

export interface PluginDefinition {
  manifest?: PluginManifest
  activate(api: PluginApi): PluginActivation
}

export function definePlugin(definition: PluginDefinition): PluginDefinition {
  return definition
}
