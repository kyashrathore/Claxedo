// Identity-based equality gates for the per-message timeline row memos,
// split from message-timeline.tsx (size budget). Unchanged messages keep
// their object identities across conversation snapshots, so element-wise
// `===` is exact and cheap.
import type { Part as PartType } from "@opencode-ai/sdk/v2"
import type { SessionTurnOutcome } from "@/features/session/data/session-types"

// Identity-based equality gates for the per-message row memos. Unchanged
// messages keep their object identities across conversation snapshots, so
// element-wise `===` is exact and cheap.
export function sameArrayItems<T>(previous: readonly T[], next: readonly T[]): boolean
export function sameArrayItems<T>(previous: readonly T[] | undefined, next: readonly T[] | undefined): boolean
export function sameArrayItems<T>(previous: readonly T[] | undefined, next: readonly T[] | undefined) {
  if (previous === next) return true
  if (!previous || !next) return false
  if (previous.length !== next.length) return false
  for (let i = 0; i < previous.length; i++) {
    if (previous[i] !== next[i]) return false
  }
  return true
}

export function samePartsRecord(previous: Record<string, PartType[]>, next: Record<string, PartType[]>): boolean
export function samePartsRecord(
  previous: Record<string, PartType[]> | undefined,
  next: Record<string, PartType[]> | undefined,
): boolean
export function samePartsRecord(
  previous: Record<string, PartType[]> | undefined,
  next: Record<string, PartType[]> | undefined,
) {
  if (previous === next) return true
  if (!previous || !next) return false
  const previousKeys = Object.keys(previous)
  if (previousKeys.length !== Object.keys(next).length) return false
  for (const key of previousKeys) {
    if (previous[key] !== next[key]) return false
  }
  return true
}

// `lastTurn` rides on the directory session-cache row, whose object identity
// changes on every cache write; compare the fields the timeline consumes so a
// row refresh with an unchanged outcome does not invalidate every turn.
export function sameTurnOutcome(previous: SessionTurnOutcome | undefined, next: SessionTurnOutcome | undefined) {
  if (previous === next) return true
  if (!previous || !next) return false
  return (
    previous.status === next.status &&
    previous.completedAt === next.completedAt &&
    previous.assistantMessageId === next.assistantMessageId
  )
}
