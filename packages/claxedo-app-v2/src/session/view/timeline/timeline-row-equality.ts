import type { AgentContentPart as PartType } from "@claxedo/agent-runtime-contract"
import type { TurnOutcome } from "./model"

export function sameArrayItems<T>(previous: readonly T[], next: readonly T[]) {
  if (previous === next) return true
  if (previous.length !== next.length) return false
  for (let i = 0; i < previous.length; i++) {
    if (previous[i] !== next[i]) return false
  }
  return true
}

export function samePartsRecord(previous: Record<string, PartType[]>, next: Record<string, PartType[]>) {
  const previousKeys = Object.keys(previous)
  if (previousKeys.length !== Object.keys(next).length) return false
  for (const key of previousKeys) {
    if (previous[key] !== next[key]) return false
  }
  return true
}

export function sameTurnOutcome(previous: TurnOutcome | undefined, next: TurnOutcome | undefined) {
  if (previous === next) return true
  if (!previous || !next) return false
  return (
    previous.status === next.status &&
    previous.completedAt === next.completedAt &&
    previous.assistantMessageId === next.assistantMessageId
  )
}
