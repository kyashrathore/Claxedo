/**
 * Credential store — selects and caches the deployment-specific secret backend.
 *
 * - Hosted/cloud: Cloudflare KV (when CLAXEDO_CF_KV_URL is set)
 * - Local desktop: encrypted file store under ~/.claxedo/credentials/
 *
 * Also provides an in-memory test backend for unit tests.
 */

import type { SecretBackend } from "./types"
import { createLocalBackend } from "./local"
import { createCloudflareBackend } from "./cloudflare"
import { Log } from "../log"

const log = Log.create({ service: "credentials-store" })

let backend: SecretBackend | undefined
let override: SecretBackend | undefined

/** Returns true if running in a hosted/cloud deployment. */
function isHosted() {
  return !!process.env.CLAXEDO_CF_KV_URL
}

/** Get or create the active secret backend. */
export function getBackend(): SecretBackend {
  if (override) return override
  if (backend) return backend

  if (isHosted()) {
    log.info("Using Cloudflare KV secret backend")
    backend = createCloudflareBackend()
  } else {
    log.info("Using local encrypted secret backend")
    backend = createLocalBackend()
  }
  return backend
}

/** Override the backend for testing. Call with undefined to reset. */
export function setBackendOverride(b: SecretBackend | undefined) {
  override = b
}

/** Create an in-memory backend for tests. */
export function createTestBackend(): SecretBackend & { secrets: Map<string, string> } {
  const secrets = new Map<string, string>()
  return {
    secrets,
    async put(id, secret) {
      const ref = `test:${id}`
      secrets.set(ref, secret)
      return ref
    },
    async get(ref) {
      return secrets.get(ref) ?? null
    },
    async delete(ref) {
      secrets.delete(ref)
    },
    async probe() {
      return true
    },
  }
}
