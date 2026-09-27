import { asFiniteNumber, asRecord } from "@claxedo/helpers/guards"

/**
 * Only the update stamp travels to the authority: a session's creation time is
 * written once, from the runtime's `time.created`, by its registration
 * (`registerRuntimeSession`), and a visibility upsert could only repeat it.
 */
export function pulledSessionUpdatedAt(
  session: Record<string, unknown>,
  Refusal: new (status: number, code: string, message: string) => Error,
) {
  const updatedAt = asFiniteNumber(asRecord(session.time)?.updated)
  if (updatedAt !== undefined) return updatedAt
  throw new Refusal(502, "workspace_runtime_snapshot_invalid", "Workspace runtime returned a session with no update time")
}
