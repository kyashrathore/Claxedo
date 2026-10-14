import { bindingBaseUrl, createEgressBroker, type RuntimeIdentity } from "@claxedo/egress-broker"
import type { ProviderBindingSource } from "@claxedo/agent-runtime-contract"
import { destinationAuthMode } from "@claxedo/server-core/credentials/built-in-destinations"
import type { HarnessCredentialBroker } from "@claxedo/server-core/credentials/native-delivery-plan"
import type { ControlPlaneCredentials } from "../../authority/services"
import type { RouteGuardExemption } from "../../platform/auth/request-guard"
import { hostedBindingAuthority, type HostedBrokerCredentialRead } from "./authority"
import { brokerBindingId, mintBrokerPlaceholder, verifyBrokerPlaceholder, type HostedBrokerClaims } from "./placeholder"

export { EGRESS_BROKER_PASS_AUDIENCE, brokerBindingId, mintBrokerPlaceholder, verifyBrokerPlaceholder, type HostedBrokerClaims } from "./placeholder"

/**
 * A projection that says the account is deliverable without minting anything:
 * a draft's refusal is decided from the projection's shape alone, and a pass
 * minted for an answer nobody delivers would be a live capability held for
 * nothing. Never applied to a runtime.
 */
export const DRAFT_PLACEHOLDER = "draft"

/** The sandbox a placeholder is minted for, as the lease store reports it once the sandbox is ready. */
export type BrokerLease = { epoch: number; hostId: string }

export type HostedEgressBroker = {
  /** Mounted at `/bindings/*` on the control plane's public origin. */
  handler: (request: Request) => Promise<Response>
  /** The account binder for one workspace's deliveries; without a lease it projects draft placeholders. */
  binder(input: { orgId: string; workspaceId: string; lease?: BrokerLease }): HarnessCredentialBroker
}

/**
 * The broker's own refusals stand in for the default guard: a request with no
 * verifiable placeholder is turned away before any upstream work, the in-flight
 * ceiling bounds what verified ones can hold, and the vendor's own limits
 * bound a turn's body, which the broker streams rather than buffers.
 */
export const HOSTED_EGRESS_BROKER_GUARD_EXEMPTION: RouteGuardExemption = {
  prefix: "/bindings",
  bodyCap: true,
  rateLimit: true,
  reason: "A model turn's request body is routinely past 1 MiB and must stream to the vendor unbuffered; sandboxes behind one egress address would share one per-client budget.",
  enforcedBy: "src/credentials/hosted-egress-broker/index.ts (placeholder verification before any upstream work; @claxedo/egress-broker's in-flight ceiling)",
}

/**
 * The hosted plane's egress broker: `@claxedo/egress-broker` over the
 * organization credential stores, with the plane's runtime signing key
 * minting and verifying the placeholders as sandbox passes.
 *
 * It serves the drivers whose sandboxes have no provider edge. A driver with
 * one is never pointed here: its deliveries stay edge secrets, and this
 * broker is not on their request path.
 */
export function createHostedEgressBroker(input: {
  credentials: (orgId: string) => ControlPlaneCredentials
  read: (orgId: string) => HostedBrokerCredentialRead
  env: Record<string, string | undefined>
  /** The public origin sandboxes reach the plane at; a binding's base URL is under it. */
  origin: string
  fetch?: typeof fetch
  now?: () => number
}): HostedEgressBroker {
  const now = input.now ?? Date.now
  const readers = new Map<string, HostedBrokerCredentialRead>()
  const read = (orgId: string) => {
    let reader = readers.get(orgId)
    if (!reader) {
      reader = input.read(orgId)
      readers.set(orgId, reader)
    }
    return reader
  }
  const handler = createEgressBroker<HostedBrokerClaims>({
    authority: hostedBindingAuthority({ credentials: input.credentials, read, ...(input.fetch ? { fetch: input.fetch } : {}), now }),
    verifyToken: (token) => verifyBrokerPlaceholder(token, input.env, { now }),
    ...(input.fetch ? { fetch: input.fetch } : {}),
  })
  return {
    handler,
    binder: ({ orgId, workspaceId, lease }) => ({
      async bind(credential, destination): Promise<ProviderBindingSource> {
        const userId = credential.owner ?? `org:${orgId}`
        const id = brokerBindingId({ userId, orgId, workspaceId, providerId: credential.provider_id })
        const route = {
          baseUrl: bindingBaseUrl(input.origin, id),
          authMode: destinationAuthMode(destination),
          ...(destination.apiPath ? { apiPath: destination.apiPath } : {}),
          account: { credentialId: credential.id, providerId: credential.provider_id, ...(credential.label ? { label: credential.label } : {}) },
        }
        if (!lease) return { ...route, placeholder: DRAFT_PLACEHOLDER }
        const identity: RuntimeIdentity = { userId, orgId, workspaceId, leaseId: `sandbox:${workspaceId}`, leaseGeneration: lease.epoch, runtimeId: lease.hostId }
        const { placeholder, expiresAt } = await mintBrokerPlaceholder({ identity, bindingId: id, credentialId: credential.id }, input.env, { now })
        return { ...route, placeholder, expiresAt }
      },
    }),
  }
}
