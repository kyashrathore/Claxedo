import { z } from "zod"
import { PLUGIN_ID_MAX_LENGTH, PLUGIN_ID_PATTERN } from "./id"

export const PLUGIN_NAME_MAX_LENGTH = 80

const STATUS_HOOKS_REFUSAL = "status hook templates are honored only from Claxedo's bundled status-hooks plugin"
export const PLUGIN_CAPABILITIES = ["tasks", "documents"] as const
export const PLUGIN_SERVER_ROUTE_PREFIX = "/api/claxedo/"
export const PLUGIN_BACKEND_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const ENTRY_PATTERN = /^\.\/[^\0]+\.(?:tsx|ts|jsx|js)$/
const OPERATION_PATTERN = /^[a-z][a-zA-Z0-9]*\.(?:\*|[a-z][a-zA-Z0-9]*)$/
const BACKEND_OBJECT_PATTERN = /^[A-Z][A-Za-z0-9]*$/
const BACKEND_HOST_PATTERN = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/
const BACKEND_ROUTE_SEGMENT = String.raw`(?:[A-Za-z0-9_~-][A-Za-z0-9._~-]*|:[a-zA-Z][a-zA-Z0-9]*)`
const BACKEND_ROUTE_PATTERN = new RegExp(
  String.raw`^(?:${PLUGIN_BACKEND_METHODS.join("|")}) \/(?:\*|${BACKEND_ROUTE_SEGMENT}(?:\/${BACKEND_ROUTE_SEGMENT})*(?:\/\*)?)?$`,
)

export type PluginCapability = (typeof PLUGIN_CAPABILITIES)[number]

export const pluginServerAccessSchema = z
  .object({
    routes: z.array(z.string().startsWith(PLUGIN_SERVER_ROUTE_PREFIX)).default([]),
    operations: z.array(z.string().regex(OPERATION_PATTERN)).default([]),
  })
  .strict()

function distinct(values: readonly string[]) {
  return new Set(values).size === values.length
}

export const pluginBackendSchema = z
  .object({
    entry: z.string().regex(ENTRY_PATTERN),
    objects: z.array(z.string().regex(BACKEND_OBJECT_PATTERN)).refine(distinct, "object classes must be distinct").default([]),
    outbound: z.array(z.string().regex(BACKEND_HOST_PATTERN)).refine(distinct, "outbound hosts must be distinct").default([]),
    routes: z.array(z.string().regex(BACKEND_ROUTE_PATTERN)).min(1).refine(distinct, "routes must be distinct"),
  })
  .strict()

export const pluginManifestSchema = z
  .object({
    id: z.string().min(1).max(PLUGIN_ID_MAX_LENGTH).regex(PLUGIN_ID_PATTERN),
    name: z.string().trim().min(1).max(PLUGIN_NAME_MAX_LENGTH),
    version: z.string().regex(VERSION_PATTERN),
    app: z.string().regex(ENTRY_PATTERN),
    requires: z.array(z.enum(PLUGIN_CAPABILITIES)).default([]),
    server: pluginServerAccessSchema.default({ routes: [], operations: [] }),
    backend: pluginBackendSchema.optional(),
    // A template defines shell wrappers and rewrites files in the person's home,
    // so only the status-hooks package bundled with Claxedo may declare one;
    // the runtime reads that package directly, never through a plugin manifest.
    statusHooks: z.never({ error: STATUS_HOOKS_REFUSAL }).optional(),
  })
  .strict()

export type PluginManifest = z.infer<typeof pluginManifestSchema>
export type PluginServerAccess = z.infer<typeof pluginServerAccessSchema>
export type PluginBackend = z.infer<typeof pluginBackendSchema>

export const pluginPackageSchema = z.object({ claxedo: pluginManifestSchema }).loose()

export class PluginManifestError extends Error {
  readonly issues: readonly string[]

  constructor(issues: readonly string[]) {
    super(`The plugin manifest is invalid: ${issues.join("; ")}`)
    this.name = "PluginManifestError"
    this.issues = issues
  }
}

export class PluginStatusHooksRefusedError extends PluginManifestError {
  readonly code = "status_hooks_first_party_only"

  constructor(issues: readonly string[]) {
    super(issues)
    this.name = "PluginStatusHooksRefusedError"
  }
}

export function readPluginManifest(packageJson: unknown): PluginManifest {
  const parsed = pluginPackageSchema.safeParse(packageJson)
  if (parsed.success) return parsed.data.claxedo
  const issues = parsed.error.issues.map((issue) => `${issue.path.length ? issue.path.join(".") : "package.json"}: ${issue.message}`)
  if (parsed.error.issues.some((issue) => issue.path.join(".") === "claxedo.statusHooks")) {
    throw new PluginStatusHooksRefusedError(issues)
  }
  throw new PluginManifestError(issues)
}

export function pluginRouteAllowed(manifest: PluginManifest, path: string): boolean {
  return manifest.server.routes.some((prefix) => path === prefix || path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`))
}

export function pluginOperationAllowed(manifest: PluginManifest, operation: string): boolean {
  return manifest.server.operations.some((allowed) =>
    allowed.endsWith(".*") ? operation.startsWith(allowed.slice(0, -1)) : operation === allowed,
  )
}

function requestSegments(path: string): string[] | undefined {
  if (!path.startsWith("/")) return undefined
  const segments = path === "/" ? [] : path.slice(1).split("/")
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..") ? segments : undefined
}

function routeMatches(route: string, segments: readonly string[]) {
  const pattern = route === "/" ? [] : route.slice(1).split("/")
  for (const [index, part] of pattern.entries()) {
    if (part === "*") return segments.length > index
    const segment = segments[index]
    if (segment === undefined) return false
    if (!part.startsWith(":") && part !== segment) return false
  }
  return segments.length === pattern.length
}

/** Whether `method path` names a route the backend declares; `path` is the request's encoded pathname. */
export function pluginBackendRouteAllowed(backend: PluginBackend, method: string, path: string): boolean {
  const segments = requestSegments(path)
  if (!segments) return false
  return backend.routes.some((declared) => {
    const [declaredMethod, route = ""] = declared.split(" ")
    return declaredMethod === method && routeMatches(route, segments)
  })
}
