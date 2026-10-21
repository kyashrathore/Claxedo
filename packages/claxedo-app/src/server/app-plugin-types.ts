import type { PluginManifest } from "@claxedo/plugin-api"
import type { PluginHarness } from "./marketplace-types"

export type EnabledAppPlugin = {
  readonly id: string
  readonly version: string
  readonly manifest: PluginManifest
  readonly appSha256: string
}

export type AppPluginTools = {
  readonly label: string
  readonly names: readonly string[]
  readonly on: boolean
}

export type AppPluginInstall = EnabledAppPlugin & {
  readonly active: boolean
  readonly enabledForMe: boolean
  readonly orgDefault: boolean
  readonly tools?: AppPluginTools
}

export type AppPluginToolsChange = {
  readonly pluginId: string
  readonly on: boolean
  readonly revision: number
  readonly harnessIds: readonly PluginHarness[]
}

export type AppPluginListing = {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly latest: string
  readonly versions: readonly string[]
  readonly manifest: PluginManifest
  readonly available: boolean
}

export type AppPluginCatalog = {
  readonly canManage: boolean
  readonly registry: "listed" | "unavailable"
  readonly plugins: readonly AppPluginListing[]
}

export type AppPluginsApi = {
  readonly bundle: (pluginId: string, sha256: string) => Promise<Uint8Array<ArrayBuffer>>
  readonly backendFetch: (pluginId: string, path: string, init?: RequestInit) => Promise<Response>
  readonly install: (pluginId: string, version: string) => Promise<void>
  readonly update: (pluginId: string, version: string) => Promise<void>
  readonly setEnabled: (pluginId: string, enabled: boolean) => Promise<void>
  readonly setActiveForOrganization: (pluginId: string, active: boolean) => Promise<void>
  readonly setOrganizationDefault: (pluginId: string, enabled: boolean) => Promise<void>
  readonly setTools: (change: AppPluginToolsChange) => Promise<void>
  readonly uninstall: (pluginId: string) => Promise<void>
}
