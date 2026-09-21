import { isAcpConnectionId, type HarnessConnectionRef } from "@claxedo/agent-runtime-contract"
export type { ConnectionReadiness, HarnessConnectionCapabilities, HarnessConnectionRef } from "@claxedo/agent-runtime-contract"
import type { AgentHarnessAdapter } from "./adapter-contract"
import type { RuntimeEventHub } from "./runtime-event-hub"
import type { AgentRuntimeStoreWithRecovery } from "./harnesses/shared/runtime-store"
import type { AgentProcessObserver } from "./process-observer"

/** Authenticated operator configuration. `config` is visible only to its installed provider. */
export type HarnessConnectionDescriptor<TConfig = unknown> = {
  connectionId: string
  providerKey: string
  configRevision: number
  enabled: boolean
  config: TConfig
  /** Opaque host-persistence references. Raw secret values never enter config. */
  secretRefs?: Readonly<Record<string, string>>
}

export type ConnectionGeneration = {
  configRevision: number
  secretLeaseGeneration: string
}

export type ConnectionProviderAdapterContext = {
  store: AgentRuntimeStoreWithRecovery
  eventHub: RuntimeEventHub
  processObserver?: AgentProcessObserver
}

export type ConnectionProviderResolution<TResolvedConfig> = {
  config: TResolvedConfig
}

export type ConnectionSecretLease = {
  /** Provider-named secret values, resolved only at the trusted runtime boundary. */
  secrets: Readonly<Record<string, string>>
  /** Non-secret version or expiry token that keys the adapter generation. */
  secretLeaseGeneration: string
}

export type ConnectionSecretResolver = (input: {
  descriptor: HarnessConnectionDescriptor
  directory: string
}) => Promise<ConnectionSecretLease> | ConnectionSecretLease

export type ConnectionProviderProjection = Omit<HarnessConnectionRef, "connectionId" | "enabled">

export type ConnectionProvider<TConfig, TResolvedConfig = TConfig> = {
  providerKey: string
  validateConfig(input: unknown): TConfig
  /** Stable provider-owned identity. Changing it requires a new connectionId. */
  immutableIdentity?(config: TConfig): string
  project(config: TConfig): ConnectionProviderProjection
  resolve(input: {
    descriptor: HarnessConnectionDescriptor<TConfig>
    directory: string
    secrets: Readonly<Record<string, string>>
  }): Promise<ConnectionProviderResolution<TResolvedConfig>> | ConnectionProviderResolution<TResolvedConfig>
  createAdapter(input: {
    descriptor: HarnessConnectionDescriptor<TConfig>
    resolved: ConnectionProviderResolution<TResolvedConfig>
    context: ConnectionProviderAdapterContext
  }): AgentHarnessAdapter
}

export type ConnectionProviderErrorCode =
  | "duplicate_provider"
  | "duplicate_connection"
  | "unknown_provider"
  | "invalid_descriptor"
  | "invalid_config"
  | "disabled_connection"
  | "stale_config_revision"
  | "immutable_connection_identity"
  | "connection_unavailable"

export class ConnectionProviderError extends Error {
  constructor(readonly code: ConnectionProviderErrorCode, message: string) {
    super(message)
    this.name = "ConnectionProviderError"
  }
}

type AnyConnectionProvider = ConnectionProvider<unknown, unknown>

