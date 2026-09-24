import type { PluginDefinition, PluginManifest } from "@claxedo/plugin-api"
import type { LivePlugin, PluginServerCalls } from "../api"
import { frameDefinition } from "../frame/definition"
import type { FrameSource } from "../frame/open"
import type { PluginBuild, PluginOrigin } from "../model"

export class LivePluginLoadError extends Error {
  constructor(readonly pluginId: string, message: string) {
    super(`${pluginId}: ${message}`)
    this.name = "LivePluginLoadError"
  }
}

export type LiveRow = LivePlugin & { readonly hash: string }

export function rowManifest(row: LivePlugin): PluginManifest {
  return {
    id: row.id,
    name: row.name ?? row.id,
    version: row.version ?? "0.0.0",
    app: "./app.js",
    requires: [],
    server: { routes: [], operations: [] },
  }
}

function originOf(row: LiveRow): PluginOrigin {
  return row.lastError ? { kind: "live", hash: row.hash, buildError: row.lastError } : { kind: "live", hash: row.hash }
}

function definitionOf(row: LiveRow, module: unknown): PluginDefinition {
  const candidate = (module as { readonly default?: unknown }).default
  if (typeof candidate === "object" && candidate !== null && typeof (candidate as PluginDefinition).activate === "function") {
    return candidate as PluginDefinition
  }
  throw new LivePluginLoadError(row.id, "the bundle's default export is not definePlugin(...)")
}

async function importBundle(code: string): Promise<unknown> {
  const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }))
  try {
    return await import(/* @vite-ignore */ url)
  } finally {
    URL.revokeObjectURL(url)
  }
}

function manifestOf(row: LiveRow, definition: PluginDefinition): PluginManifest {
  const declared = definition.manifest
  if (!declared) return rowManifest(row)
  if (declared.id !== row.id) throw new LivePluginLoadError(row.id, `the bundle declares the id ${declared.id}`)
  return declared
}

export function failingBuild(row: LivePlugin, hash: string, error: unknown): PluginBuild {
  return {
    manifest: rowManifest(row),
    origin: { kind: "live", hash, ...(row.lastError ? { buildError: row.lastError } : {}) },
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
    const definition = definitionOf(row, await importBundle(await calls.liveBundle(row.id, row.hash)))
    return { manifest: manifestOf(row, definition), origin: originOf(row), definition }
  } catch (error) {
    return failingBuild(row, row.hash, error)
  }
}

export async function loadFrameBuild(row: LiveRow, calls: PluginServerCalls, frame: Omit<FrameSource, "code">): Promise<PluginBuild> {
  try {
    const code = await calls.liveBundle(row.id, row.hash)
    return { manifest: rowManifest(row), origin: originOf(row), definition: frameDefinition({ ...frame, code }) }
  } catch (error) {
    return failingBuild(row, row.hash, error)
  }
}
