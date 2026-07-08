import type { AgentExtensionPolicyOverride } from "../agent-extensions/runtime-config"
import type { SandboxDriverID } from "@claxedo/sandbox-manager/driver-catalog"
import type { CredentialMetadata, CredentialStatus, CredentialWrite } from "../credentials/types"
import { clerkAuthAdapter, type ControlPlaneAuthAdapter, type SignedControlPlaneAuth } from "./auth"
import type { DurableSessionLog } from "./durable-session-log"
import type { SessionWriteMode } from "../architecture"
import type { ProjectionStore } from "./projection-store"
import type { WorkspaceAuthority } from "./authority"
import type { HostTunnelTokenSigner, RuntimeAccessTokenSigner } from "./runtime-access-token"
import type { SandboxManager } from "@claxedo/sandbox-manager"
import type { ClaxedoRegion, ClaxedoRegionMap } from "../region"
import type { RelayProvider } from "../relay-provider"

export type { WorkspaceAuthority } from "./authority"

export class ControlPlaneCompositionError extends Error {
  constructor(
    public readonly code:
      | "hosted_dependency_missing"
      | "hosted_auth_disabled"
      | "hosted_sync_mode_invalid",
    message: string,
  ) {
    super(message)
  }
}

export type ControlPlaneExtensionPolicy = {
  agentExtensionPolicyOverrides?: AgentExtensionPolicyOverride[] | ((input: {
    scope: "project" | "machine" | "workspace"
    workspaceId?: string
    directory?: string
    auth?: SignedControlPlaneAuth
  }) => AgentExtensionPolicyOverride[] | Promise<AgentExtensionPolicyOverride[]>)
}

export type ControlPlaneRelay = {
  relayUrl?: string
  relayUrls?: ClaxedoRegionMap<string>
  provider?: RelayProvider
  resolverToken?: string
  runtimeAccessTokenSigner?: RuntimeAccessTokenSigner
  hostTunnelTokenSigner?: HostTunnelTokenSigner
}

export type ControlPlaneSandbox = {
  defaultDriver?: SandboxDriverID
  sandboxManager?: SandboxManager
}

export type ControlPlaneTelemetry = {
  capture: (distinctId: string, event: string, properties?: Record<string, unknown>) => void
}

export type ControlPlaneLocalExecution = {
  enabled: boolean
}

export type CredentialSyncResult = {
  synced: string[]
  existing: string[]
  missing: string[]
  failed: Array<{ provider_id: string; error: string }>
}

export type ControlPlaneCredentials = {
  listCredentials: () => Promise<CredentialMetadata[]>
  getCredentialByProvider: (providerId: string) => Promise<CredentialMetadata | undefined>
  resolveCredentialSecret?: (providerId: string) => Promise<string | null>
  putCredential: (input: CredentialWrite) => Promise<CredentialMetadata>
  deleteCredential: (id: string) => Promise<boolean>
  deleteCredentialsByProvider: (providerId: string) => Promise<number>
  updateCredentialStatus: (id: string, status: CredentialStatus, error?: string) => Promise<void>
  syncLocalCredentials: (providerIds?: string[]) => Promise<CredentialSyncResult>
}

async function credentialRegistry() {
  return await import("../credentials/registry")
}

export function defaultControlPlaneCredentials(): ControlPlaneCredentials {
  return {
    listCredentials: async () => (await credentialRegistry()).listCredentials(),
    getCredentialByProvider: async (providerId) => (await credentialRegistry()).getCredentialByProvider(providerId),
    resolveCredentialSecret: async (providerId) => (await credentialRegistry()).resolveSecret(providerId),
    putCredential: async (input) => (await credentialRegistry()).putCredential(input),
    deleteCredential: async (id) => (await credentialRegistry()).deleteCredential(id),
    deleteCredentialsByProvider: async (providerId) => (await credentialRegistry()).deleteCredentialsByProvider(providerId),
    updateCredentialStatus: async (id, status, error) => {
      const registry = await credentialRegistry()
      registry.updateCredentialStatus(id, status, error)
    },
    syncLocalCredentials: async (providerIds) => (await import("../credentials/sync")).syncLocalCredentials(providerIds),
  }
}

export type ControlPlaneServices = {
  projectionStore: ProjectionStore
  durableSessionLog: DurableSessionLog
  auth: ControlPlaneAuthAdapter
  credentials: ControlPlaneCredentials
  extensionPolicy: ControlPlaneExtensionPolicy
  relay: ControlPlaneRelay
  sandbox: ControlPlaneSandbox
  telemetry: ControlPlaneTelemetry
  localExecution: ControlPlaneLocalExecution
  defaultHomeRegion?: ClaxedoRegion
  authority?: WorkspaceAuthority
}

