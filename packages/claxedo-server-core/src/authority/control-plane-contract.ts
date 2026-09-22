/**
 * What a route producer needs from the control plane, without naming who
 * implements it.
 *
 * Local route producers — credentials, session metadata, agent configuration —
 * take a `services` argument and pass it through. Typing that argument against
 * the hosted `ControlPlaneServices` made every one of them reach the hosted authority
 * authority, the relay adapter, and channel delivery at COMPILE time, even
 * though nothing executable crossed. This is the surface they actually use.
 *
 * The hosted composition's `ControlPlaneServices` extends this with the relay
 * and the full projection store. Nothing here constructs anything.
 */

import type { SessionProjectionStore } from "./session-projection"
import type { RelayProvider } from "../adapters/relay-port"
import type { ControlPlaneAuthAdapter } from "../platform/auth/auth"
import type { WorkspaceAuthority } from "../platform/auth/authority"
import type { ControlPlaneTelemetry } from "../platform/telemetry/ports"
import type { DurableSessionLog } from "../platform/auth/durable-session-log"
import type { SessionWriteMode } from "../platform/runtime/profile"
import type { ClaxedoRegion } from "../platform/runtime/region/index"
import type { SandboxProvisionerID } from "@claxedo/sandbox-contract"
import type { SandboxManagerPort } from "../sandbox/manager-port"
import type {
  CredentialHealth,
  CredentialKind,
  CredentialMetadata,
  CredentialScope,
  CredentialStatus,
  CredentialUsageWindow,
  CredentialWrite,
  SetActiveCredentialsResult,
} from "../credentials/types"
import type { CredentialDiscoveryPreview, CredentialDiscoverySelection } from "../credentials/operations/discovery"
import type { HarnessId } from "@claxedo/agent-runtime-contract"
import type { MachineLogin } from "../credentials/machine-login"
import type { MachineLoginUsage } from "../credentials/machine-login-usage"

export class ControlPlaneCompositionError extends Error {
  constructor(
    public readonly code:
      | "hosted_dependency_missing"
      | "hosted_composition_removed"
      | "hosted_auth_disabled"
      | "hosted_sync_mode_invalid"
      | "self_host_app_required",
    message: string,
  ) {
    super(message)
  }
}

export type ControlPlaneSandbox = {
  defaultDriver?: SandboxProvisionerID
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
 * every statement it issues is scoped to it) satisfy the port without restating it. For the
 * local SQLite registry the argument is the isolation boundary: omitting it
 * selects the named single-tenant partition (`__local__`), never a wildcard, so
 * an un-threaded call site fails closed rather than reading across tenants.
 */
export type ControlPlaneCredentials = {
  listCredentials: (org?: string) => Promise<CredentialMetadata[]>
  /** The rows the fanout would send for a scope, one per provider, secrets withheld. */
  effectiveCredentials?: (scope: "local" | "shared", org?: string) => Promise<CredentialMetadata[]>
  /**
   * Mark one account — every row that stores it — as the one its providers run
   * on. Optional: a store that holds a single record per provider has no second
   * account to choose between, and reports the operation as unsupported rather
   * than pretending the choice was made.
   */
  setActiveCredentials?: (ids: readonly string[], org?: string) => Promise<SetActiveCredentialsResult>
  /**
   * Leave these providers with no marked account, so each one's harness runs on
   * the login its own CLI holds. Optional for the same reason as the mark: a
   * store with one record per provider has no choice to withdraw.
   */
  clearActiveCredentials?: (providerIds: readonly string[], org?: string) => Promise<{ cleared: string[] }>
  /**
   * What each harness on THIS machine says about the login it would run on.
   * Absent wherever the host is not the machine the harnesses live on.
   */
  machineLogins?: (
    harnesses?: readonly HarnessId[],
    options?: { fresh?: boolean },
  ) => Promise<MachineLogin[]>
  getCredentialByProvider: (
    providerId: string,
    kind?: CredentialKind,
    org?: string,
  ) => Promise<CredentialMetadata | undefined>
  getCredential?: (id: string, org?: string) => Promise<CredentialMetadata | undefined>
  resolveCredentialSecret?: (providerId: string, org?: string) => Promise<string | null>
  resolveCredentialSecretById?: (id: string, org?: string) => Promise<string | null>
  putCredential: (input: CredentialWrite, org?: string) => Promise<CredentialMetadata>
  deleteCredential: (id: string, org?: string) => Promise<boolean>
  deleteCredentialsByProvider: (providerId: string, kind?: CredentialKind, org?: string) => Promise<number>
  updateCredentialStatus: (id: string, status: CredentialStatus, error?: string, org?: string) => Promise<void>
  updateCredentialHealth?: (id: string, health: CredentialHealth, validatedAt: number, org?: string) => Promise<void>
  /**
   * Keep the quota windows a verification read, so a surface can show them
   * again without spending another read. Optional: a store that cannot hold
   * them simply never records, and every read path reports no usage.
   */
  updateCredentialUsage?: (
    id: string,
    windows: readonly CredentialUsageWindow[],
    at: number,
    org?: string,
  ) => Promise<void>
  /**
   * The same for a login a harness on THIS machine holds, keyed by harness and
   * the address the harness named. Machine-wide and loopback-only, like
   * `machineLogins` itself, so neither takes an org.
   */
  readMachineLoginUsage?: () => Promise<MachineLoginUsage[]>
  recordMachineLoginUsage?: (
    harness: string,
    account: string,
    windows: readonly CredentialUsageWindow[],
    at: number,
  ) => Promise<void>
  discoverLocalCredentials?: (org?: string) => Promise<{ discovery_id: string; items: CredentialDiscoveryPreview[] }>
  saveDiscoveredCredentials?: (
    input: { discovery_id: string; items: CredentialDiscoverySelection[] },
    org?: string,
  ) => Promise<{
    saved: Array<{ credential_id: string; provider_id: string; kind: CredentialKind }>
  }>
  updateCredentialScope?: (id: string, scope: CredentialScope, consentAt: number, org?: string) => Promise<boolean>
  /**
   * Persist replacement secret material for an existing credential: an OAuth
   * refresh, or the account a user reconnected by hand. `expiresAt` of `null`
   * clears the stored expiry, which is what a replacement with no expiry of its
   * own means; omitting it keeps whatever is stored.
   */
  updateCredentialSecret?: (
    id: string,
    secret: string,
    expiresAt?: number | null,
    org?: string,
  ) => Promise<boolean>
  /** Rename a credential, leaving the auth material it stores untouched. */
  updateCredentialLabel?: (id: string, label: string, org?: string) => Promise<boolean>
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
  sandbox: ControlPlaneSandbox
  telemetry: ControlPlaneTelemetry
  localExecution: ControlPlaneLocalExecution
  defaultHomeRegion?: ClaxedoRegion
  authority?: WorkspaceAuthority
}
