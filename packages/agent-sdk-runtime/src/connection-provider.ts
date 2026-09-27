import type { HarnessConnectionDescriptor } from "@claxedo/agent-runtime-contract"
export type { ConnectionReadiness, HarnessConnectionCapabilities, HarnessConnectionDescriptor, HarnessConnectionRef } from "@claxedo/agent-runtime-contract"

export type ConnectionSecretLease = {
  /** Provider-named secret values, resolved only at the trusted runtime boundary. */
  secrets: Readonly<Record<string, string>>
  /** Non-secret version or expiry token that keys the transport generation. */
  secretLeaseGeneration: string
}

export type ConnectionSecretResolver = (input: {
  descriptor: HarnessConnectionDescriptor
  directory: string
}) => Promise<ConnectionSecretLease> | ConnectionSecretLease
