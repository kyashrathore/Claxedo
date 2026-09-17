import type { AgentAssistantMessage } from "@claxedo/agent-runtime-contract"
import { isStandaloneTool, type PartGroup, type PartRef } from "./part-groups"

/**
 * Resolves a group member to the part it renders. A standalone group is foldable
 * only when it holds a tool, so the caller's part index is the only way to tell
 * machinery from prose.
 */
export type FoldablePartLookup = (ref: PartRef) => FoldablePart | undefined

type FoldablePart = { type: string; tool?: string; userOpen?: boolean }

// A single tool is already one compact, useful row: folding it replaces the only
// actionable content with an extra click. Grouped runs count as one row because
// they own their own disclosure.
const FOLD_MINIMUM = 2

const NO_KEYS: ReadonlySet<string> = new Set()

export function assistantMessageSettled(message: AgentAssistantMessage) {
  return typeof message.time.completed === "number" || !!message.error
}

/**
 * Machinery — everything a turn did that is not the message it is addressing to
 * the user, subagent spawns included. An answered question is not machinery: it
 * holds the words the reader typed, the one part of the turn they authored, so
 * it stays up beside the prose.
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
  /** An explicit user toggle. `undefined` leaves the turn on auto. */
  userChoice?: boolean
}

export type TurnFoldDecision = {
  canFold: boolean
  folded: boolean
  /** The reader folded this turn themselves, rather than it folding on its own. */
  explicit: boolean
}

/**
 * A finished turn folds its machinery behind one "Worked for Xs" divider, leaving
 * the prose visible; an explicit user toggle beats the auto-fold.
 *
 * A turn the session is still working on gets no fold and no control: the rows
 * are the work the reader is watching, and `settled` alone cannot tell a finished
 * turn from one between steps.
 *
 * An interrupted or failed turn keeps the control but does not fold on its own:
 * the rows the fold would hide are the ones that explain what happened, so they
 * stay up unless the reader asks otherwise. Withholding the control instead
 * takes the fold away from a reader who was already using it — a turn expanded
 * by hand and then interrupted could never be collapsed again.
 */
export function turnFoldDecision(status: TurnFoldStatus): TurnFoldDecision {
  const running = !!status.busy && !status.errored
  const canFold =
    !running && status.foldWhenSettled !== false && status.settled && status.foldableCount >= FOLD_MINIMUM
  const explainsItself = !!status.interrupted || !!status.errored
  return {
    canFold,
    folded: canFold ? (status.userChoice ?? !explainsItself) : false,
    explicit: status.userChoice !== undefined,
  }
}

/**
 * The groups the fold hides, keyed by `PartGroup.key`.
 *
 * A reader who folds the turn themselves means all of it, expanded rows included: a
 * row left open under a control that reads collapsed contradicts the control.
 */
function groupMembers(group: PartGroup): PartRef[] {
  return group.type === "part" ? [group.ref] : group.refs
}

export function foldedGroupKeys(
  decision: TurnFoldDecision,
  groups: readonly PartGroup[],
  part: FoldablePartLookup,
): ReadonlySet<string> {
  if (!decision.folded) return NO_KEYS
  return new Set(
    groups
      .filter(
        // An automatic fold must not take a row the reader opened themselves;
        // an explicit fold already means all of it.
        (group) =>
          isFoldableGroup(group, part) &&
          (decision.explicit || !groupMembers(group).some((ref) => part(ref)?.userOpen)),
      )
      .map((group) => group.key),
  )
}
