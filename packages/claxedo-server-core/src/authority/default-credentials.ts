/**
 * The default credential port: the local registry, behind the shared contract.
 *
 * It lives here rather than beside the hosted composition because it wraps
 * `@claxedo/server-core/credentials/registry` and nothing else. Leaving it in
 * `authority/services.ts` meant a local credential route importing this one
 * VALUE also reached the hosted projection store and, through it, channel
 * delivery — the last runtime edge from a local producer into hosted surface.
 *
 * The registry import stays lazy: a Worker host composes its own credential
 * adapter and must never load the SQLite one.
 */

import type { ControlPlaneCredentials } from "./control-plane-contract"

async function credentialRegistry() {
  return await import("../credentials/registry")
}

/**
 * A renewed OAuth login imported from this machine exists in two places: the
 * Claxedo store and the CLI's own auth file. The provider may rotate the
 * refresh token, so leaving the file behind can strand the user's CLI. Node
 * hosts keep both in step; Worker hosts have no such file and never reach here
 * (the fs-touching module is loaded lazily, off the worker import graph).
 */
async function mirrorRenewedLocalTokens(id: string, secret: string, org?: string) {
  try {
    const registry = await credentialRegistry()
    const credential = registry.getCredential(id, org)
    if (!credential || !credential.account_id) return
    const codex = await import("@claxedo/server-core/credentials/operations/codex-auth-file")
    if (!codex.shouldMirrorCodexTokens(credential)) return
    const tokens = codex.renewedCodexTokens(secret, credential.account_id)
    if (!tokens) return
    codex.mirrorCodexTokens(tokens)
  } catch {
    // Never fail a credential write because its on-disk mirror could not be
    // updated — the stored credential is the one Claxedo runs on.
  }
}

export function defaultControlPlaneCredentials(): ControlPlaneCredentials {
  return {
    listCredentials: async (org) => (await credentialRegistry()).listCredentials(org),
    getCredentialByProvider: async (providerId, kind, org) => (await credentialRegistry()).getCredentialByProvider(providerId, kind, org),
    getCredential: async (id, org) => (await credentialRegistry()).getCredential(id, org),
    resolveCredentialSecret: async (providerId, org) => (await credentialRegistry()).resolveSecret(providerId, undefined, org),
    resolveCredentialSecretById: async (id, org) => (await credentialRegistry()).resolveSecretById(id, org),
    putCredential: async (input, org) => {
      return await (await credentialRegistry()).putCredential(input, org)
    },
    deleteCredential: async (id, org) => {
      return await (await credentialRegistry()).deleteCredential(id, org)
    },
    deleteCredentialsByProvider: async (providerId, kind, org) => {
      return await (await credentialRegistry()).deleteCredentialsByProvider(providerId, kind, org)
    },
    updateCredentialStatus: async (id, status, error, org) => {
      const registry = await credentialRegistry()
      registry.updateCredentialStatus(id, status, error, org)
    },
    updateCredentialHealth: async (id, health, validatedAt, org) => {
      const registry = await credentialRegistry()
      registry.updateCredentialHealth(id, health, validatedAt, org)
    },
    discoverLocalCredentials: async (org) => (await import("@claxedo/server-core/credentials/operations/discovery")).credentialDiscovery.discover(org),
    updateCredentialScope: async (id, scope, consentAt, org) => (await credentialRegistry()).updateCredentialScope(id, scope, consentAt, org),
    updateCredentialSecret: async (id, secret, expiresAt, org) => {
      const registry = await credentialRegistry()
      const stored = await registry.updateCredentialSecret(id, secret, expiresAt, org)
      if (stored) {
        await mirrorRenewedLocalTokens(id, secret, org)
      }
      return stored
    },
    saveDiscoveredCredentials: async (input, org) => {
      return await (await import("@claxedo/server-core/credentials/operations/discovery")).credentialDiscovery.save(input, org)
    },
    syncLocalCredentials: async (providerIds, org) => {
      return await (await import("@claxedo/server-core/credentials/operations/sync")).syncLocalCredentials(providerIds, org)
    },
  }
}

/**
 * The shared contract plus the two pieces only a hosted composition has: the
 * Relay wiring, and the full projection store with its channel methods.
 */
