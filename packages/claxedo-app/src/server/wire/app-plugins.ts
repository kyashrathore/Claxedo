import { isRecord, isStringList } from "@claxedo/helpers/guards"
import type { AppPluginCatalog, AppPluginInstall, AppPluginListing, EnabledAppPlugin } from "../app-plugin-types"
import { contractMismatch } from "../errors"
import { manifestReader, type ReadManifest } from "./plugin-manifest"

const SHA256 = /^[0-9a-f]{64}$/

function enabledFrom(value: unknown, readManifest: ReadManifest): EnabledAppPlugin {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.version !== "string" || !isRecord(value.app)) throw contractMismatch("app plugin")
  const sha256 = value.app.sha256
  if (typeof sha256 !== "string" || !SHA256.test(sha256)) throw contractMismatch("app plugin bundle")
  return { id: value.id, version: value.version, manifest: readManifest(value.manifest, `App plugin ${value.id}`), appSha256: sha256 }
}

function installFrom(value: unknown, readManifest: ReadManifest): AppPluginInstall {
  const plugin = enabledFrom(value, readManifest)
  if (!isRecord(value) || typeof value.active !== "boolean" || typeof value.enabledForMe !== "boolean" || typeof value.orgDefault !== "boolean") {
    throw contractMismatch("app plugin install")
  }
  return { ...plugin, active: value.active, enabledForMe: value.enabledForMe, orgDefault: value.orgDefault }
}

function listingFrom(value: unknown, readManifest: ReadManifest): AppPluginListing {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string" || typeof value.latest !== "string") throw contractMismatch("app plugin listing")
  if (!isStringList(value.versions) || typeof value.available !== "boolean") throw contractMismatch("app plugin listing")
  return {
    id: value.id,
    name: value.name,
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    latest: value.latest,
    versions: value.versions,
    manifest: readManifest(value.manifest, `App plugin ${value.id}`),
    available: value.available,
  }
}

function listOf(body: unknown): readonly unknown[] {
  if (!Array.isArray(body)) throw contractMismatch("app plugin list")
  return body
}

export async function enabledAppPluginsFromWire(body: unknown): Promise<readonly EnabledAppPlugin[]> {
  const readManifest = await manifestReader()
  return listOf(body).map((value) => enabledFrom(value, readManifest))
}

export async function appPluginInstallsFromWire(body: unknown): Promise<readonly AppPluginInstall[]> {
  const readManifest = await manifestReader()
  return listOf(body).map((value) => installFrom(value, readManifest))
}

export async function appPluginCatalogFromWire(body: unknown): Promise<AppPluginCatalog> {
  if (!isRecord(body) || typeof body.canManage !== "boolean" || (body.registry !== "listed" && body.registry !== "unavailable")) throw contractMismatch("app plugin catalog")
  const readManifest = await manifestReader()
  return { canManage: body.canManage, registry: body.registry, plugins: listOf(body.plugins).map((value) => listingFrom(value, readManifest)) }
}
