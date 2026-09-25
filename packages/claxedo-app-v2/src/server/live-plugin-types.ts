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

export type LivePluginSourceFile = { readonly path: string; readonly size: number }

export type LivePluginSource = { readonly files: readonly LivePluginSourceFile[]; readonly truncated: boolean }

export type LivePluginSourceText = { readonly path: string; readonly size: number; readonly text: string }
