import type { PluginManifest } from "@claxedo/plugin-api"

export type {
  PluginApi,
  PluginManifest,
  PluginModule,
  PluginRequirement,
  ServerRequest,
  WorkbenchTab,
  WorkbenchTabStatus,
} from "@claxedo/plugin-api"

export type PluginOrigin = { readonly kind: "bundled" } | { readonly kind: "live"; readonly bundleUrl: string; readonly hash: string }

export type PluginFailure = { readonly version: string; readonly reason: string }

export type PluginState =
  | { readonly kind: "off" }
  | { readonly kind: "loading"; readonly version: string }
  | { readonly kind: "on"; readonly version: string; readonly lastFailure?: PluginFailure }
  | { readonly kind: "swapping"; readonly version: string; readonly to: string }
  | { readonly kind: "failed"; readonly reason: string; readonly version: string }

export type PluginSummary = {
  readonly manifest: PluginManifest
  readonly origin: PluginOrigin
  readonly enabled: boolean
  readonly requirementsMet: boolean
  readonly confirmed: boolean
  readonly state: PluginState
}
