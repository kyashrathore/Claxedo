import { CredentialDeliveryError } from "../credentials/delivery"
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
async function accountSourceStore() {
  return await import("../credentials/account-source")
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
 * Reconcile delivered credentials in the sandboxes the workspace supervisor
 * keeps running. A cloud sandbox's brokered accounts live at its provider's
 * edge, which only this reconcile withdraws: without it a revoked account
 * stays spendable there until the next ensure happens to run. It is
 * write-only-when-running — a stopped sandbox needs nothing because its next
 * ensure resolves the current set — and a host with no supervisor
 * has nothing delivered to reconcile. Lazy like the rest: the hosted Worker
 * composes its own adapter and must not grow a node-side graph here.
 */
async function syncDeliveredCredentials() {
  const { workspaceSupervisor } = await import("../workspace/supervisor-port")
  await workspaceSupervisor().reconcileCredentialDelivery()
}

/**
 * Carries a stored credential change to every running workspace: the
 * supervisor's sandboxes and, where the composition has them, its local
 * runtimes. Both are attempted whichever fails, so one unreachable sandbox
 * never leaves a local runtime spending a revoked account.
 */
export async function deliverCredentialChange(refreshLocalRuntimes?: () => Promise<void>) {
  const results = await Promise.allSettled([syncDeliveredCredentials(), refreshLocalRuntimes?.()])
  const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : [])
  if (!failures.length) return
  if (failures.length === 1 && failures[0] instanceof CredentialDeliveryError) throw failures[0]
  throw new CredentialDeliveryError(failures.length === 1 ? failures[0] : new AggregateError(failures, "credential delivery failed"))
}

export function defaultControlPlaneCredentials(options: { refreshLocalRuntimes?: () => Promise<void> } = {}): ControlPlaneCredentials {
  const deliver = () => deliverCredentialChange(options.refreshLocalRuntimes)
  return {
    listCredentials: async (org) => (await credentialRegistry()).listCredentials(org),
    effectiveCredentials: async (scope, org) => {
      const registry = await credentialRegistry()
      return registry.usableCredentials(registry.activeCredentialsForScope(scope, { onOutage: "empty" }, org))
    },
    setActiveCredentials: async (ids, org, actor) => {
      const result = (await credentialRegistry()).setActiveCredentials(ids, org, actor)
      if (result.ok) {
        await deliver()
      }
      return result
    },
    accountSelections: async (org) => (await accountSourceStore()).accountSelections(org),
    setAccountSources: async (providerIds, source, org, person) => {
      const sources = (await accountSourceStore()).setAccountSources(providerIds, source, org, person)
      await deliver()
      return sources
    },
    getCredentialByProvider: async (providerId, kind, org) =>
      (await credentialRegistry()).credentialByProvider(providerId, { onOutage: "empty", kind, owner: null }, org),
    getCredential: async (id, org) => (await credentialRegistry()).credentialById(id, { onOutage: "empty" }, org),
    resolveCredentialSecret: async (providerId, org) => (await credentialRegistry()).resolveSecret(providerId, undefined, org),
    resolveCredentialSecretById: async (id, org) => (await credentialRegistry()).resolveSecretById(id, org),
    putCredential: async (input, org) => {
      const stored = await (await credentialRegistry()).putCredential(input, org)
      await deliver()
      return stored
    },
    deleteCredential: async (id, org) => {
      const registry = await credentialRegistry()
      const deleted = await registry.deleteCredential(id, org)
      if (deleted) {
        await deliver()
      }
      return deleted
    },
    deleteCredentialsByProvider: async (providerId, kind, org) => {
      const count = await (await credentialRegistry()).deleteCredentialsByProvider(providerId, kind, org)
      if (count > 0) {
        await deliver()
      }
      return count
    },
    updateCredentialStatus: async (id, status, error, org) => {
      const registry = await credentialRegistry()
      registry.updateCredentialStatus(id, status, error, org)
      // Status is the revocation write: a row flipped away from `available`
      // leaves the delivered set, and one restored rejoins it.
      await deliver()
    },
    updateCredentialHealth: async (id, health, validatedAt, org) => {
      const registry = await credentialRegistry()
      registry.updateCredentialHealth(id, health, validatedAt, org)
      // A verdict that ends an account hands its mark to an heir inside the
      // write, which is a delivered-set change like any other.
      await deliver()
    },
    updateCredentialUsage: async (id, windows, at, org) => {
      const registry = await credentialRegistry()
      registry.updateCredentialUsage(id, windows, at, org)
    },
    readMachineLoginUsage: async () => (await machineLoginUsage()).readMachineLoginUsage(),
    recordMachineLoginUsage: async (harness, account, windows, at) => {
      (await machineLoginUsage()).recordMachineLoginUsage(harness, account, windows, at)
    },
    discoverLocalCredentials: async (org, owner) => (await import("@claxedo/server-core/credentials/operations/discovery")).credentialDiscovery.discover(org, owner),
    updateCredentialScope: async (id, scope, consentAt, org) => {
      const updated = (await credentialRegistry()).updateCredentialScope(id, scope, consentAt, org)
      // Narrowing a shared account to local removes it from every sandbox's
      // delivered set; widening delivers it. Either direction reconciles.
      if (updated) await deliver()
      return updated
    },
    updateCredentialSecret: async (id, secret, expiresAt, org) => {
      const registry = await credentialRegistry()
      const stored = await registry.updateCredentialSecret(id, secret, expiresAt, org)
      if (stored) {
        await mirrorRenewedLocalTokens(id, secret, org)
        await deliver()
      }
      return stored
    },
    updateCredentialLabel: async (id, label, org) => (await credentialRegistry()).updateCredentialLabel(id, label, org),
    saveDiscoveredCredentials: async (input, org, owner) => {
      const saved = await (await import("@claxedo/server-core/credentials/operations/discovery")).credentialDiscovery.save(input, org, owner)
      await deliver()
      return saved
    },
    syncLocalCredentials: async (providerIds, org, owner) => {
      const result = await (await import("@claxedo/server-core/credentials/operations/sync")).syncLocalCredentials(providerIds, org, owner)
      await deliver()
      return result
    },
  }
}

/**
 * The shared contract plus the two pieces only a hosted composition has: the
 * Relay wiring, and the full projection store with its channel methods.
 */