export type ControlPlaneServicesOptions = {
  /** Explicit workspace authority. The authority is always injected by the
   *  composition site (local or hosted); the generic services never construct
   *  one. `null` explicitly disables authority; `undefined` leaves it unset. */
  authority?: WorkspaceAuthority | null
  auth?: ControlPlaneAuthAdapter
  credentials?: ControlPlaneCredentials
  extensionPolicy?: ControlPlaneExtensionPolicy
  relay?: ControlPlaneRelay
  sandbox?: ControlPlaneSandbox
  telemetry?: ControlPlaneTelemetry
  localExecution?: ControlPlaneLocalExecution
  defaultHomeRegion?: ClaxedoRegion
}

export type HostedControlPlaneServicesOptions = Omit<
  ControlPlaneServicesOptions,
  "auth" | "credentials" | "extensionPolicy" | "relay" | "sandbox" | "telemetry" | "authority"
> & {
  auth: ControlPlaneAuthAdapter
  credentials: ControlPlaneCredentials
  extensionPolicy: ControlPlaneExtensionPolicy
  relay: ControlPlaneRelay
  sandbox: ControlPlaneSandbox
  telemetry: ControlPlaneTelemetry
  authority: WorkspaceAuthority
}

function requiredHostedDependency<T>(value: T | null | undefined, name: string): T {
  if (value) return value
  throw new ControlPlaneCompositionError(
    "hosted_dependency_missing",
    `Hosted Control Plane requires ${name}`,
  )
}

export type CentralStorePorts = {
  projectionStore: ProjectionStore
  durableSessionLog: DurableSessionLog
}

type HostedCentralStorePorts = CentralStorePorts & {
  sessionWriteMode: () => SessionWriteMode
}

function validateHostedServices(input: HostedCentralStorePorts, options: HostedControlPlaneServicesOptions) {
  if (input.sessionWriteMode() !== "central_canonical") {
    throw new ControlPlaneCompositionError(
      "hosted_sync_mode_invalid",
      "Hosted Control Plane requires central_canonical session storage",
    )
  }
  const auth = requiredHostedDependency(options.auth, "signed auth")
  if (!auth.config.enabled) {
    throw new ControlPlaneCompositionError(
      "hosted_auth_disabled",
      `Hosted Control Plane requires enabled signed auth: ${auth.config.reason}`,
    )
  }
  requiredHostedDependency(options.authority, "workspace authority")
  requiredHostedDependency(options.credentials, "shared credentials")
  requiredHostedDependency(options.extensionPolicy, "Agent Extension policy")
  requiredHostedDependency(options.relay?.relayUrl, "hosted relay URL")
  requiredHostedDependency(options.relay?.resolverToken, "Relay resolver token")
  requiredHostedDependency(options.relay?.runtimeAccessTokenSigner, "Runtime Access Token signer")
  requiredHostedDependency(options.relay?.hostTunnelTokenSigner, "Host Tunnel Token signer")
  requiredHostedDependency(options.sandbox?.defaultDriver, "sandbox driver")
  requiredHostedDependency(options.telemetry?.capture, "audit/telemetry capture")
}

export function createControlPlaneServices(
  input: CentralStorePorts,
  options: ControlPlaneServicesOptions = {},
): ControlPlaneServices {
  const projectionStore = input.projectionStore
  const durableSessionLog = input.durableSessionLog
  const auth = options.auth ?? clerkAuthAdapter()
  const credentials = options.credentials ?? defaultControlPlaneCredentials()
  const extensionPolicy = options.extensionPolicy ?? {}
  const relay = options.relay ?? {}
  const sandbox = options.sandbox ?? {}
  const telemetry = options.telemetry ?? { capture: () => {} }
  const localExecution = options.localExecution ?? { enabled: true }
  const defaultHomeRegion = options.defaultHomeRegion
  return {
    projectionStore,
    durableSessionLog,
    auth,
    credentials,
    extensionPolicy,
    relay,
    sandbox,
    telemetry,
    localExecution,
    ...(defaultHomeRegion ? { defaultHomeRegion } : {}),
    ...(options.authority ? { authority: options.authority } : {}),
  }
}

export function createHostedControlPlaneServices(
  input: HostedCentralStorePorts,
  options: HostedControlPlaneServicesOptions,
): ControlPlaneServices {
  validateHostedServices(input, options)
  return createControlPlaneServices(input, {
    ...options,
    localExecution: { enabled: false },
    authority: options.authority,
  })
}
