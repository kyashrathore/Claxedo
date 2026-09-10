import type { AgentAssistantMessage } from "@claxedo/agent-runtime-contract"
import type { PartGroup, PartRef } from "./part-groups"

/**
 * Resolves a group member to the part it renders. A standalone group is foldable
 * only when it holds a tool, so the caller's part index is the only way to tell
 * machinery from prose.
 */
export type FoldablePartLookup = (ref: PartRef) => { type: string } | undefined

// A single tool is already one compact, useful row. Folding it replaces the only
// actionable content with an extra click and breaks the standalone-tool/task-card
// contract. Grouped runs count as one row because they own their own disclosure.
const SETTLED_FOLD_MINIMUM = 2
// A running turn keeps its latest group visible, so it needs one more than the
// settled minimum before the fold hides anything worth a click.
const RUNNING_FOLD_MINIMUM = 3

const NO_KEYS: ReadonlySet<string> = new Set()

export function assistantMessageSettled(message: AgentAssistantMessage) {
  return typeof message.time.completed === "number" || !!message.error
}

/**
 * What the fold is allowed to treat as machinery.
 *
 * `interleaved` is the only shape any harness currently earns. Every adapter feeds one
 * projection (agent-event-runtime client-presentation), which splits a new text or
 * reasoning part after every tool call, and no harness marks which text part is the
 * answer: `AgentAssistantMessage.finish` is never set natively, `AgentStepFinishPart` is
 * never emitted, and `{type:"finish"}` is turn-scoped. So narration and answer are
 * indistinguishable in the data.
 *
 * `final-message` applies the stand-in rule "the turn's last text part is the answer".
 * It is a preview, not a fact, and it is known to misfire: Codex emits plan markdown as
 * a text part, Claude emits local_command_output as a text part, Claude's non-streaming
 * path emits tools before that message's text while Cursor emits text before its tools,
 * and ACP splits one turn across many assistant messages. Making this correct needs an
 * adapter-set flag on the last text delta before `finish`, not a better guess here.
 */
export type TurnShape = "final-message" | "interleaved"

export type FoldScope = {
  shape?: TurnShape
  /** Ignored unless `shape` is `final-message`. */
  finalTextPartID?: string
}

/** The stand-in for a marker the harnesses do not provide. See `TurnShape`. */
export function finalTextPartID(groups: readonly PartGroup[], part: FoldablePartLookup) {
  let id: string | undefined
  for (const group of groups) {
    if (group.type !== "part") continue
    if (part(group.ref)?.type === "text") id = group.ref.partID
  }
  return id
}

/** Machinery — everything a turn did that is not the message it is addressing to the user. */
export function isFoldableGroup(group: PartGroup, part: FoldablePartLookup, scope: FoldScope = {}): boolean {
  if (group.type !== "part") return true
  const type = part(group.ref)?.type
  if (type === "tool") return true
  if (scope.shape !== "final-message") return false
  if (type === "reasoning") return true
  if (type === "text") return group.ref.partID !== scope.finalTextPartID
  return false
}

export function countFoldableGroups(groups: readonly PartGroup[], part: FoldablePartLookup, scope: FoldScope = {}) {
  return groups.reduce((count, group) => (isFoldableGroup(group, part, scope) ? count + 1 : count), 0)
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
}

/**
 * A settled turn folds its machinery behind one "Worked for Xs" divider, leaving
 * the prose visible; an explicit user toggle beats the auto-fold. An interrupted
 * or failed turn never folds, because the rows the fold would hide are the ones
 * that explain what happened.
 */
export function turnFoldDecision(status: TurnFoldStatus): TurnFoldDecision {
  const running = !!status.busy && !status.settled && !status.errored
  const canFoldSettled =
    status.foldWhenSettled !== false &&
    status.settled &&
    !status.interrupted &&
    !status.errored &&
    status.foldableCount >= SETTLED_FOLD_MINIMUM
  const canFoldRunning = running && !!status.foldWhileRunning && status.foldableCount >= RUNNING_FOLD_MINIMUM
  const canFold = canFoldSettled || canFoldRunning
  return {
    running,
    canFoldSettled,
    canFoldRunning,
    canFold,
    folded: canFold ? (status.userChoice ?? true) : false,
  }
}

/**
 * The groups the fold hides, keyed by `PartGroup.key`. A running turn folds its
 * *completed* phases only: its last foldable group is the live one and stays on
 * screen so active work never disappears.
 */
export function foldedGroupKeys(
  decision: TurnFoldDecision,
  groups: readonly PartGroup[],
  part: FoldablePartLookup,
  scope: FoldScope = {},
): ReadonlySet<string> {
  if (!decision.folded) return NO_KEYS
  const foldable = groups.filter((group) => isFoldableGroup(group, part, scope))
  const live = decision.canFoldRunning ? foldable.at(-1)?.key : undefined
  return new Set(foldable.filter((group) => group.key !== live).map((group) => group.key))
}
