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

/** Lazy for the same reason as the registry: a Worker host must not load SQLite. */
async function machineLoginUsage() {
  return await import("../credentials/machine-login-usage")
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
    const credential = registry.credentialById(id, { onOutage: "empty" }, org)
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

/**
 * Push registry state into the embedded OpenCode engine's own auth store after
 * a mutation. The engine resolves auth from a store Claxedo does not otherwise
 * write, so without this a key stored in the app never reaches an embedded
 * turn. Scheduling is write-only-when-running: a cold embedded engine is never
 * booted for an auth write — the bridge records the mutation and its boot hook
 * reconciles when the engine actually starts. Lazy-imported like the rest of
 * the fs-touching modules here: Worker hosts have no embedded engine and must
 * keep it off their import graph.
 *
 * `providers` is what the mutation touched; the bridge leaves the engine alone
 * when none of them is one it binds. `undefined` reconciles everything.
 */
async function syncOpenCodeCredentials(org: string | undefined, providers: readonly string[] | undefined) {
  const bridge = await import("@claxedo/server-core/opencode/sdk-credential-bridge")
  await bridge.syncCredentialsToSdk(org, providers)
}

/**
 * Reconcile delivered credentials in the sandboxes the workspace supervisor
 * keeps running. A cloud sandbox's brokered accounts live at its provider's
 * edge, which only this reconcile withdraws: without it a revoked account
 * stays spendable there until the next ensure happens to run. Like the engine
 * sync it is write-only-when-running — a stopped sandbox needs nothing because
 * its next ensure resolves the current set — and a host with no supervisor
 * has nothing delivered to reconcile. Lazy like the rest: the hosted Worker
 * composes its own adapter and must not grow a node-side graph here.
 */
async function syncDeliveredCredentials() {
  const { workspaceSupervisor } = await import("../workspace/supervisor-port")
  await workspaceSupervisor().reconcileCredentialDelivery()
}

export function defaultControlPlaneCredentials(): ControlPlaneCredentials {
  return {
    listCredentials: async (org) => (await credentialRegistry()).listCredentials(org),
    effectiveCredentials: async (scope, org) => {
      const registry = await credentialRegistry()
      return registry.usableCredentials(registry.activeCredentialsForScope(scope, { onOutage: "empty" }, org))
    },
    setActiveCredentials: async (ids, org) => {
      const result = (await credentialRegistry()).setActiveCredentials(ids, org)
      // The engine resolves auth from a store Claxedo does not otherwise write:
      // without this the next embedded turn runs on the account just replaced.
      if (result.ok) {
        await syncDeliveredCredentials()
        await syncOpenCodeCredentials(org, result.credentials.map((credential) => credential.provider_id))
      }
      return result
    },
    getCredentialByProvider: async (providerId, kind, org) =>
      (await credentialRegistry()).credentialByProvider(providerId, { onOutage: "empty", kind }, org),
    getCredential: async (id, org) => (await credentialRegistry()).credentialById(id, { onOutage: "empty" }, org),
    resolveCredentialSecret: async (providerId, org) => (await credentialRegistry()).resolveSecret(providerId, undefined, org),
    resolveCredentialSecretById: async (id, org) => (await credentialRegistry()).resolveSecretById(id, org),
    putCredential: async (input, org) => {
      const stored = await (await credentialRegistry()).putCredential(input, org)
      await syncDeliveredCredentials()
      await syncOpenCodeCredentials(org, [stored.provider_id])
      return stored
    },
    deleteCredential: async (id, org) => {
      const registry = await credentialRegistry()
      const provider = registry.credentialById(id, { onOutage: "empty" }, org)?.provider_id
      const deleted = await registry.deleteCredential(id, org)
      if (deleted) {
        await syncDeliveredCredentials()
        await syncOpenCodeCredentials(org, provider === undefined ? undefined : [provider])
      }
      return deleted
    },
    deleteCredentialsByProvider: async (providerId, kind, org) => {
      const count = await (await credentialRegistry()).deleteCredentialsByProvider(providerId, kind, org)
      if (count > 0) {
        await syncDeliveredCredentials()
        await syncOpenCodeCredentials(org, [providerId])
      }
      return count
    },
    updateCredentialStatus: async (id, status, error, org) => {
      const registry = await credentialRegistry()
      const provider = registry.credentialById(id, { onOutage: "empty" }, org)?.provider_id
      registry.updateCredentialStatus(id, status, error, org)
      // Status is the revocation write: a row flipped away from `available`
      // leaves the delivered set, and one restored rejoins it.
      await syncDeliveredCredentials()
      await syncOpenCodeCredentials(org, provider === undefined ? undefined : [provider])
    },
    updateCredentialHealth: async (id, health, validatedAt, org) => {
      const registry = await credentialRegistry()
      registry.updateCredentialHealth(id, health, validatedAt, org)
      // A verdict that ends an account hands its mark to an heir inside the
      // write, which is a delivered-set change like any other.
      await syncDeliveredCredentials()
    },
    updateCredentialUsage: async (id, windows, at, org) => {
      const registry = await credentialRegistry()
      registry.updateCredentialUsage(id, windows, at, org)
    },
    readMachineLoginUsage: async () => (await machineLoginUsage()).readMachineLoginUsage(),
    recordMachineLoginUsage: async (harness, account, windows, at) => {
      (await machineLoginUsage()).recordMachineLoginUsage(harness, account, windows, at)
    },
    discoverLocalCredentials: async (org) => (await import("@claxedo/server-core/credentials/operations/discovery")).credentialDiscovery.discover(org),
    updateCredentialScope: async (id, scope, consentAt, org) => {
      const updated = (await credentialRegistry()).updateCredentialScope(id, scope, consentAt, org)
      // Narrowing a shared account to local removes it from every sandbox's
      // delivered set; widening delivers it. Either direction reconciles.
      if (updated) await syncDeliveredCredentials()
      return updated
    },
    updateCredentialSecret: async (id, secret, expiresAt, org) => {
      const registry = await credentialRegistry()
      const stored = await registry.updateCredentialSecret(id, secret, expiresAt, org)
      if (stored) {
        await mirrorRenewedLocalTokens(id, secret, org)
        // A renewed token is new auth material: the engine holds the old one.
        const provider = registry.credentialById(id, { onOutage: "empty" }, org)?.provider_id
        await syncDeliveredCredentials()
        await syncOpenCodeCredentials(org, provider === undefined ? undefined : [provider])
      }
      return stored
    },
    updateCredentialLabel: async (id, label, org) => (await credentialRegistry()).updateCredentialLabel(id, label, org),
    saveDiscoveredCredentials: async (input, org) => {
      const saved = await (await import("@claxedo/server-core/credentials/operations/discovery")).credentialDiscovery.save(input, org)
      await syncDeliveredCredentials()
      await syncOpenCodeCredentials(org, input.items.map((item) => item.provider_id))
      return saved
    },
    syncLocalCredentials: async (providerIds, org) => {
      const result = await (await import("@claxedo/server-core/credentials/operations/sync")).syncLocalCredentials(providerIds, org)
      await syncDeliveredCredentials()
      await syncOpenCodeCredentials(org, providerIds)
      return result
    },
  }
}

/**
 * The shared contract plus the two pieces only a hosted composition has: the
 * Relay wiring, and the full projection store with its channel methods.
 */
