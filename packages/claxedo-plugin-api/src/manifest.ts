export const PLUGIN_NAME_MAX_LENGTH = 80

/** A server capability an app plugin requires, as a server's bootstrap reports it (`tasks`, `documents`). */
export const PLUGIN_CAPABILITY_PATTERN = /^[a-z][a-z0-9-]*$/
export const PLUGIN_CAPABILITY_MAX_LENGTH = 64
export const PLUGIN_SERVER_ROUTE_PREFIX = "/api/claxedo/"
export const PLUGIN_BACKEND_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const

/** Ids of the plugins the host ships as bundles; no live plugin may take one. */
export const FIRST_PARTY_PLUGIN_IDS = ["claxedo-tasks", "claxedo-documents"] as const

export type FirstPartyPluginId = (typeof FIRST_PARTY_PLUGIN_IDS)[number]

export function isFirstPartyPluginId(id: string): id is FirstPartyPluginId {
  return (FIRST_PARTY_PLUGIN_IDS as readonly string[]).includes(id)
}

export type PluginCapability = string

export function isPluginCapability(value: string): value is PluginCapability {
  return value.length <= PLUGIN_CAPABILITY_MAX_LENGTH && PLUGIN_CAPABILITY_PATTERN.test(value)
}

export type PluginServerAccess = {
  routes: string[]
  operations: string[]
}

/**
 * What a backend may ask the platform to do as its caller or for itself. A
 * platform call whose permission the manifest does not list is refused; the
 * install and enable prompts name each one.
 */
export const PLUGIN_PERMISSIONS = [
  "projects.read",
  "sessions.read",
  "sessions.start",
  "workspaces.cloud",
  "tools",
  "blobs",
  "events",
  "schedule",
  "links",
  "session-files",
] as const

export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number]

/** The agent tools a backend serves, under one tool group; `definitions` is the module that declares them. */
export type PluginBackendTools = {
  group: { id: string; label: string }
  definitions: string
}

export type PluginBackend = {
  entry: string
  objects: string[]
  outbound: string[]
  routes: string[]
  tools?: PluginBackendTools | undefined
}

export type PluginManifest = {
  id: string
  name: string
  version: string
  app: string
  requires: PluginCapability[]
  server: PluginServerAccess
  permissions?: PluginPermission[] | undefined
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
