import { PLUGIN_REQUIREMENTS, type PluginManifest, type PluginRequirement } from "./api"

const ID_PATTERN = /^[a-z][a-z0-9-]{1,63}$/

export class PluginManifestError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message)
    this.name = "PluginManifestError"
  }
}

function record(value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PluginManifestError(field, `${field} must be an object`)
  }
  return value as Readonly<Record<string, unknown>>
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new PluginManifestError(field, `${field} must be a non-empty string`)
  return value
}

function texts(value: unknown, field: string): readonly string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new PluginManifestError(field, `${field} must be a list of strings`)
  return value.map((entry, index) => text(entry, `${field}[${index}]`))
}

function requirement(value: string, field: string): PluginRequirement {
  const found = PLUGIN_REQUIREMENTS.find((known) => known === value)
  if (!found) throw new PluginManifestError(field, `${field} names an unknown capability: ${value}`)
  return found
}

function routePrefix(route: string, field: string): string {
  if (!route.startsWith("/")) throw new PluginManifestError(field, `${field} must start with /`)
  return route.replace(/\/+$/, "")
}

export function readManifest(block: unknown, version: string): PluginManifest {
  const fields = record(block, "claxedo")
  const id = text(fields.id, "claxedo.id")
  if (!ID_PATTERN.test(id)) throw new PluginManifestError("claxedo.id", `claxedo.id must match ${ID_PATTERN}`)
  return {
    id,
    name: text(fields.name, "claxedo.name"),
    version: text(version, "version"),
    requires: texts(fields.requires, "claxedo.requires").map((entry, index) => requirement(entry, `claxedo.requires[${index}]`)),
    routes: texts(fields.routes, "claxedo.routes").map((route, index) => routePrefix(route, `claxedo.routes[${index}]`)),
    operations: texts(fields.operations, "claxedo.operations"),
  }
}

export function readPackageManifest(pkg: unknown): PluginManifest {
  const fields = record(pkg, "package.json")
  return readManifest(fields.claxedo, text(fields.version, "version"))
}

export function requirementsMet(manifest: PluginManifest, features: Readonly<Record<PluginRequirement, boolean>>): boolean {
  return manifest.requires.every((key) => features[key])
}

export function routeAllowed(manifest: PluginManifest, path: string): boolean {
  const bare = path.split("?")[0] ?? path
  return manifest.routes.some((prefix) => bare === prefix || bare.startsWith(`${prefix}/`))
}

export function operationAllowed(manifest: PluginManifest, name: string): boolean {
  return manifest.operations.some((prefix) => name === prefix || name.startsWith(prefix.endsWith(".") ? prefix : `${prefix}.`))
}

export function entryId(pluginId: string, id: string): string {
  return `${pluginId}.${id}`
}

export function pluginIdOfEntry(id: string): string | undefined {
  const dot = id.indexOf(".")
  return dot > 0 ? id.slice(0, dot) : undefined
}
