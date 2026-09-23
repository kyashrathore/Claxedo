import type { PluginRequirement } from "./api"

export const LIVE_PLUGINS_ROUTE = "/api/claxedo/plugins"

export type LivePluginBuild = { readonly kind: "ok" } | { readonly kind: "failed"; readonly error: string }

export type LivePluginListing = {
  readonly id: string
  readonly name: string
  readonly version: string
  readonly hash: string
  readonly bundleUrl: string
  readonly manifest: {
    readonly requires: readonly PluginRequirement[]
    readonly routes: readonly string[]
    readonly operations: readonly string[]
  }
  readonly build: LivePluginBuild
}

export type LivePluginList = { readonly plugins: readonly LivePluginListing[] }

export const PLUGIN_RUNTIME_GLOBAL = "claxedoPluginRuntime"

export const PLUGIN_RUNTIME_MODULES = ["solid-js", "solid-js/web", "solid-js/store", "@claxedo/plugin-api"] as const

export type PluginRuntimeModule = (typeof PLUGIN_RUNTIME_MODULES)[number]

export type PluginRuntimeGlobal = {
  readonly version: 1
  readonly modules: Readonly<Record<PluginRuntimeModule, unknown>>
}
