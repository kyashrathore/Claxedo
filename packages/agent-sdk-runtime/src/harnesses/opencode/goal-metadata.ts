/**
 * The OpenCode engine's Goal announcement, read off its compatibility feed.
 *
 * The engine keeps a session's Goal snapshot in session metadata under
 * `claxedo.goal` (`packages/opencode/src/session/goal.ts`), and its one durable
 * write goes through `Session.setMetadata`, which publishes `session.updated`
 * carrying the whole session info. So every Goal transition the engine makes —
 * including the terminal one, which lands after the final work turn and is
 * followed by no turn at all — is already announced on `/global/event`.
 *
 * The key is mirrored rather than imported: neither package depends on the
 * other. `packages/opencode/test/session/goal-protocol.test.ts` pins this
 * module's copy against the engine's.
 */

import { isRuntimeGoalStatus, type RuntimeGoalSnapshot } from "@claxedo/agent-event-runtime"
import type { CompatEvent } from "../../compat-events"

export const OPENCODE_GOAL_METADATA_KEY = "claxedo.goal"

function goalSnapshot(value: unknown): RuntimeGoalSnapshot | undefined {
  if (!value || typeof value !== "object") return undefined
  const row = value as Record<string, unknown>
  if (typeof row.sessionId !== "string" || typeof row.objective !== "string") return undefined
  if (!isRuntimeGoalStatus(row.status)) return undefined
  if (typeof row.createdAt !== "number" || typeof row.updatedAt !== "number") return undefined
  return row as unknown as RuntimeGoalSnapshot
}

/**
 * The Goal state a `session.updated` announces, or `undefined` when the event
 * says nothing about a Goal.
 *
 * `null` is a real answer: metadata that names no Goal is what a deleted Goal
 * looks like on the wire. An event carrying no metadata at all announces
 * nothing — only a writer that touched metadata can speak for it. An
 * unreadable snapshot is likewise not an announcement: the engine only ever
 * writes a well-formed one, so anything else belongs to a different writer.
 */
export function announcedGoalSnapshot(event: CompatEvent): RuntimeGoalSnapshot | null | undefined {
  if (event.type !== "session.updated") return undefined
  const metadata = (event.properties.info as { metadata?: unknown }).metadata
  if (!metadata || typeof metadata !== "object") return undefined
  const raw = (metadata as Record<string, unknown>)[OPENCODE_GOAL_METADATA_KEY]
  if (raw === undefined || raw === null) return null
  return goalSnapshot(raw)
}
