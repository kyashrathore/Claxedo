import { randomUUID } from "node:crypto"
import type {
  LaunchOwnershipRecord,
  LaunchOwnershipStore,
  LaunchScope,
  PrepareLaunchInput,
} from "./ownership-store"
import type { CreationIdentity } from "./identity"
import { retirementSettled, type RetirementResult } from "./retirement"

/**
 * Launch ownership that lives and dies with this process. It is what a
 * composition that has not been given durable storage actually has, and saying
 * so is the point: a record here cannot be reconciled after a restart, so every
 * launch it backs is an orphan waiting to happen. Host compositions inject the
 * durable store instead.
 */
export function volatileLaunchOwnership(): LaunchOwnershipStore {
  const records = new Map<string, LaunchOwnershipRecord>()
  const require = (launchId: string) => {
    const record = records.get(launchId)
    if (!record) throw new Error(`No prepared launch ${launchId}`)
    return record
  }
  return {
    async prepare(input: PrepareLaunchInput) {
      const prepared: LaunchOwnershipRecord = {
        launchId: randomUUID(),
        role: input.role,
        protocol: input.protocol,
        ...(input.parentOwnerId ? { parentOwnerId: input.parentOwnerId } : {}),
        scope: input.scope,
        preparedAt: Date.now(),
      }
      records.set(prepared.launchId, prepared)
      return prepared
    },
    async recordIdentity(launchId: string, identity: CreationIdentity, gateNonce?: string) {
      const record = require(launchId)
      record.identity = identity
      if (gateNonce) record.gateNonce = gateNonce
      record.identityReceivedAt = Date.now()
    },
    async authorizeActivation(launchId: string) {
      require(launchId).activationAuthorizedAt = Date.now()
    },
    async acknowledgeActivation(launchId: string) {
      require(launchId).activationAcknowledgedAt = Date.now()
    },
    async recordRetirement(launchId: string, result: RetirementResult) {
      const record = require(launchId)
      record.cleanup = result
      if (retirementSettled(result)) record.retiredAt = Date.now()
    },
    async read(launchId: string) {
      return records.get(launchId)
    },
    async listUnresolved(scope?: LaunchScope) {
      return Array.from(records.values()).filter((record) => !record.retiredAt && scopeMatches(record.scope, scope))
    },
  }
}

function scopeMatches(record: LaunchScope, query?: LaunchScope) {
  if (!query) return true
  return (["workspaceId", "sessionId", "directory"] as const).every((key) => query[key] === undefined || query[key] === record[key])
}
