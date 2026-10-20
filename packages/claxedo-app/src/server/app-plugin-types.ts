import type { PluginManifest } from "@claxedo/plugin-api"

export type EnabledAppPlugin = {
  readonly id: string
  readonly version: string
  readonly manifest: PluginManifest
  readonly appSha256: string
}

export type AppPluginInstall = EnabledAppPlugin & {
  readonly active: boolean
  readonly enabledForMe: boolean
  readonly orgDefault: boolean
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
  readonly uninstall: (pluginId: string) => Promise<void>
}
