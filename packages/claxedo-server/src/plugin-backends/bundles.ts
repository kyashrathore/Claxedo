import { sha256Hex } from "@claxedo/helpers/crypto"
import { PLUGIN_BUNDLE_MAX_BYTES } from "@claxedo/plugin-api/release"
import { SHA256_HEX_PATTERN } from "@claxedo/plugin-runtime"
import { ClaxedoError } from "@claxedo/server-core/platform/errors/base"

export type AppPluginsObject = Readonly<{ key: string; size: number; uploaded: Date; httpMetadata?: Readonly<{ contentType?: string }> }>

/**
 * The part of the plugin artifact bucket (`CLAXEDO_AGENT_PLUGINS`) app plugins
 * use: their bundles, and each organization's plugin data under
 * `plugin-data/<orgId>/<pluginId>/`.
 */
export type AppPluginsBucket = Readonly<{
  get(key: string): Promise<(AppPluginsObject & Readonly<{ body: ReadableStream<Uint8Array>; arrayBuffer(): Promise<ArrayBuffer> }>) | null>
  head(key: string): Promise<AppPluginsObject | null>
  put(
    key: string,
    value: Uint8Array,
    options?: Readonly<{ onlyIf?: Readonly<{ etagDoesNotMatch: "*" }>; httpMetadata?: Readonly<{ contentType?: string }> }>,
  ): Promise<Readonly<{ etag: string }> | null>
  delete(keys: string | string[]): Promise<void>
  list(options: Readonly<{ prefix: string; cursor?: string; limit?: number }>): Promise<Readonly<{ objects: readonly AppPluginsObject[]; truncated: boolean; cursor?: string }>>
}>

/** An app bundle the member's app runs in its frame, or a backend bundle the supervisor loads. */
export type PluginBundleKind = "app" | "backend"

const PREFIXES: Readonly<Record<PluginBundleKind, string>> = { app: "plugin-apps/", backend: "plugin-backends/" }

class PluginBundleError extends ClaxedoError<"plugin_bundle_invalid"> {
  constructor(message: string) {
    super({ code: "plugin_bundle_invalid", message })
  }
}

function bundleKey(kind: PluginBundleKind, sha256: string) {
  if (!SHA256_HEX_PATTERN.test(sha256)) throw new PluginBundleError(`plugin bundle hash ${JSON.stringify(sha256)} is not a SHA-256`)
  return `${PREFIXES[kind]}${sha256}.js`
}

/**
 * Stores `code` under the hash it must have. Bundles are content-addressed and
 * shared by every organization that installs the same release, so storing the
 * same bytes twice is one object and an uninstall never deletes one.
 */
export async function putPluginBundle(bucket: AppPluginsBucket, kind: PluginBundleKind, sha256: string, code: string): Promise<void> {
  const bytes = new TextEncoder().encode(code)
  if (bytes.byteLength > PLUGIN_BUNDLE_MAX_BYTES) throw new PluginBundleError(`plugin bundle is ${bytes.byteLength} bytes; the limit is ${PLUGIN_BUNDLE_MAX_BYTES}`)
  if ((await sha256Hex(code)) !== sha256) throw new PluginBundleError(`plugin bundle does not hash to ${sha256}`)
  await bucket.put(bundleKey(kind, sha256), bytes, { onlyIf: { etagDoesNotMatch: "*" } })
}

/** The bundle stored under `sha256`, undefined when the bucket has none; whoever runs it verifies its digest. */
export async function readPluginBundle(bucket: AppPluginsBucket, kind: PluginBundleKind, sha256: string): Promise<string | undefined> {
  const object = await bucket.get(bundleKey(kind, sha256))
  if (!object) return undefined
  if (object.size > PLUGIN_BUNDLE_MAX_BYTES) {
    await object.body.cancel()
    throw new PluginBundleError(`plugin bundle ${sha256} exceeds ${PLUGIN_BUNDLE_MAX_BYTES} bytes`)
  }
  return new Response(object.body).text()
}
