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

export function bundleDefinition(module: unknown): PluginDefinition | undefined {
  const candidate = (module as { readonly default?: unknown }).default
  if (typeof candidate !== "object" || candidate === null) return undefined
  return typeof (candidate as PluginDefinition).activate === "function" ? (candidate as PluginDefinition) : undefined
}
