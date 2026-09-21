/**
 * The secret backend of a Node process: the encrypted file store under
 * `<dataDir>/credentials/`, created once and cached, with an override seam for
 * tests. The hosted Worker never imports this module; its secrets live in D1
 * behind `credentials/worker/index.ts` in claxedo-server.
 */

import type { SecretBackend } from "./types"
import { createLocalBackend } from "./backends/local"

let backend: SecretBackend | undefined
let override: SecretBackend | undefined

export function getBackend(): SecretBackend {
  if (override) return override
  // One key per machine: a self-hosted node serves every org from one
  // operator's disk, so per-org key separation would not separate anything
  // that operator does not already hold.
  backend ??= createLocalBackend()
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
