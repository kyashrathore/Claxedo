/**
 * The credential store port for every host: SQLite (local) and the
 * envelope-encrypted per-org D1 rows (hosted) both reach the kit through this
 * one adapter over `ControlPlaneCredentials`.
 *
 * There was a hand-written adapter on each side and they disagreed about the
 * port's central rule — two secret readers with different status contracts.
 * The hosted one was right, so its semantics are the shared ones now.
 */
import {
  ConnectionsUnavailableError,
  type CredentialStorePort,
} from "@claxedo/connections"

import type { ControlPlaneCredentials } from "../authority/services"

export function createCredentialStoreAdapter(credentials: ControlPlaneCredentials): CredentialStorePort {
  return {
    async put(input) {
      await credentials.putCredential({
        provider_id: input.providerId,
        kind: input.kind,
        source: "managed",
        secret: input.secret,
        ...(input.expiresAt === undefined ? {} : { expires_at: input.expiresAt }),
      })
    },
    async get(providerId) {
      const meta = await credentials.getCredentialByProvider(providerId)
      if (!meta || (meta.kind !== "api_key" && meta.kind !== "oauth_token")) return undefined
      return {
        kind: meta.kind,
        status: meta.status,
        ...(meta.expires_at === null || meta.expires_at === undefined ? {} : { expiresAt: meta.expires_at }),
      }
    },
    // The token path. Both underlying stores define this as available-only, so
    // the status gate stays where the secret lives rather than being re-imposed
    // here where a host could forget it.
    async resolveSecret(providerId) {
      if (!credentials.resolveCredentialSecret) throw new ConnectionsUnavailableError()
      return credentials.resolveCredentialSecret(providerId)
    },
    // The re-verify path: "the stored secret regardless of status", and its
    // only caller. Reading must not decide the credential is healthy — flipping
    // an errored row back to `available` made a still-failing re-verify look
    // like a repair and re-opened the token path onto a secret the provider had
    // already rejected. Addressed by credential id because that is the seam
    // that skips the status gate.
    async readSecret(providerId) {
      const readById = credentials.resolveCredentialSecretById
      if (!readById) throw new ConnectionsUnavailableError()
      const meta = await credentials.getCredentialByProvider(providerId)
      if (!meta) return null
      return readById(meta.id)
    },
    async setStatus(providerId, status, lastError) {
      const meta = await credentials.getCredentialByProvider(providerId)
      if (meta) await credentials.updateCredentialStatus(meta.id, status, lastError)
    },
    async deleteByProvider(providerId) {
      await credentials.deleteCredentialsByProvider(providerId)
    },
  }
}
