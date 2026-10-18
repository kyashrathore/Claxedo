export const PLUGIN_NAME_MAX_LENGTH = 80

export const PLUGIN_CAPABILITIES = ["tasks", "documents"] as const
export const PLUGIN_SERVER_ROUTE_PREFIX = "/api/claxedo/"
export const PLUGIN_BACKEND_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const

export type PluginCapability = (typeof PLUGIN_CAPABILITIES)[number]

export type PluginServerAccess = {
  routes: string[]
  operations: string[]
}

export type PluginBackend = {
  entry: string
  objects: string[]
  outbound: string[]
  routes: string[]
}

export type PluginManifest = {
  id: string
  name: string
  version: string
  app: string
  requires: PluginCapability[]
  server: PluginServerAccess
  backend?: PluginBackend | undefined
  statusHooks?: undefined
}

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
