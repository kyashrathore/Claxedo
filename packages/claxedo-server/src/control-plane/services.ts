import type { AgentExtensionPolicyOverride } from "../agent-extensions/runtime-config"
import type { SandboxDriverID } from "@claxedo/sandbox-manager/driver-catalog"
import type { CredentialHealth, CredentialMetadata, CredentialScope, CredentialStatus, CredentialWrite } from "../credentials/types"
import type { CredentialDiscoveryPreview, CredentialDiscoverySelection } from "../credentials/discovery"
import { clerkAuthAdapter, type ControlPlaneAuthAdapter, type SignedControlPlaneAuth } from "./auth"
import type { DurableSessionLog } from "./durable-session-log"
import type { SessionWriteMode } from "../governance/architecture"
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
      | "hosted_sync_mode_invalid"
      | "self_host_app_required",
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

/**
 * Every method takes a trailing `org` — the tenant the operation runs as.
 *
 * It is optional on the type so that adapters which are ALREADY partitioned by
 * construction (`hostedOrgCredentials(orgId)` binds one org per instance, and
 * its KV keys are org-prefixed) satisfy the port without restating it. For the
 * local SQLite registry the argument is the isolation boundary: omitting it
 * selects the named single-tenant partition (`__local__`), never a wildcard, so
 * an un-threaded call site fails closed rather than reading across tenants.
 */
export type ControlPlaneCredentials = {
  listCredentials: (org?: string) => Promise<CredentialMetadata[]>
  getCredentialByProvider: (providerId: string, kind?: string, org?: string) => Promise<CredentialMetadata | undefined>
  getCredential?: (id: string, org?: string) => Promise<CredentialMetadata | undefined>
  resolveCredentialSecret?: (providerId: string, org?: string) => Promise<string | null>
  resolveCredentialSecretById?: (id: string, org?: string) => Promise<string | null>
  putCredential: (input: CredentialWrite, org?: string) => Promise<CredentialMetadata>
  deleteCredential: (id: string, org?: string) => Promise<boolean>
  deleteCredentialsByProvider: (providerId: string, kind?: string, org?: string) => Promise<number>
  updateCredentialStatus: (id: string, status: CredentialStatus, error?: string, org?: string) => Promise<void>
  updateCredentialHealth?: (id: string, health: CredentialHealth, validatedAt: number, org?: string) => Promise<void>
  discoverLocalCredentials?: (org?: string) => Promise<{ discovery_id: string; items: CredentialDiscoveryPreview[] }>
  saveDiscoveredCredentials?: (
    input: { discovery_id: string; items: CredentialDiscoverySelection[] },
    org?: string,
  ) => Promise<{
    saved: Array<{ credential_id: string; provider_id: string; account_id?: string }>
  }>
  updateCredentialScope?: (id: string, scope: CredentialScope, consentAt: number, org?: string) => Promise<boolean>
  /** Persist renewed secret material for an existing credential (OAuth refresh). */
  updateCredentialSecret?: (id: string, secret: string, expiresAt?: number, org?: string) => Promise<boolean>
  syncLocalCredentials: (providerIds?: string[], org?: string) => Promise<CredentialSyncResult>
}

async function credentialRegistry() {
  return await import("../credentials/registry")
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
    const credential = registry.getCredential(id, org)
    if (!credential || !credential.account_id) return
    const codex = await import("../credentials/codex-auth-file")
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
 * Push registry state into the embedded OpenCode engine's own auth store after
 * a mutation. The engine resolves auth from a store Claxedo does not otherwise
 * write, so without this a key stored in the app never reaches an embedded
 * turn. Lazy-imported like the rest of the fs-touching modules here: Worker
 * hosts have no embedded engine and must keep it off their import graph.
 */
async function syncEngineAuth(org?: string) {
  try {
    const bridge = await import("../credentials/engine-bridge")
    await bridge.syncCredentialsToEngine(org)
  } catch {
    // Never fail the credential write the user asked for because the engine
    // could not be reached — the credential is stored, and the next mutation
    // or engine boot reconciles. The bridge logs its own failures.
  }
}

export function defaultControlPlaneCredentials(): ControlPlaneCredentials {
  return {
    listCredentials: async (org) => (await credentialRegistry()).listCredentials(org),
    getCredentialByProvider: async (providerId, kind, org) => (await credentialRegistry()).getCredentialByProvider(providerId, kind, org),
    getCredential: async (id, org) => (await credentialRegistry()).getCredential(id, org),
    resolveCredentialSecret: async (providerId, org) => (await credentialRegistry()).resolveSecret(providerId, undefined, org),
    resolveCredentialSecretById: async (id, org) => (await credentialRegistry()).resolveSecretById(id, org),
    putCredential: async (input, org) => {
      const stored = await (await credentialRegistry()).putCredential(input, org)
      await syncEngineAuth(org)
      return stored
    },
    deleteCredential: async (id, org) => {
      const deleted = await (await credentialRegistry()).deleteCredential(id, org)
      if (deleted) await syncEngineAuth(org)
      return deleted
    },
    deleteCredentialsByProvider: async (providerId, kind, org) => {
      const count = await (await credentialRegistry()).deleteCredentialsByProvider(providerId, kind, org)
      if (count > 0) await syncEngineAuth(org)
      return count
    },
    updateCredentialStatus: async (id, status, error, org) => {
      const registry = await credentialRegistry()
      registry.updateCredentialStatus(id, status, error, org)
    },
    updateCredentialHealth: async (id, health, validatedAt, org) => {
      const registry = await credentialRegistry()
      registry.updateCredentialHealth(id, health, validatedAt, org)
    },
    discoverLocalCredentials: async (org) => (await import("../credentials/discovery")).credentialDiscovery.discover(org),
    updateCredentialScope: async (id, scope, consentAt, org) => (await credentialRegistry()).updateCredentialScope(id, scope, consentAt, org),
    updateCredentialSecret: async (id, secret, expiresAt, org) => {
      const registry = await credentialRegistry()
      const stored = await registry.updateCredentialSecret(id, secret, expiresAt, org)
      if (stored) {
        await mirrorRenewedLocalTokens(id, secret, org)
        // A renewed token is new auth material: the engine holds the old one.
        await syncEngineAuth(org)
      }
      return stored
    },
    saveDiscoveredCredentials: async (input, org) => {
      const saved = await (await import("../credentials/discovery")).credentialDiscovery.save(input, org)
      await syncEngineAuth(org)
      return saved
    },
    syncLocalCredentials: async (providerIds, org) => {
      const result = await (await import("../credentials/sync")).syncLocalCredentials(providerIds, org)
      await syncEngineAuth(org)
      return result
    },
  }
}

export type ControlPlaneServices = {
  projectionStore: ProjectionStore
  durableSessionLog: DurableSessionLog
  sessionWriteMode?: () => SessionWriteMode
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
