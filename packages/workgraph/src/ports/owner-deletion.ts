import type { OperationID, WorkGraphContext } from "../contracts"

export type WorkGraphOwnerDeletionResult = Readonly<{
  deleted: true
  recordCount: number
  workspaceCount: number
  completedAt: number
}>

export type WorkGraphOwnerDeletionErrorReason =
  | "forbidden"
  | "not_quiescent"
  | "in_progress"
  | "cleanup_failed"
  | "storage_failed"

/** Stable, redacted failure vocabulary shared by every persistence adapter. */
export class WorkGraphOwnerDeletionError extends Error {
  static override [Symbol.hasInstance](value: unknown) {
    if (!value || typeof value !== "object") return false
    const candidate = value as { name?: unknown; reason?: unknown }
    return candidate.name === "WorkGraphOwnerDeletionError" && [
      "forbidden",
      "not_quiescent",
      "in_progress",
      "cleanup_failed",
      "storage_failed",
    ].includes(String(candidate.reason))
  }

  constructor(readonly reason: WorkGraphOwnerDeletionErrorReason) {
    super(`WorkGraph owner deletion failed: ${reason}`)
    this.name = "WorkGraphOwnerDeletionError"
  }
}

export type WorkGraphOwnerDeletionPort = Readonly<{
  /**
   * Permanently removes the trusted owner's complete WorkGraph state.
   * Exact retries of a completed operation return the original result.
   * An adapter may retain a redacted, non-owner deletion receipt solely to
   * provide that replay after all owner-scoped and command-idempotency rows are gone.
   */
  deleteOwner(
    context: WorkGraphContext,
    input: Readonly<{ operationId: OperationID }>,
  ): Promise<WorkGraphOwnerDeletionResult>
}>
