import type { FirstPartyPluginId, PluginManifest } from "@claxedo/plugin-api"

export type PluginBundle = { readonly manifest: PluginManifest; readonly hash: string; readonly code: string }

export type FirstPartyBundle = { readonly id: FirstPartyPluginId; readonly load: () => Promise<{ readonly default: PluginBundle }> }
