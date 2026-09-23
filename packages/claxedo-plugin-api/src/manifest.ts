import { z } from "zod"

export const PLUGIN_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/
export const PLUGIN_ID_MAX_LENGTH = 64
export const PLUGIN_NAME_MAX_LENGTH = 80
export const PLUGIN_CAPABILITIES = ["tasks", "documents"] as const
export const PLUGIN_SERVER_ROUTE_PREFIX = "/api/claxedo/"

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const APP_ENTRY_PATTERN = /^\.\/[^\0]+\.(?:tsx|ts|jsx|js)$/
const OPERATION_PATTERN = /^[a-z][a-zA-Z0-9]*\.(?:\*|[a-z][a-zA-Z0-9]*)$/

export type PluginCapability = (typeof PLUGIN_CAPABILITIES)[number]

export const pluginServerAccessSchema = z
  .object({
    routes: z.array(z.string().startsWith(PLUGIN_SERVER_ROUTE_PREFIX)).default([]),
    operations: z.array(z.string().regex(OPERATION_PATTERN)).default([]),
  })
  .strict()

export const pluginManifestSchema = z
  .object({
    id: z.string().min(1).max(PLUGIN_ID_MAX_LENGTH).regex(PLUGIN_ID_PATTERN),
    name: z.string().trim().min(1).max(PLUGIN_NAME_MAX_LENGTH),
    version: z.string().regex(VERSION_PATTERN),
    app: z.string().regex(APP_ENTRY_PATTERN),
    requires: z.array(z.enum(PLUGIN_CAPABILITIES)).default([]),
    server: pluginServerAccessSchema.default({ routes: [], operations: [] }),
  })
  .strict()

export type PluginManifest = z.infer<typeof pluginManifestSchema>
export type PluginServerAccess = z.infer<typeof pluginServerAccessSchema>

export const pluginPackageSchema = z.object({ claxedo: pluginManifestSchema }).loose()

export class PluginManifestError extends Error {
  readonly issues: readonly string[]

  constructor(issues: readonly string[]) {
    super(`The plugin manifest is invalid: ${issues.join("; ")}`)
    this.name = "PluginManifestError"
    this.issues = issues
  }
}

export function readPluginManifest(packageJson: unknown): PluginManifest {
  const parsed = pluginPackageSchema.safeParse(packageJson)
  if (parsed.success) return parsed.data.claxedo
  throw new PluginManifestError(
    parsed.error.issues.map((issue) => `${issue.path.length ? issue.path.join(".") : "package.json"}: ${issue.message}`),
  )
}

export function pluginRouteAllowed(manifest: PluginManifest, path: string): boolean {
  return manifest.server.routes.some((prefix) => path === prefix || path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`))
}

export function pluginOperationAllowed(manifest: PluginManifest, operation: string): boolean {
  return manifest.server.operations.some((allowed) =>
    allowed.endsWith(".*") ? operation.startsWith(allowed.slice(0, -1)) : operation === allowed,
  )
}
