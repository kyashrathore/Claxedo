import { sha256Hex } from "@claxedo/helpers/crypto"
import { SHA256_HEX_PATTERN } from "@claxedo/plugin-runtime"
import type { AgentPluginR2Bucket } from "../agent-plugins/artifacts/r2-artifact-adapter"
import { ClaxedoError } from "@claxedo/server-core/platform/errors/base"

/** Cloudflare's own ceiling on a Worker's modules. */
const PLUGIN_BACKEND_BUNDLE_MAX_BYTES = 10 * 1024 * 1024

const PREFIX = "plugin-backends/"

class PluginBackendBundleError extends ClaxedoError<"plugin_backend_bundle_invalid"> {
  constructor(message: string) {
    super({ code: "plugin_backend_bundle_invalid", message })
  }
}

function bundleKey(hash: string) {
  if (!SHA256_HEX_PATTERN.test(hash)) throw new PluginBackendBundleError(`plugin backend bundle hash ${JSON.stringify(hash)} is not a SHA-256`)
  return `${PREFIX}${hash}.js`
}

/** Stores a built backend under its content hash, which it returns; storing the same bytes twice is one object. */
export async function putPluginBackendBundle(bucket: AgentPluginR2Bucket, code: string): Promise<string> {
  const bytes = new TextEncoder().encode(code)
  if (bytes.byteLength > PLUGIN_BACKEND_BUNDLE_MAX_BYTES) {
    throw new PluginBackendBundleError(`plugin backend bundle is ${bytes.byteLength} bytes; the limit is ${PLUGIN_BACKEND_BUNDLE_MAX_BYTES}`)
  }
  const hash = await sha256Hex(code)
  await bucket.put(bundleKey(hash), bytes, { onlyIf: { etagDoesNotMatch: "*" } })
  return hash
}

/** The bundle stored under `hash`, undefined when the bucket has none; the runtime verifies its digest before loading it. */
export async function readPluginBackendBundle(bucket: AgentPluginR2Bucket, hash: string): Promise<string | undefined> {
  const object = await bucket.get(bundleKey(hash))
  if (!object) return undefined
  if (object.size > PLUGIN_BACKEND_BUNDLE_MAX_BYTES) {
    await object.body.cancel()
    throw new PluginBackendBundleError(`plugin backend bundle ${hash} exceeds ${PLUGIN_BACKEND_BUNDLE_MAX_BYTES} bytes`)
  }
  return new Response(object.body).text()
}
