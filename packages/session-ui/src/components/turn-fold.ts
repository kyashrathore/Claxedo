import type { AgentAssistantMessage } from "@claxedo/agent-runtime-contract"
import { isStandaloneTool, type PartGroup, type PartRef } from "./part-groups"

/**
 * Resolves a group member to the part it renders. A standalone group is foldable
 * only when it holds a tool, so the caller's part index is the only way to tell
 * machinery from prose.
 */
export type FoldablePartLookup = (ref: PartRef) => FoldablePart | undefined

type FoldablePart = { type: string; tool?: string }

// A single tool is already one compact, useful row: folding it replaces the only
// actionable content with an extra click. Grouped runs count as one row because
// they own their own disclosure.
const SETTLED_FOLD_MINIMUM = 2
// A running turn keeps its latest group visible, so it needs one more than the
// settled minimum before the fold hides anything worth a click.
const RUNNING_FOLD_MINIMUM = 3

const NO_KEYS: ReadonlySet<string> = new Set()

export function assistantMessageSettled(message: AgentAssistantMessage) {
  return typeof message.time.completed === "number" || !!message.error
}

/**
 * Machinery — everything a turn did that is not the message it is addressing to
 * the user, subagent spawns included: a running turn's auto-fold keeps its live
 * group on screen, so delegated work is visible while it is in flight and folds
 * with the rest once the turn moves past it. An answered question is not
 * machinery: it holds the words the reader typed, the one part of the turn they
 * authored, so it stays up beside the prose.
 *
 * Text and reasoning never fold. No harness marks which text part is the answer —
 * `AgentAssistantMessage.finish` is never set natively and `AgentStepFinishPart` is
 * never emitted — so narration and answer are indistinguishable here, and guessing
 * from position hides answers that arrived before the turn's last tool call.
 */
export function isFoldableGroup(group: PartGroup, part: FoldablePartLookup): boolean {
  if (group.type !== "part") return true
  const resolved = part(group.ref)
  return resolved?.type === "tool" && !isStandaloneTool(resolved)
}

export function countFoldableGroups(groups: readonly PartGroup[], part: FoldablePartLookup) {
  return groups.reduce((count, group) => (isFoldableGroup(group, part) ? count + 1 : count), 0)
}

export type TurnFoldStatus = {
  foldableCount: number
  settled: boolean
  interrupted?: boolean
  errored?: boolean
  /** The session is mid-turn on THIS turn. */
  busy?: boolean
  /** Folding a settled turn is the product rule, so omitting this opts in. */
  foldWhenSettled?: boolean
  /** Folding a running turn hides work the user is still watching, so omitting this opts out. */
  foldWhileRunning?: boolean
  /** An explicit user toggle. `undefined` leaves the turn on auto. */
  userChoice?: boolean
}

export type TurnFoldDecision = {
  running: boolean
  canFoldSettled: boolean
  canFoldRunning: boolean
  canFold: boolean
  folded: boolean
  /** The reader folded this turn themselves, rather than it folding on its own. */
  explicit: boolean
}

/**
 * A settled turn folds its machinery behind one "Worked for Xs" divider, leaving
 * the prose visible; an explicit user toggle beats the auto-fold.
 *
 * An interrupted or failed turn keeps the control but does not fold on its own:
 * the rows the fold would hide are the ones that explain what happened, so they
 * stay up unless the reader asks otherwise. Withholding the control instead
 * takes the fold away from a reader who was already using it — a turn expanded
 * by hand and then interrupted could never be collapsed again.
 */
export function turnFoldDecision(status: TurnFoldStatus): TurnFoldDecision {
  const running = !!status.busy && !status.settled && !status.errored
  const canFoldSettled =
    status.foldWhenSettled !== false && status.settled && status.foldableCount >= SETTLED_FOLD_MINIMUM
  const canFoldRunning = running && !!status.foldWhileRunning && status.foldableCount >= RUNNING_FOLD_MINIMUM
  const canFold = canFoldSettled || canFoldRunning
  const explainsItself = !!status.interrupted || !!status.errored
  return {
    running,
    canFoldSettled,
    canFoldRunning,
    canFold,
    folded: canFold ? (status.userChoice ?? !explainsItself) : false,
    explicit: status.userChoice !== undefined,
  }
}

/**
 * The groups the fold hides, keyed by `PartGroup.key`.
 *
 * A running turn folding on its own hides its *completed* phases only — the last
 * foldable group is the live one and stays on screen so active work never disappears.
 * A reader who folds the turn themselves means all of it, expanded rows included: a
 * row left open under a control that reads collapsed contradicts the control.
 */
export function foldedGroupKeys(
  decision: TurnFoldDecision,
  groups: readonly PartGroup[],
  part: FoldablePartLookup,
): ReadonlySet<string> {
  if (!decision.folded) return NO_KEYS
  const foldable = groups.filter((group) => isFoldableGroup(group, part))
  const live = decision.canFoldRunning && !decision.explicit ? foldable.at(-1)?.key : undefined
  return new Set(foldable.filter((group) => group.key !== live).map((group) => group.key))
}
