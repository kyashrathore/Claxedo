import type { ControlPlaneTelemetry } from "@claxedo/server-core/platform/telemetry/ports"
import type { AgentExtensionPolicyOverride } from "@claxedo/server-core/hosts/agent-extensions/runtime-config"
import type { SandboxDriverID } from "@claxedo/sandbox-contract"
import type { CredentialHealth, CredentialMetadata, CredentialScope, CredentialStatus, CredentialWrite } from "@claxedo/server-core/credentials/types"
import type { CredentialDiscoveryPreview, CredentialDiscoverySelection } from "@claxedo/server-core/credentials/operations/discovery"
import { clerkAuthAdapter, type ControlPlaneAuthAdapter, type SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { DurableSessionLog } from "@claxedo/server-core/platform/auth/durable-session-log"
import type { SessionWriteMode } from "@claxedo/server-core/platform/runtime/profile"
import type { ProjectionStore } from "./projection-store"
import {
  ControlPlaneCompositionError,
  type ControlPlaneCredentials,
  type ControlPlaneExtensionPolicy,
  type ControlPlaneLocalExecution,
  type ControlPlaneSandbox,
  type ControlPlaneServicesContract,
  type ControlPlaneRelayPort,
} from "@claxedo/server-core/authority/control-plane-contract"
import { defaultControlPlaneCredentials } from "@claxedo/server-core/authority/default-credentials"
import type { WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
import type { HostTunnelTokenSigner, RuntimeAccessTokenSigner } from "@claxedo/server-core/platform/auth/runtime-access-token"
import type { SandboxManager } from "@claxedo/sandbox-manager"
import type { ClaxedoRegion, ClaxedoRegionMap } from "@claxedo/server-core/platform/runtime/region/index"
import type { RelayProvider } from "@claxedo/server-core/adapters/relay/index"

export type { WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"

export {
  ControlPlaneCompositionError,
  type ControlPlaneCredentials,
  type ControlPlaneExtensionPolicy,
  type ControlPlaneLocalExecution,
  type ControlPlaneSandbox,
  type CredentialSyncResult,
} from "@claxedo/server-core/authority/control-plane-contract"

export type { ControlPlaneTelemetry }

/**
 * Relay wiring is hosted-only: it names the Relay provider and the runtime
 * access-token signers. It is the one field the shared contract leaves out.
 */
export type ControlPlaneRelay = ControlPlaneRelayPort & {
  relayUrls?: ClaxedoRegionMap<string>
  runtimeAccessTokenSigner?: RuntimeAccessTokenSigner
  hostTunnelTokenSigner?: HostTunnelTokenSigner
}

export { defaultControlPlaneCredentials } from "@claxedo/server-core/authority/default-credentials"

export type ControlPlaneServices = ControlPlaneServicesContract & {
  projectionStore: ProjectionStore
  relay: ControlPlaneRelay
  sandbox: HostedControlPlaneSandbox
}

export type HostedControlPlaneSandbox = Omit<ControlPlaneSandbox, "sandboxManager"> & {
  sandboxManager?: SandboxManager
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
  sandbox?: HostedControlPlaneSandbox
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
  sandbox: HostedControlPlaneSandbox
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
  sessionWriteMode?: () => SessionWriteMode
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
    ...(input.sessionWriteMode ? { sessionWriteMode: input.sessionWriteMode } : {}),
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
