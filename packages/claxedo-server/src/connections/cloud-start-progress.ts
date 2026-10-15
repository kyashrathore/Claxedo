import type { SandboxStartPhase } from "@claxedo/sandbox-contract"
import type { SandboxBootMode, SandboxTargetResult } from "@claxedo/sandbox-manager"
import type { ClaxedoRegion } from "@claxedo/server-core/platform/runtime/region/index"

/** How far a cloud start has come, timed on this server's clock so a caller's own clock never enters the arithmetic. */
export type CloudStartProgress = { phases: SandboxStartPhase[]; sinceStartMs: number; sinceStepMs: number }

type ProvisioningFacts = {
  workspaceId: string
  homeRegion: ClaxedoRegion
  retryAfterMs?: number
  bootMode?: SandboxBootMode
  failure?: string
  /** The lease epoch the answering start runs on; the lease's recorded start is reported only when it is that epoch's. */
  epoch?: number
}

function startOf(target: SandboxTargetResult, epoch: number | undefined) {
  const start = target.start
  return start && (epoch === undefined || start.epoch === epoch) ? start : undefined
}

/** How long the start the lease records for `epoch` has run by this server's clock; nothing when the lease records no start of that epoch. */
export function startElapsedMs(target: SandboxTargetResult, epoch: number, now = Date.now()): number | undefined {
  const start = startOf(target, epoch)
  return start ? Math.max(0, now - start.requestedAt) : undefined
}

/**
 * The provisioning connection answer, the connect and the read alike: the
 * start's own facts, and the phases its lease has recorded so far, with the
 * time since the start the person is waiting on began and since its last
 * observed phase ended. A lease already ready while its run still delivers
 * the runtime its settings reports every phase, so the wait reads as
 * connecting, timed from the runtime's readiness. A start the lease has not
 * recorded yet answers no progress rather than an empty one.
 */
export function provisioningConnection(facts: ProvisioningFacts, target: SandboxTargetResult) {
  const start = startOf(target, facts.epoch)
  const bootMode = facts.bootMode ?? start?.bootMode
  const now = Date.now()
  return {
    status: "provisioning" as const,
    workspaceId: facts.workspaceId,
    homeRegion: facts.homeRegion,
    ...(facts.retryAfterMs !== undefined ? { retryAfterMs: facts.retryAfterMs } : {}),
    ...(bootMode ? { bootMode } : {}),
    ...(facts.failure ? { failure: facts.failure } : {}),
    ...(start
      ? { progress: { phases: start.phases, sinceStartMs: Math.max(0, now - start.requestedAt), sinceStepMs: Math.max(0, now - start.markedAt) } satisfies CloudStartProgress }
      : {}),
  }
}
