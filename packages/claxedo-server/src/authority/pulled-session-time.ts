import { asFiniteNumber, asRecord } from "@claxedo/helpers/guards"

/**
 * The projection records a pulled session at its runtime's own times, so one
 * without both is refused. Only the update stamp travels to the authority: a
 * session's creation time is written once, from the runtime's `time.created`,
 * by its registration (`registerRuntimeSession`), and a visibility upsert could
 * only repeat it.
 */
export function pulledSessionUpdatedAt(
  session: Record<string, unknown>,
  Refusal: new (status: number, code: string, message: string) => Error,
) {
  const time = asRecord(session.time)
  const updatedAt = asFiniteNumber(time?.updated)
  if (updatedAt !== undefined && asFiniteNumber(time?.created) !== undefined) return updatedAt
  throw new Refusal(502, "workspace_runtime_snapshot_invalid", "Workspace runtime returned a session without its creation and update times")
}
