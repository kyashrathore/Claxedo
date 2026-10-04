import { isRecord } from "@claxedo/helpers/guards"
import { readField } from "@claxedo/helpers/readers"
import type { PluginDefinition } from "@claxedo/plugin-api"

export const NOT_A_PLUGIN = "the bundle's default export is not definePlugin(...)"

export async function importBundle(code: string): Promise<unknown> {
  const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }))
  try {
    return await import(/* @vite-ignore */ url)
  } finally {
    URL.revokeObjectURL(url)
  }
}

function isPluginDefinition(value: unknown): value is PluginDefinition {
  return isRecord(value) && typeof value.activate === "function"
}

export function bundleDefinition(module: unknown): PluginDefinition | undefined {
  const candidate = readField(module, "default")
  return isPluginDefinition(candidate) ? candidate : undefined
}
