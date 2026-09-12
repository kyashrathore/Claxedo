import { sameRuntime, type Binding, type BindingAuthority, type BindingFailure, type RuntimeIdentity } from "./binding.js"
import { mintRuntimeToken } from "./token.js"

export function createGenericDeliveryAdapter(input: {
  signingKey: Uint8Array
  reportFailure(failure: BindingFailure): Promise<void>
}) {
  const bindings = new Map<string, { binding: Binding; value: string }>()
  const runtimes = new Map<string, RuntimeIdentity>()
  const revisions = new Map<string, number>()
  const withdrawnBindings = new Set<string>()
  const withdrawnRuntimes = new Set<string>()
  const authority: BindingAuthority = {
    resolve: async (id) => bindings.get(id),
    currentRuntime: async (identity) => {
      const current = runtimes.get(identity.leaseId)
      return !!current && !withdrawnRuntimes.has(identity.leaseId) && sameRuntime(current, identity)
    },
    reportFailure: input.reportFailure,
  }

  function activateRuntime(identity: RuntimeIdentity) {
    const previous = runtimes.get(identity.leaseId)
    if (previous && (identity.leaseGeneration < previous.leaseGeneration
      || (withdrawnRuntimes.has(identity.leaseId) && identity.leaseGeneration === previous.leaseGeneration)
      || (identity.leaseGeneration === previous.leaseGeneration && !sameRuntime(identity, previous)))) {
      throw new Error("Runtime generation is not newer")
    }
    runtimes.set(identity.leaseId, Object.freeze({ ...identity }))
    withdrawnRuntimes.delete(identity.leaseId)
  }

  function apply(binding: Binding, value: string) {
    const current = runtimes.get(binding.leaseId)
    if (!current || withdrawnRuntimes.has(binding.leaseId) || !sameRuntime(current, binding)) throw new Error("Runtime is not active")
    if (withdrawnBindings.has(binding.id)) throw new Error("Withdrawn binding cannot be reused")
    if (!/^[A-Za-z0-9_-]+$/.test(binding.id) || !value || binding.status !== "active") throw new Error("Invalid binding")
    const revision = revisions.get(binding.id) ?? 0
    if (!Number.isSafeInteger(binding.revision) || binding.revision <= revision) throw new Error("Binding revision is not newer")
    const existing = bindings.get(binding.id)?.binding
    if (existing && (!sameRuntime(existing, binding) || existing.credentialId !== binding.credentialId)) {
      throw new Error("Binding identity cannot change")
    }
    const saved = structuredClone(binding)
    Object.freeze(saved.destination.methods)
    Object.freeze(saved.destination.pathPrefixes)
    Object.freeze(saved.destination)
    Object.freeze(saved.injection)
    Object.freeze(saved)
    bindings.set(binding.id, { binding: saved, value })
    revisions.set(binding.id, binding.revision)
  }

  function withdraw(bindingId: string, revision: number) {
    if (!Number.isSafeInteger(revision) || revision <= (revisions.get(bindingId) ?? 0)) throw new Error("Binding revision is not newer")
    revisions.set(bindingId, revision)
    withdrawnBindings.add(bindingId)
    bindings.delete(bindingId)
  }

  async function project(bindingId: string, brokerOrigin: string, expiresAt: number) {
    const entry = bindings.get(bindingId)
    if (!entry || !await authority.currentRuntime(entry.binding)) throw new Error("Binding is not active")
    const origin = new URL(brokerOrigin)
    if (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(origin.hostname))) {
      throw new Error("Broker must use HTTPS or loopback HTTP")
    }
    if (origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw new Error("Invalid broker origin")
    const b = entry.binding
    const placeholder = await mintRuntimeToken({
      userId: b.userId, orgId: b.orgId, workspaceId: b.workspaceId, leaseId: b.leaseId,
      leaseGeneration: b.leaseGeneration, runtimeId: b.runtimeId,
      bindingIds: [bindingId], expiresAt,
    }, input.signingKey)
    return { baseUrl: `${origin.origin}/bindings/${bindingId}`, placeholder, expiresAt, authMode: b.injection.header.toLowerCase() === "x-api-key" ? "api-key" as const : "bearer" as const }
  }

  return {
    authority, activateRuntime, apply, rotate: apply, withdraw, project,
    withdrawRuntime(leaseId: string) {
      withdrawnRuntimes.add(leaseId)
      for (const [id, entry] of bindings) if (entry.binding.leaseId === leaseId) {
        withdrawnBindings.add(id)
        bindings.delete(id)
      }
    },
    dispose() { bindings.clear(); runtimes.clear(); revisions.clear(); withdrawnBindings.clear(); withdrawnRuntimes.clear() },
  }
}
