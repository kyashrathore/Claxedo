import { sha256Hex } from "@claxedo/helpers/crypto"
import type { PluginBackendActivation } from "./host-port"

export const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/

export class PluginBundleDigestError extends Error {
  constructor(readonly sha256: string) {
    super(`plugin bundle ${sha256} failed digest verification`)
    this.name = "PluginBundleDigestError"
  }
}

/** `code` when its UTF-8 bytes hash to `sha256`; a host's store is not trusted to hold what it was asked for. */
export async function verifiedBundle(code: string, sha256: string): Promise<string> {
  if ((await sha256Hex(code)) !== sha256) throw new PluginBundleDigestError(sha256)
  return code
}

/**
 * Names the configuration the Worker Loader caches: the bundle and the
 * manifest its capabilities are bound from. Two epochs of one configuration
 * share a generation; the loader id adds the epoch, so they never share a
 * loaded Worker.
 */
export async function activationGeneration(activation: Pick<PluginBackendActivation, "bundleHash" | "manifest">): Promise<string> {
  return sha256Hex(`${activation.bundleHash}\n${JSON.stringify(activation.manifest)}`)
}
