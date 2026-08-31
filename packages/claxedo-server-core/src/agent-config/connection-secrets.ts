import type {
  ConnectionSecretLease,
  ConnectionSecretResolver,
  HarnessConnectionDescriptor,
} from "@claxedo/agent-sdk-runtime"

export type ConnectionSecretUnavailableReason =
  | "disabled"
  | "missing_secret"
  | "expired"
  | "revoked"
  | "invalid_resolution"
  | "resolver_failed"

export class ConnectionUnavailableError extends Error {
  readonly code = "connection_unavailable"

  constructor(
    readonly connectionId: string,
    readonly reason: ConnectionSecretUnavailableReason,
  ) {
    super(`Connection ${connectionId} is unavailable (${reason})`)
    this.name = "ConnectionUnavailableError"
  }
}

export type PublicConnectionUnavailable = {
  code: "connection_unavailable"
  connectionId: string
  reason: ConnectionSecretUnavailableReason
}

export function publicConnectionUnavailable(error: ConnectionUnavailableError): PublicConnectionUnavailable {
  return {
    code: error.code,
    connectionId: error.connectionId,
    reason: error.reason,
  }
}

export function createLocalConnectionSecretResolver(input: {
  resolveReference(request: {
    connectionId: string
    providerKey: string
    name: string
    reference: string
  }): Promise<{
    value?: string
    leaseGeneration: string
    expiresAt?: number
    revoked?: boolean
  }>
  now?: () => number
}): ConnectionSecretResolver {
  return async ({ descriptor }) => {
    assertEnabled(descriptor)
    const secrets: Record<string, string> = {}
    const generations: string[] = []
    for (const [name, reference] of Object.entries(descriptor.secretRefs ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
      let lease: Awaited<ReturnType<typeof input.resolveReference>>
      try {
        lease = await input.resolveReference({
          connectionId: descriptor.connectionId,
          providerKey: descriptor.providerKey,
          name,
          reference,
        })
      } catch {
        throw unavailable(descriptor, "resolver_failed")
      }
      if (lease.revoked) throw unavailable(descriptor, "revoked")
      if (lease.expiresAt !== undefined && lease.expiresAt <= (input.now?.() ?? Date.now())) {
        throw unavailable(descriptor, "expired")
      }
      if (!lease.value) throw unavailable(descriptor, "missing_secret")
      if (!lease.leaseGeneration) throw unavailable(descriptor, "invalid_resolution")
      secrets[name] = lease.value
      generations.push(`${encodeURIComponent(name)}=${encodeURIComponent(lease.leaseGeneration)}`)
    }
    return secretLease(secrets, generations.join("&") || "none")
  }
}

export function createVmConnectionSecretResolver(input: {
  workspaceForDirectory(directory: string): Promise<{ workspaceId: string; runtimeId?: string } | undefined>
    | { workspaceId: string; runtimeId?: string }
    | undefined
  resolveLease(request: {
    connectionId: string
    providerKey: string
    configRevision: number
    secretRefs: Readonly<Record<string, string>>
    workspace: { workspaceId: string; runtimeId?: string }
  }): Promise<{
    secrets: Record<string, string>
    secretLeaseGeneration: string
    expiresAt?: number
    revoked?: boolean
  }>
  now?: () => number
}): ConnectionSecretResolver {
  return async ({ descriptor, directory }) => {
    assertEnabled(descriptor)
    const workspace = await input.workspaceForDirectory(directory)
    if (!workspace?.workspaceId) throw unavailable(descriptor, "invalid_resolution")
    let lease: Awaited<ReturnType<typeof input.resolveLease>>
    try {
      lease = await input.resolveLease({
        connectionId: descriptor.connectionId,
        providerKey: descriptor.providerKey,
        configRevision: descriptor.configRevision,
        secretRefs: descriptor.secretRefs ?? {},
        workspace,
      })
    } catch {
      throw unavailable(descriptor, "resolver_failed")
    }
    if (lease.revoked) throw unavailable(descriptor, "revoked")
    if (lease.expiresAt !== undefined && lease.expiresAt <= (input.now?.() ?? Date.now())) {
      throw unavailable(descriptor, "expired")
    }
    if (!lease.secretLeaseGeneration || !exactSecretKeys(descriptor.secretRefs ?? {}, lease.secrets)) {
      throw unavailable(descriptor, "invalid_resolution")
    }
    if (Object.values(lease.secrets).some((value) => !value)) {
      throw unavailable(descriptor, "missing_secret")
    }
    return secretLease({ ...lease.secrets }, lease.secretLeaseGeneration)
  }
}

function assertEnabled(descriptor: HarnessConnectionDescriptor) {
  if (!descriptor.enabled) throw unavailable(descriptor, "disabled")
}

function unavailable(
  descriptor: HarnessConnectionDescriptor,
  reason: ConnectionSecretUnavailableReason,
) {
  return new ConnectionUnavailableError(descriptor.connectionId, reason)
}

function secretLease(
  secrets: Record<string, string>,
  secretLeaseGeneration: string,
): ConnectionSecretLease {
  return { secrets, secretLeaseGeneration }
}

function exactSecretKeys(expected: Readonly<Record<string, string>>, received: Record<string, string>) {
  const expectedKeys = Object.keys(expected).sort()
  const receivedKeys = Object.keys(received).sort()
  return expectedKeys.length === receivedKeys.length
    && expectedKeys.every((key, index) => key === receivedKeys[index])
}
