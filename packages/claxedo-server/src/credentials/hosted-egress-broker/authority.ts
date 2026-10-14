import type { Binding, BindingAuthority, BindingFailure } from "@claxedo/egress-broker"
import type { SandboxManager } from "@claxedo/sandbox-manager"
import { builtInProviderDestination, type ProviderDestination } from "@claxedo/server-core/credentials/built-in-destinations"
import { hostedBrokerServes } from "@claxedo/server-core/credentials/reach"
import type { CredentialMetadata } from "@claxedo/server-core/credentials/types"
import { Log } from "@claxedo/server-core/platform/runtime/lib/log"
import type { ControlPlaneCredentials } from "../../authority/services"
import { storeRenewal } from "../store-renewal"
import { brokerBindingId, type HostedBrokerClaims } from "./placeholder"

const log = Log.create({ service: "hosted-egress-broker" })

/**
 * How long one vendor refusal counts towards the next. Two 401s a coffee
 * break apart are two independent events, not a login going bad.
 */
const FAILURE_WINDOW_MS = 5 * 60 * 1000

/** Refusals before the broker alone takes the account off the provider. */
const FAILURES_BEFORE_YIELDING = 2

export type HostedBrokerCredentialRead = (credentialId: string) => Promise<{ credential: CredentialMetadata; secret: string } | undefined>

export function bindingDestination(destination: ProviderDestination): Binding["destination"] {
  return {
    origin: destination.origin,
    methods: destination.methods,
    pathPrefixes: destination.pathPrefixes,
    ...(destination.exactPaths ? { exactPaths: destination.exactPaths } : {}),
    ...(destination.credentialQuerySlots ? { credentialQuerySlots: destination.credentialQuerySlots } : {}),
    ...(destination.identityHeaders ? { identityHeaders: destination.identityHeaders } : {}),
  }
}

/**
 * The hosted plane's answer to the broker: the account a placeholder names,
 * read from the organization's store on every request, and the lease the
 * placeholder was minted for, read from the lease store.
 *
 * Nothing is held between requests: two database reads per brokered request,
 * the account row with its envelope and the workspace's lease row. The
 * placeholder's signature proves who minted it; the store row proves the
 * account is still the owner's to spend; the lease row proves the sandbox it
 * was minted for is the one still serving, so a placeholder carried out of a
 * stopped, replaced or deleted sandbox is refused at its next request, not at
 * its expiry.
 */
export function hostedBindingAuthority(input: {
  credentials: (orgId: string) => ControlPlaneCredentials
  read: (orgId: string) => HostedBrokerCredentialRead
  sandboxManager: Pick<SandboxManager, "target">
  fetch?: typeof fetch
  now?: () => number
}): BindingAuthority<HostedBrokerClaims> {
  const now = input.now ?? Date.now
  /** Consecutive vendor refusals per credential, in this isolate. */
  const refusals = new Map<string, { revision: number; count: number; at: number }>()
  return {
    async resolve(bindingId, claims) {
      const read = await input.read(claims.orgId)(claims.credentialId)
      if (!read) return undefined
      let { credential, secret } = read
      const identity = { userId: claims.userId, orgId: claims.orgId, workspaceId: claims.workspaceId, providerId: credential.provider_id }
      // A placeholder for one provider's binding presented at another's: the
      // id is derived from the same names the pass carries, so this holds
      // only when the pass was minted for exactly this binding.
      if (brokerBindingId(identity) !== bindingId) return undefined
      const credentials = input.credentials(claims.orgId)
      const renewed = await storeRenewal(credentials, input.fetch ? { fetch: input.fetch } : {})(credential)
      if (renewed.revision !== credential.revision) {
        const fresh = await credentials.resolveCredentialSecretById?.(credential.id)
        if (!fresh) return undefined
        credential = renewed
        secret = fresh
      }
      const destination = builtInProviderDestination({ providerId: credential.provider_id, kind: credential.kind, secret })
      if (!destination || !hostedBrokerServes(destination)) return undefined
      return {
        binding: {
          userId: claims.userId,
          orgId: claims.orgId,
          workspaceId: claims.workspaceId,
          leaseId: claims.leaseId,
          leaseGeneration: claims.leaseGeneration,
          runtimeId: claims.runtimeId,
          id: bindingId,
          credentialId: credential.id,
          revision: credential.revision,
          status: "active",
          destination: bindingDestination(destination),
          injection: destination.injection,
        },
        value: destination.value,
      }
    },
    async currentRuntime(identity) {
      const target = await input.sandboxManager.target(identity.workspaceId)
      return target.status === "ready" && target.epoch === identity.leaseGeneration && target.hostId === identity.runtimeId
    },
    // The hosted store keeps no last-use mark on a row; a delivered account's
    // selection moves only when its owner chooses another.
    async markUsed() {},
    /**
     * One vendor 401 does not take an account off its provider; a second on
     * the same stored value inside the window, with no Check in between, is
     * the account having stopped working. The count lives in this isolate, so
     * a second refusal that lands elsewhere counts as a first there; the
     * account is then marked by the next one, or by the owner's own Check.
     */
    async reportFailure({ credentialId, revision, status, runtime }: BindingFailure) {
      // A 403 from a model vendor is a permission or region refusal, not a rejected credential.
      if (status !== 401) return
      const orgId = runtime.orgId
      const credentials = input.credentials(orgId)
      const credential = await credentials.getCredential?.(credentialId)
      if (!credential || credential.revision !== revision) return
      const at = now()
      const key = `${orgId}\n${credentialId}`
      const seen = refusals.get(key)
      const checkedSince = credential.last_validated_at != null && seen !== undefined && credential.last_validated_at >= seen.at
      const runs = seen !== undefined && seen.revision === revision && at - seen.at < FAILURE_WINDOW_MS && !checkedSince
      const count = runs ? seen.count + 1 : 1
      if (count < FAILURES_BEFORE_YIELDING) {
        refusals.set(key, { revision, count, at })
        log.info("Vendor refused a brokered credential once; waiting for a second before acting", { credential_id: credentialId, provider_id: credential.provider_id })
        return
      }
      refusals.delete(key)
      await credentials.updateCredentialHealth?.(credentialId, "auth_failed", at)
    },
  }
}
