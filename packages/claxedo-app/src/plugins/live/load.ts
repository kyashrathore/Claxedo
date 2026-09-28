import type { PluginDefinition, PluginManifest } from "@claxedo/plugin-api"
import type { LivePlugin } from "@/server"
import type { PluginServerCalls } from "../api"
import { moduleDictionary } from "../dictionary"
import { frameDefinition } from "../frame/definition"
import type { FrameSource } from "../frame/open"
import type { PluginBuild, PluginOrigin } from "../model"
import { bundleDefinition, importBundle, NOT_A_PLUGIN } from "../bundle"

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
    hash,
    directory: row.directory,
    ...(row.builtAt && row.hash === hash ? { builtAt: row.builtAt } : {}),
    ...(row.lastError ? { buildError: row.lastError } : {}),
  }
}

function definitionOf(row: LiveRow, module: unknown): PluginDefinition {
  const definition = bundleDefinition(module)
  if (!definition) throw new LivePluginLoadError(row.id, NOT_A_PLUGIN)
  return definition
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
    definition: {
      activate: () => {
        throw error
      },
    },
  }
}

export async function loadLiveBuild(row: LiveRow, calls: PluginServerCalls): Promise<PluginBuild> {
  try {
    const { installPluginRuntime } = await import("./runtime")
    installPluginRuntime()
    const module = await importBundle(await calls.liveBundle(row.id, row.hash))
    const definition = definitionOf(row, module)
    const dictionary = moduleDictionary(module)
    return { manifest: manifestOf(row, definition), origin: originOf(row, row.hash), definition, ...(dictionary ? { dictionary } : {}) }
  } catch (error) {
    return failingBuild(row, row.hash, error)
  }
}

export async function loadFrameBuild(row: LiveRow, calls: PluginServerCalls, frame: Omit<FrameSource, "code">): Promise<PluginBuild> {
  try {
    const code = await calls.liveBundle(row.id, row.hash)
    return { manifest: rowManifest(row), origin: originOf(row, row.hash), definition: frameDefinition({ ...frame, code }) }
  } catch (error) {
    return failingBuild(row, row.hash, error)
  }
}