export function createConnectionProviderRegistry(providers: readonly AnyConnectionProvider[]) {
  const byKey = new Map<string, AnyConnectionProvider>()
  for (const provider of providers) {
    requireOpaqueId(provider.providerKey, "providerKey")
    if (byKey.has(provider.providerKey)) {
      throw new ConnectionProviderError("duplicate_provider", `Connection provider ${provider.providerKey} is registered more than once`)
    }
    byKey.set(provider.providerKey, provider)
  }

  function providerFor(providerKey: string) {
    const provider = byKey.get(providerKey)
    if (!provider) throw new ConnectionProviderError("unknown_provider", `Connection provider ${providerKey} is not installed`)
    return provider
  }

  function validateDescriptor(input: HarnessConnectionDescriptor): HarnessConnectionDescriptor {
    if (!input || typeof input !== "object") {
      throw new ConnectionProviderError("invalid_descriptor", "Connection descriptor must be an object")
    }
    requireOpaqueId(input.connectionId, "connectionId")
    if (!isAcpConnectionId(input.connectionId)) {
      throw new ConnectionProviderError("invalid_descriptor", "connectionId must be a lowercase session harness slug of at most 64 characters")
    }
    requireOpaqueId(input.providerKey, "providerKey")
    if (!Number.isSafeInteger(input.configRevision) || input.configRevision < 1) {
      throw new ConnectionProviderError("invalid_descriptor", "configRevision must be a positive safe integer")
    }
    if (typeof input.enabled !== "boolean") {
      throw new ConnectionProviderError("invalid_descriptor", "enabled must be boolean")
    }
    if (input.secretRefs !== undefined) validateStringRecord(input.secretRefs, "secretRefs")
    const provider = providerFor(input.providerKey)
    try {
      return { ...input, config: provider.validateConfig(input.config) }
    } catch (error) {
      if (error instanceof ConnectionProviderError) throw error
      throw new ConnectionProviderError("invalid_config", `Invalid ${input.providerKey} config`)
    }
  }

  function validateDescriptors(inputs: readonly HarnessConnectionDescriptor[]) {
    const ids = new Set<string>()
    return inputs.map((input) => {
      const descriptor = validateDescriptor(input)
      if (ids.has(descriptor.connectionId)) {
        throw new ConnectionProviderError("duplicate_connection", `Connection ${descriptor.connectionId} is configured more than once`)
      }
      ids.add(descriptor.connectionId)
      return descriptor
    })
  }

  function assertRevision(input: HarnessConnectionDescriptor, previous: HarnessConnectionDescriptor) {
    if (input.connectionId !== previous.connectionId || input.providerKey !== previous.providerKey) {
      throw new ConnectionProviderError("immutable_connection_identity", "connectionId and providerKey are immutable")
    }
    if (input.configRevision < previous.configRevision) {
      throw new ConnectionProviderError("stale_config_revision", `Connection ${input.connectionId} config revision moved backwards`)
    }
    const provider = providerFor(input.providerKey)
    if (provider.immutableIdentity) {
      const nextConfig = provider.validateConfig(input.config)
      const previousConfig = provider.validateConfig(previous.config)
      if (provider.immutableIdentity(nextConfig) !== provider.immutableIdentity(previousConfig)) {
        throw new ConnectionProviderError(
          "immutable_connection_identity",
          `Connection ${input.connectionId} cannot be retargeted; create a new connectionId`,
        )
      }
    }
  }

  function publicRef(input: HarnessConnectionDescriptor): HarnessConnectionRef {
    const descriptor = validateDescriptor(input)
    const projection = providerFor(descriptor.providerKey).project(descriptor.config)
    return {
      connectionId: descriptor.connectionId,
      label: projection.label,
      enabled: descriptor.enabled,
      readiness: descriptor.enabled ? projection.readiness : "disabled",
      capabilities: projection.capabilities,
      ...(projection.modelSelection ? { modelSelection: projection.modelSelection } : {}),
    }
  }

  async function resolve(input: {
    descriptor: HarnessConnectionDescriptor
    directory: string
    context: ConnectionProviderAdapterContext
    secretLease?: ConnectionSecretLease
  }) {
    const descriptor = validateDescriptor(input.descriptor)
    if (!descriptor.enabled) {
      throw new ConnectionProviderError("disabled_connection", `Connection ${descriptor.connectionId} is disabled`)
    }
    const provider = providerFor(descriptor.providerKey)
    const availability = provider.project(descriptor.config).readiness
    if (availability !== "ready" && availability !== "configured") {
      throw new ConnectionProviderError("connection_unavailable", `Connection ${descriptor.connectionId} is unavailable`)
    }
    const expectedSecretNames = Object.keys(descriptor.secretRefs ?? {}).sort()
    const lease = input.secretLease ?? { secrets: {}, secretLeaseGeneration: "none" }
    requireOpaqueId(lease.secretLeaseGeneration, "secretLeaseGeneration")
    const receivedSecretNames = Object.keys(lease.secrets).sort()
    if (
      expectedSecretNames.length !== receivedSecretNames.length
      || expectedSecretNames.some((name, index) => name !== receivedSecretNames[index])
      || Object.values(lease.secrets).some((value) => typeof value !== "string" || value.length === 0)
    ) {
      throw new ConnectionProviderError("connection_unavailable", `Connection ${descriptor.connectionId} secret lease is invalid`)
    }
    let resolved: ConnectionProviderResolution<unknown>
    try {
      resolved = await provider.resolve({ descriptor, directory: input.directory, secrets: lease.secrets })
    } catch (error) {
      if (error instanceof ConnectionProviderError) throw error
      throw new ConnectionProviderError("connection_unavailable", `Connection ${descriptor.connectionId} is unavailable`)
    }
    let adapter: AgentHarnessAdapter
    try {
      adapter = provider.createAdapter({ descriptor, resolved, context: input.context })
    } catch (error) {
      if (error instanceof ConnectionProviderError) throw error
      throw new ConnectionProviderError("connection_unavailable", `Connection ${descriptor.connectionId} is unavailable`)
    }
    return {
      descriptor,
      connectionGeneration: {
        configRevision: descriptor.configRevision,
        secretLeaseGeneration: lease.secretLeaseGeneration,
      } satisfies ConnectionGeneration,
      adapter,
    }
  }

  return { assertRevision, publicRef, resolve, validateDescriptor, validateDescriptors }
}

function validateStringRecord(input: Readonly<Record<string, string>>, field: string) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ConnectionProviderError("invalid_descriptor", `${field} must be a string map`)
  }
  for (const [key, value] of Object.entries(input)) {
    requireOpaqueId(key, `${field} key`)
    requireOpaqueId(value, `${field}.${key}`)
  }
}

function requireOpaqueId(input: unknown, field: string): asserts input is string {
  if (typeof input !== "string" || input.trim().length === 0) {
    throw new ConnectionProviderError("invalid_descriptor", `${field} must be a non-empty opaque string`)
  }
}
