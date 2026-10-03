import type { WorkspaceRuntimeApp } from "@claxedo/workspace-runtime"
import type { LaunchOwnershipRecord } from "@claxedo/process-ownership/launch"

export type EmbeddedWorkspaceRuntimeOwner = {
  workspaceId: string
  /** The mount this owner is; never repeated by a later mount of the same id. */
  generation: string
  state: "serving" | "retiring" | "retire_failed"
  attempt: number
  error?: string
  /** The admitted turns a drain would interrupt, named individually. */
  turns: Array<{ sessionId: string; turnId: string; ownerGeneration: string }>
}

/** Durable ownership is asynchronous; the immediate residency snapshot cannot wait for it. */
export type EmbeddedWorkspaceRuntimeOwnership = EmbeddedWorkspaceRuntimeOwner & {
  /** Absent when unreadable; an empty list would assert that nothing remains to reconcile. */
  launches?: LaunchOwnershipRecord[]
  launchesUnreadable?: string
}

type OwnedRuntime = {
  workspace: { id: string }
  generation: string
  host: Pick<WorkspaceRuntimeApp["host"], "activeTurns" | "unresolvedLaunches">
}

type RetiringRuntime = {
  workspaceId: string
  generation: string
  runtime: OwnedRuntime
  state: "retiring" | "retire_failed"
  attempt: number
  error?: string
}

type Description = { runtime: OwnedRuntime; owner: EmbeddedWorkspaceRuntimeOwner }

/** Ownership descriptions read the registry's current entries without managing their lifetime. */
export function createEmbeddedRuntimeOwnership(
  serving: () => Iterable<OwnedRuntime>,
  retiring: () => Iterable<RetiringRuntime>,
) {
  const turnsOf = (runtime: OwnedRuntime) => runtime.host.activeTurns().map((target) => ({
    sessionId: target.sessionId,
    turnId: target.turnId,
    ownerGeneration: target.ownerGeneration,
  }))

  function descriptions(): Description[] {
    return [
      ...[...serving()].map((runtime) => ({
        runtime,
        owner: {
          workspaceId: runtime.workspace.id,
          generation: runtime.generation,
          state: "serving" as const,
          attempt: 0,
          turns: turnsOf(runtime),
        },
      })),
      ...[...retiring()].map((record) => ({
        runtime: record.runtime,
        owner: {
          workspaceId: record.workspaceId,
          generation: record.generation,
          state: record.state,
          attempt: record.attempt,
          ...(record.error ? { error: record.error } : {}),
          turns: turnsOf(record.runtime),
        },
      })),
    ]
  }

  return {
    /** Every workspace this process still owns, serving or not. */
    owners(this: void): EmbeddedWorkspaceRuntimeOwner[] {
      return descriptions().map(({ owner }) => owner).sort((a, b) => a.workspaceId.localeCompare(b.workspaceId))
    },
    /** What a replacement would reconcile: admitted turns and unsettled durable launches. */
    async ownership(this: void): Promise<EmbeddedWorkspaceRuntimeOwnership[]> {
      const owned = await Promise.all(descriptions().map(async ({ runtime, owner }) => ({
        ...owner,
        ...(await unresolvedLaunchesOf(runtime)),
      })))
      return owned.sort((a, b) => a.workspaceId.localeCompare(b.workspaceId))
    },
  }
}

async function unresolvedLaunchesOf(runtime: OwnedRuntime) {
  try {
    return { launches: await runtime.host.unresolvedLaunches() }
  } catch (error) {
    // A retired owner's store is closed. Its retained records cannot be reported as absent.
    return { launchesUnreadable: String(error) }
  }
}
