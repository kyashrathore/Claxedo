import { sha256Hex } from "@claxedo/helpers/crypto"
import { PLUGIN_VERSION_PATTERN } from "@claxedo/plugin-api/manifest-schema"
import {
  PluginReleaseError,
  signedPluginReleaseSchema,
  verifyPluginRelease,
  type PluginReleaseBlob,
  type SignedPluginRelease,
} from "@claxedo/plugin-api/release"
import { ClaxedoError } from "@claxedo/server-core/platform/errors/base"

export const DEFAULT_APP_PLUGIN_REGISTRY_URL = "https://plugins.claxedo.dev"

/** Where releases are read and which keys may sign them. */
export type AppPluginRegistry = Readonly<{
  url: string
  keys: Readonly<Record<string, string>>
  fetch: (url: string) => Promise<Response>
}>

type RegistryRefusalCode = "app_plugin_release_invalid" | "app_plugin_release_unavailable"

export class AppPluginRegistryError extends ClaxedoError<RegistryRefusalCode> {
  constructor(code: RegistryRefusalCode, message: string) {
    super({ code, message })
  }
}

async function registryGet(registry: AppPluginRegistry, path: string): Promise<Response> {
  let response: Response
  try {
    response = await registry.fetch(`${registry.url.replace(/\/+$/, "")}${path}`)
  } catch (error) {
    throw new AppPluginRegistryError("app_plugin_release_unavailable", `the plugin registry did not answer ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!response.ok) {
    await response.body?.cancel()
    throw new AppPluginRegistryError("app_plugin_release_unavailable", `the plugin registry answered ${response.status} for ${path}`)
  }
  return response
}

/** The signed release of `id` at `version`, once its signature verifies under one of the registry's keys. */
export async function fetchVerifiedRelease(registry: AppPluginRegistry, id: string, version: string): Promise<SignedPluginRelease> {
  if (!PLUGIN_VERSION_PATTERN.test(version)) throw new AppPluginRegistryError("app_plugin_release_invalid", `${JSON.stringify(version)} is not a plugin version`)
  const response = await registryGet(registry, `/releases/${encodeURIComponent(id)}/${encodeURIComponent(version)}.json`)
  let signed: unknown
  try {
    signed = await response.json()
  } catch {
    throw new AppPluginRegistryError("app_plugin_release_invalid", `the release of ${id} ${version} is not JSON`)
  }
  let release
  try {
    release = await verifyPluginRelease(signed, registry.keys)
  } catch (error) {
    if (error instanceof PluginReleaseError) throw new AppPluginRegistryError("app_plugin_release_invalid", `${error.code}: ${error.message}`)
    throw error
  }
  if (release.id !== id || release.version !== version) {
    throw new AppPluginRegistryError("app_plugin_release_invalid", `the registry answered ${release.id} ${release.version} for ${id} ${version}`)
  }
  const { signature, keyId } = signedPluginReleaseSchema.parse(signed)
  return { release, signature, keyId }
}

/** The blob a release names, read no further than its declared size and refused unless its bytes hash to its SHA-256. */
export async function fetchVerifiedBlob(registry: AppPluginRegistry, blob: PluginReleaseBlob): Promise<string> {
  const response = await registryGet(registry, `/blobs/${blob.sha256}`)
  if (!response.body) throw new AppPluginRegistryError("app_plugin_release_invalid", `blob ${blob.sha256} has no body`)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > blob.size) {
      await reader.cancel()
      throw new AppPluginRegistryError("app_plugin_release_invalid", `blob ${blob.sha256} is larger than the ${blob.size} bytes its release declares`)
    }
    chunks.push(value)
  }
  if (size !== blob.size) throw new AppPluginRegistryError("app_plugin_release_invalid", `blob ${blob.sha256} is ${size} bytes, not the ${blob.size} its release declares`)
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  let code: string
  try {
    code = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    throw new AppPluginRegistryError("app_plugin_release_invalid", `blob ${blob.sha256} is not UTF-8 text`)
  }
  if ((await sha256Hex(code)) !== blob.sha256) throw new AppPluginRegistryError("app_plugin_release_invalid", `blob ${blob.sha256} failed digest verification`)
  return code
}
