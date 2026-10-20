import type { PluginManifest } from "@claxedo/plugin-api"
import { ServerError } from "../errors"

export type ReadManifest = (value: unknown, label: string) => PluginManifest

export async function manifestReader(): Promise<ReadManifest> {
  const { pluginManifestSchema } = await import("@claxedo/plugin-api/manifest-schema")
  return (value, label) => {
    const parsed = pluginManifestSchema.safeParse(value)
    if (parsed.success) return parsed.data
    throw new ServerError({ class: "internal", message: `${label} carries an invalid manifest: ${parsed.error.issues.map((issue) => issue.message).join("; ")}` })
  }
}
