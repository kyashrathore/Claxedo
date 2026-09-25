import type { AgentAssistantMessage } from "@claxedo/agent-runtime-contract"
import type { PartGroup, PartRef } from "./part-groups"

export type FoldablePartLookup = (ref: PartRef) => FoldablePart | undefined

type FoldablePart = { type: string; userOpen?: boolean }

export const FOLD_MINIMUM = 2

const NO_KEYS: ReadonlySet<string> = new Set()

export function assistantMessageSettled(message: AgentAssistantMessage) {
  return typeof message.time.completed === "number" || !!message.error
}

export function answerGroupKey(groups: readonly PartGroup[], part: FoldablePartLookup): string | undefined {
  return groups.findLast((group) => group.type === "part" && part(group.ref)?.type === "text")?.key
}

export function isFoldableGroup(group: PartGroup, part: FoldablePartLookup, answerKey: string | undefined): boolean {
  if (group.type !== "part") return true
  if (group.key === answerKey) return false
  const resolved = part(group.ref)
  if (!resolved) return false
  return resolved.type === "text" || resolved.type === "reasoning" || resolved.type === "tool"
}

export function countFoldableGroups(groups: readonly PartGroup[], part: FoldablePartLookup) {
  const answerKey = answerGroupKey(groups, part)
  return groups.reduce((count, group) => (isFoldableGroup(group, part, answerKey) ? count + 1 : count), 0)
}

export type TurnFoldStatus = {
  foldableCount: number
  settled: boolean
  interrupted?: boolean
  errored?: boolean
  busy?: boolean
  partsPending?: boolean
  foldWhenSettled?: boolean
  userChoice?: boolean
}

export type TurnFoldDecision = {
  canFold: boolean
  folded: boolean
  explicit: boolean
}

export function turnFoldDecision(status: TurnFoldStatus): TurnFoldDecision {
  const running = !!status.busy && !status.errored
  const canFold =
    !running &&
    status.foldWhenSettled !== false &&
    status.settled &&
    (status.foldableCount >= FOLD_MINIMUM || !!status.partsPending)
  const explainsItself = !!status.interrupted || !!status.errored
  return {
    canFold,
    folded: canFold ? (status.userChoice ?? !explainsItself) : false,
    explicit: status.userChoice !== undefined,
  }
}

function groupMembers(group: PartGroup): PartRef[] {
  return group.type === "part" ? [group.ref] : group.refs
}

export function foldedGroupKeys(
  decision: TurnFoldDecision,
  groups: readonly PartGroup[],
  part: FoldablePartLookup,
): ReadonlySet<string> {
  if (!decision.folded) return NO_KEYS
  const answerKey = answerGroupKey(groups, part)
  return new Set(
    groups
      .filter(
        (group) =>
          isFoldableGroup(group, part, answerKey) &&
          (decision.explicit || !groupMembers(group).some((ref) => part(ref)?.userOpen)),
      )
      .map((group) => group.key),
  )
}
