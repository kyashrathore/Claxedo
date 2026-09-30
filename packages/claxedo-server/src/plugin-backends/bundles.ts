import type { AgentPluginR2Bucket } from "../agent-plugins/artifacts/r2-artifact-adapter"

/** Cloudflare's own ceiling on a Worker's modules. */
export const PLUGIN_BACKEND_BUNDLE_MAX_BYTES = 10 * 1024 * 1024

const HASH_PATTERN = /^[0-9a-f]{64}$/
const PREFIX = "plugin-backends/"

export class PluginBackendBundleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PluginBackendBundleError"
  }
}

function bundleKey(hash: string) {
  if (!HASH_PATTERN.test(hash)) throw new PluginBackendBundleError(`plugin backend bundle hash ${JSON.stringify(hash)} is not a SHA-256`)
  return `${PREFIX}${hash}.js`
}

async function pluginBackendBundleHash(code: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", code))
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

/** Stores a built backend under its content hash, which it returns; storing the same bytes twice is one object. */
export async function putPluginBackendBundle(bucket: AgentPluginR2Bucket, code: string): Promise<string> {
  const bytes = new TextEncoder().encode(code)
  if (bytes.byteLength > PLUGIN_BACKEND_BUNDLE_MAX_BYTES) {
    throw new PluginBackendBundleError(`plugin backend bundle is ${bytes.byteLength} bytes; the limit is ${PLUGIN_BACKEND_BUNDLE_MAX_BYTES}`)
  }
  const hash = await pluginBackendBundleHash(bytes)
  await bucket.put(bundleKey(hash), bytes, { onlyIf: { etagDoesNotMatch: "*" } })
  return hash
}

/** The bundle stored under `hash`, verified against it; undefined when the bucket has none. */
export async function readPluginBackendBundle(bucket: AgentPluginR2Bucket, hash: string): Promise<string | undefined> {
  const object = await bucket.get(bundleKey(hash))
  if (!object) return undefined
  if (object.size > PLUGIN_BACKEND_BUNDLE_MAX_BYTES) {
    await object.body.cancel()
    throw new PluginBackendBundleError(`plugin backend bundle ${hash} exceeds ${PLUGIN_BACKEND_BUNDLE_MAX_BYTES} bytes`)
  }
  const bytes = new Uint8Array(await new Response(object.body).arrayBuffer())
  if ((await pluginBackendBundleHash(bytes)) !== hash) throw new PluginBackendBundleError(`plugin backend bundle ${hash} failed digest verification`)
  return new TextDecoder().decode(bytes)
}
