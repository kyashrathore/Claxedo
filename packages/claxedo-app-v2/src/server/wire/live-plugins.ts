import { pluginManifestSchema } from "@claxedo/plugin-api"
import { ServerError } from "../errors"
import type { LivePlugin, LivePluginStatus } from "../live-plugin-types"

const STATUSES: ReadonlySet<string> = new Set<LivePluginStatus>(["building", "ready", "failed"])

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>
  throw new ServerError({ class: "internal", message: `${label} is not an object` })
}

function text(value: unknown, label: string): string {
  if (typeof value === "string") return value
  throw new ServerError({ class: "internal", message: `${label} is not text` })
}

function optionalText(value: unknown, label: string): string | null {
  return value === null ? null : text(value, label)
}

function status(value: unknown, label: string): LivePluginStatus {
  if (typeof value === "string" && STATUSES.has(value)) return value as LivePluginStatus
  throw new ServerError({ class: "internal", message: `${label} has an unknown status` })
}

function manifest(value: unknown, label: string) {
  if (value === null) return null
  const parsed = pluginManifestSchema.safeParse(value)
  if (parsed.success) return parsed.data
  throw new ServerError({ class: "internal", message: `${label} carries an invalid manifest: ${parsed.error.issues.map((issue) => issue.message).join("; ")}` })
}

function livePlugin(value: unknown, index: number): LivePlugin {
  const row = record(value, `Live plugin ${index}`)
  const label = `Live plugin ${typeof row.id === "string" ? row.id : index}`
  return {
    id: text(row.id, `${label} id`),
    name: optionalText(row.name, `${label} name`),
    version: optionalText(row.version, `${label} version`),
    directory: text(row.directory, `${label} folder`),
    status: status(row.status, label),
    hash: optionalText(row.hash, `${label} hash`),
    manifest: manifest(row.manifest, label),
    builtAt: optionalText(row.builtAt, `${label} build time`),
    lastError: optionalText(row.lastError, `${label} error`),
  }
}

export function parseLivePlugins(body: unknown): readonly LivePlugin[] {
  const plugins = record(body, "The live plugin list").plugins
  if (!Array.isArray(plugins)) throw new ServerError({ class: "internal", message: "The live plugin list has no plugins" })
  return plugins.map(livePlugin)
}

