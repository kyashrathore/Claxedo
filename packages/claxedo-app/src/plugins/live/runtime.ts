import * as pluginApi from "@claxedo/plugin-api"
import { PLUGIN_RUNTIME_GLOBAL, type PluginRuntime } from "@claxedo/plugin-api"
import * as solid from "solid-js"
import * as solidStore from "solid-js/store"
import * as solidWeb from "solid-js/web"
import * as kit from "@/ui"

export function installPluginRuntime(): void {
  const runtime: PluginRuntime = {
    "solid-js": solid,
    "solid-js/web": solidWeb,
    "solid-js/store": solidStore,
    "@claxedo/plugin-api": pluginApi,
    "@claxedo/app/ui": kit,
  }
  Object.assign(globalThis, { [PLUGIN_RUNTIME_GLOBAL]: runtime })
}
