import type { HarnessConnectionDescriptor } from "@claxedo/agent-runtime-contract"
export type { ConnectionReadiness, HarnessConnectionCapabilities, HarnessConnectionDescriptor, HarnessConnectionRef } from "@claxedo/agent-runtime-contract"

export type ConnectionSecretLease = {
  /** Provider-named secret values, resolved only at the trusted runtime boundary. */
  secrets: Readonly<Record<string, string>>
  /** Non-secret version or expiry token that keys the transport generation. */
  secretLeaseGeneration: string
}

/**
 * The proof the operation that needs a connection was admitted under. A remote
 * secret lease is requested with it, so a background turn proves itself with
 * its own turn lease rather than with whichever request happens to be running.
 */
export type ConnectionSecretAuthority =
  | { kind: "request"; credential: string }
  | { kind: "turn"; lease: string }

export type ConnectionSecretOwner = { kind: "machine-owner" } | { kind: "person"; userId: string }

export type ConnectionSecretResolver = (input: {
  descriptor: HarnessConnectionDescriptor
  directory: string
  authority?: ConnectionSecretAuthority
  /** The session owner whose accounts the connection spends, whoever sent the turn. */
  owner: ConnectionSecretOwner
}) => Promise<ConnectionSecretLease> | ConnectionSecretLease
