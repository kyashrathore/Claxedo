/**
 * What a route producer needs from the control plane, without naming who
 * implements it.
 *
 * Local route producers — credentials, session metadata, agent configuration —
 * take a `services` argument and pass it through. Typing that argument against
 * the hosted `ControlPlaneServices` made every one of them reach the Convex
 * authority, the relay adapter, and channel delivery at COMPILE time, even
 * though nothing executable crossed. This is the surface they actually use.
 *
 * The hosted composition's `ControlPlaneServices` extends this with the relay
 * and the full projection store. Nothing here constructs anything.
 */

import type { SessionProjectionStore } from "./session-projection"
import type { RelayProvider } from "../adapters/relay-port"
import type { AgentExtensionPolicyOverride } from "../hosts/agent-extensions/runtime-config"
import type { ControlPlaneAuthAdapter, SignedControlPlaneAuth } from "../platform/auth/auth"
import type { WorkspaceAuthority } from "../platform/auth/authority"
import type { ControlPlaneTelemetry } from "../platform/telemetry/ports"
import type { DurableSessionLog } from "../platform/auth/durable-session-log"
import type { SessionWriteMode } from "../platform/runtime/profile"
import type { ClaxedoRegion } from "../platform/runtime/region/index"
import type { SandboxDriverID } from "@claxedo/sandbox-contract"
import type { SandboxManagerPort } from "../sandbox/manager-port"
import type {
  CredentialHealth,
  CredentialMetadata,
  CredentialScope,
  CredentialStatus,
  CredentialWrite,
} from "../credentials/types"
import type { CredentialDiscoveryPreview, CredentialDiscoverySelection } from "../credentials/operations/discovery"

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

export type ControlPlaneSandbox = {
  defaultDriver?: SandboxDriverID
  sandboxManager?: SandboxManagerPort
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

/**
 * `relay` carries only what a producer READS from it — the provider port and
 * the resolved endpoint. The token signers stay off this surface: they are
 * hosted implementations, and a producer that needs one is a hosted producer
 * that should type against `ControlPlaneServices` instead.
 */
export type ControlPlaneRelayPort = {
  relayUrl?: string
  provider?: RelayProvider
  resolverToken?: string
}

export type ControlPlaneServicesContract = {
  projectionStore: SessionProjectionStore
  relay: ControlPlaneRelayPort
  durableSessionLog: DurableSessionLog
  sessionWriteMode?: () => SessionWriteMode
  auth: ControlPlaneAuthAdapter
  credentials: ControlPlaneCredentials
  extensionPolicy: ControlPlaneExtensionPolicy
  sandbox: ControlPlaneSandbox
  telemetry: ControlPlaneTelemetry
  localExecution: ControlPlaneLocalExecution
  defaultHomeRegion?: ClaxedoRegion
  authority?: WorkspaceAuthority
}
