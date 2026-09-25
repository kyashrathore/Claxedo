import type { PluginManifest } from "@claxedo/plugin-api"

export type LivePluginStatus = "building" | "ready" | "failed"

export type LivePlugin = {
  readonly id: string
  readonly name: string | null
  readonly version: string | null
  readonly directory: string
  readonly status: LivePluginStatus
  readonly hash: string | null
  readonly manifest: PluginManifest | null
  readonly builtAt: string | null
  readonly lastError: string | null
}
