import type { PluginDefinition, PluginManifest } from "@claxedo/plugin-api"
import type { LivePlugin } from "@/server"
import type { PluginServerCalls } from "../api"
import { frameDefinition } from "../frame/definition"
import type { FrameHost } from "../frame/open"
import type { PluginBuild, PluginOrigin } from "../model"
import { throwingDefinition } from "../bundle"
import { importInApp } from "../in-app"

export class LivePluginLoadError extends Error {
  constructor(readonly pluginId: string, message: string) {
    super(`${pluginId}: ${message}`)
    this.name = "LivePluginLoadError"
  }
}

export type LiveRow = LivePlugin & { readonly hash: string }

export function rowManifest(row: LivePlugin): PluginManifest {
  if (row.manifest) return row.manifest
  return {
    id: row.id,
    name: row.name ?? row.id,
    version: row.version ?? "0.0.0",
    app: "./app.js",
    requires: [],
    server: { routes: [], operations: [] },
  }
}

function originOf(row: LivePlugin, hash: string): PluginOrigin {
  return {
    kind: "live",
    hash,
    directory: row.directory,
    ...(row.builtAt && row.hash === hash ? { builtAt: row.builtAt } : {}),
    ...(row.lastError ? { buildError: row.lastError } : {}),
  }
}

function manifestOf(row: LiveRow, definition: PluginDefinition): PluginManifest {
  const declared = definition.manifest
  if (declared && declared.id !== row.id) throw new LivePluginLoadError(row.id, `the bundle declares the id ${declared.id}`)
  return rowManifest(row)
}

export function failingBuild(row: LivePlugin, hash: string, error: unknown): PluginBuild {
  return {
    manifest: rowManifest(row),
    origin: originOf(row, hash),
    definition: throwingDefinition(error),
  }
}

export async function loadLiveBuild(row: LiveRow, calls: PluginServerCalls): Promise<PluginBuild> {
  try {
    const module = await importInApp(row.id, await calls.liveBundle(row.id, row.hash))
    return { manifest: manifestOf(row, module.definition), origin: originOf(row, row.hash), ...module }
  } catch (error) {
    return failingBuild(row, row.hash, error)
  }
}

export async function loadFrameBuild(row: LiveRow, calls: PluginServerCalls, frame: FrameHost): Promise<PluginBuild> {
  try {
    const code = await calls.liveBundle(row.id, row.hash)
    const manifest = rowManifest(row)
    return { manifest, origin: originOf(row, row.hash), definition: frameDefinition({ ...frame, code, backend: Boolean(manifest.backend) }) }
  } catch (error) {
    return failingBuild(row, row.hash, error)
  }
}
