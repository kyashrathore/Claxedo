import { isRecord } from "@claxedo/helpers/guards"
import { pluginManifestSchema } from "@claxedo/plugin-api"
import { ServerError } from "../errors"
import type { LivePlugin, LivePluginStatus } from "../live-plugin-types"

const STATUSES: ReadonlySet<string> = new Set<LivePluginStatus>(["building", "ready", "failed"])

function recordOrThrow(value: unknown, label: string): Record<string, unknown> {
  if (isRecord(value)) return value
  throw new ServerError({ class: "internal", message: `${label} is not an object` })
}

function textOrThrow(value: unknown, label: string): string {
  if (typeof value === "string") return value
  throw new ServerError({ class: "internal", message: `${label} is not text` })
}

function nullableTextOrThrow(value: unknown, label: string): string | null {
  return value === null ? null : textOrThrow(value, label)
}

function isLivePluginStatus(value: unknown): value is LivePluginStatus {
  return typeof value === "string" && STATUSES.has(value)
}

function statusOrThrow(value: unknown, label: string): LivePluginStatus {
  if (isLivePluginStatus(value)) return value
  throw new ServerError({ class: "internal", message: `${label} has an unknown status` })
}

function manifestOrThrow(value: unknown, label: string) {
  if (value === null) return null
  const parsed = pluginManifestSchema.safeParse(value)
  if (parsed.success) return parsed.data
  throw new ServerError({ class: "internal", message: `${label} carries an invalid manifest: ${parsed.error.issues.map((issue) => issue.message).join("; ")}` })
}

function livePlugin(value: unknown, index: number): LivePlugin {
  const row = recordOrThrow(value, `Live plugin ${index}`)
  const label = `Live plugin ${typeof row.id === "string" ? row.id : index}`
  return {
    id: textOrThrow(row.id, `${label} id`),
    name: nullableTextOrThrow(row.name, `${label} name`),
    version: nullableTextOrThrow(row.version, `${label} version`),
    directory: textOrThrow(row.directory, `${label} folder`),
    status: statusOrThrow(row.status, label),
    hash: nullableTextOrThrow(row.hash, `${label} hash`),
    manifest: manifestOrThrow(row.manifest, label),
    builtAt: nullableTextOrThrow(row.builtAt, `${label} build time`),
    lastError: nullableTextOrThrow(row.lastError, `${label} error`),
  }
}

export function parseLivePlugins(body: unknown): readonly LivePlugin[] {
  const plugins = recordOrThrow(body, "The live plugin list").plugins
  if (!Array.isArray(plugins)) throw new ServerError({ class: "internal", message: "The live plugin list has no plugins" })
  return plugins.map(livePlugin)
}

