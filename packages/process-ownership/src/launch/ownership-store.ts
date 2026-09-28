import type { CreationIdentity } from "./identity"
import type { RetirementResult } from "./retirement"

export type LaunchRole = "turn" | "harness" | "managed-process" | "terminal"

/**
 * `gate` proves a prepared launch never executed: the payload cannot run before
 * the host holds the gate's nonce. `direct` cannot, because the spawn itself is
 * the first durable event — a crash between the spawn and the identity write
 * leaves a process nothing recorded, which reconciles as unknown, never as none.
 */
export type LaunchProtocol = "gate" | "direct"

/**
 * Which rows a runtime's own launches are, and the only thing reconciliation
 * lists by.
 *
 * A workspace host names its workspace, because one store holds the launches
 * of every workspace mounted against it. A runtime nobody gave a workspace to
 * has a store of its own, and the rows in it that name no workspace are all
 * its own — there is nothing narrower to say, and saying a directory or a
 * minted label instead would file the row under a key the next owner of the
 * same store does not reproduce.
 */
export type LaunchOwnerScope =
  | { kind: "workspace"; workspaceId: string }
  | { kind: "standalone" }

/** What a launch names inside its owner's scope. */
export type LaunchSite = {
  sessionId?: string
  directory?: string
}

/** A recorded launch's whole scope: the store's owner, and what the launch named inside it. */
export type LaunchScope = LaunchOwnerScope & LaunchSite

export type PreparedLaunch = {
  launchId: string
  /**
   * The runtime that owns this launch: a workspace host's mount generation, or
   * a daemon's generation for a machine-owned one. Reconciliation is only ever
   * entitled to signal launches from a generation that is over — a row from
   * the generation doing the reconciling belongs to a process that is running
   * right now.
   */
  ownerGeneration: string
  role: LaunchRole
  protocol: LaunchProtocol
  parentOwnerId?: string
  scope: LaunchScope
  preparedAt: number
}

export type LaunchOwnershipRecord = PreparedLaunch & {
  identity?: CreationIdentity
  gateNonce?: string
  identityReceivedAt?: number
  activationAuthorizedAt?: number
  activationAcknowledgedAt?: number
  retiredAt?: number
  cleanup?: RetirementResult
}

export type PrepareLaunchInput = {
  role: LaunchRole
  protocol: LaunchProtocol
  parentOwnerId?: string
  /** Only what this launch names; the owner comes from the store, so no caller can file a row somewhere it will not be found. */
  scope?: LaunchSite
}

export type LaunchOwnershipOwner = {
  /** Identifies the owning runtime; every row this store prepares carries it. */
  ownerGeneration: string
  /** The scope every row this store prepares is filed under, and the one reconciliation lists by. */
  scope: LaunchOwnerScope
}

/**
 * The durable half of launch ownership. Every method may reject; a rejecting
 * `prepare` is what refuses a launch, because past that point the host would be
 * acknowledging a process it cannot recover.
 */
export interface LaunchOwnershipStore {
  /** The runtime this store prepares launches for. */
  readonly ownerGeneration: string
  prepare(input: PrepareLaunchInput): Promise<PreparedLaunch>
  recordIdentity(launchId: string, identity: CreationIdentity, gateNonce?: string): Promise<void>
  authorizeActivation(launchId: string): Promise<void>
  acknowledgeActivation(launchId: string): Promise<void>
  /** Retains the launch when cleanup is unresolved; only a settled result retires the row. */
  recordRetirement(launchId: string, result: RetirementResult): Promise<void>
  read(launchId: string): Promise<LaunchOwnershipRecord | undefined>
  /** Launches with no settled retirement, for reconciliation after an owner restart. */
  listUnresolved(scope: LaunchScope): Promise<LaunchOwnershipRecord[]>
}

export type ExecutionReconciliation = {
  execution: "none" | "unknown" | "started"
  because: string
}

export function reconcileLaunch(record: LaunchOwnershipRecord): ExecutionReconciliation {
  if (record.activationAcknowledgedAt) return { execution: "started", because: "the gate acknowledged activation" }
  if (record.activationAuthorizedAt) return { execution: "unknown", because: "activation was authorized and its delivery is unwitnessed" }
  if (record.protocol === "direct") {
    return record.identityReceivedAt
      ? { execution: "started", because: "the launcher recorded the spawned process's creation identity" }
      : { execution: "unknown", because: "a direct launch records identity after the spawn, so a prepared row alone cannot prove the spawn did not happen" }
  }
  if (record.identityReceivedAt) return { execution: "none", because: "the gate reported identity and activation was never authorized" }
  return { execution: "none", because: "no creation identity was ever received over the gate channel" }
}

export class LaunchRefusedError extends Error {
  readonly code = "launch_refused_ownership_unavailable"
  constructor(role: LaunchRole, cause: unknown) {
    super(`Refusing to launch ${role}: recoverable ownership could not be recorded (${cause instanceof Error ? cause.message : String(cause)})`, { cause })
    this.name = "LaunchRefusedError"
  }
}
