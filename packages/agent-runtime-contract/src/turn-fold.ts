import { asRecord } from "@claxedo/helpers/guards"
import { isSubagentSpawnToolName, type AgentAssistantMessage, type AgentContentPart, type AgentToolPart } from "./content"
import { canonicalToolName, claxedoToolName } from "./tool-names"

export type PartRef = {
  messageId: string
  partId: string
}

export type WorkGroupTool = "bash" | "edit" | "webfetch"

export type PartGroup =
  | {
      key: string
      type: "part"
      ref: PartRef
    }
  | {
      key: string
      type: "context"
      refs: PartRef[]
    }
  | {
      key: string
      type: "work"
      tool: WorkGroupTool
      refs: PartRef[]
    }
  | {
      key: string
      type: "agents"
      refs: PartRef[]
    }

export type GroupablePart = { messageId: string; part: AgentContentPart }

export const CONTEXT_GROUP_TOOLS = new Set(["read", "glob", "grep", "list"])

export const STANDALONE_TOOLS = new Set(["question"])

export const EDIT_TOOL_NAMES = new Set(["edit", "write", "apply_patch"])

export const WEB_TOOL_NAMES = new Set(["webfetch", "websearch"])

export const HIDDEN_TOOLS = new Set(["todowrite"])

const GROUPABLE_PART_TYPES = new Set(["compaction", "handoff", "text", "reasoning", "tool", "file"])

const NON_BLANK = /\S/

export function textIsPresent(text: string): boolean {
  return NON_BLANK.test(text)
}

export function partHasText(part: object): boolean {
  return "text" in part && typeof part.text === "string" && textIsPresent(part.text)
}

export function isHiddenTool(part: { type: string; tool?: string }): boolean {
  return part.type === "tool" && !!part.tool && HIDDEN_TOOLS.has(canonicalToolName(part.tool))
}

function producedImage(part: AgentToolPart) {
  const state = part.state
  if (state.status !== "completed") return false
  return !!state.attachments?.some((file) => file.mime.startsWith("image/"))
}

export function isStandaloneTool(part: { type: string; tool?: string }): boolean {
  return part.type === "tool" && !!part.tool && STANDALONE_TOOLS.has(canonicalToolName(part.tool))
}

export function isPendingQuestion(part: { type: string; tool?: string; state?: { status?: string } }): boolean {
  if (!isStandaloneTool(part)) return false
  const status = part.state?.status
  return status === "pending" || status === "running"
}

export function isContextGroupTool(part: AgentContentPart): part is AgentToolPart {
  if (part.type !== "tool" || !CONTEXT_GROUP_TOOLS.has(canonicalToolName(part.tool))) return false
  return !isClaxedoToolPart(part) && !producedImage(part)
}

export function isWorkGroupTool(part: AgentContentPart): part is AgentToolPart {
  if (part.type !== "tool") return false
  if (CONTEXT_GROUP_TOOLS.has(canonicalToolName(part.tool)) || isHiddenTool(part) || isStandaloneTool(part)) return false
  return !isSubagentToolPart(part) && !isClaxedoToolPart(part)
}

export function isClaxedoToolPart(part: { type: string; tool?: string; state?: { input?: unknown } }): boolean {
  if (part.type !== "tool" || !part.tool) return false
  return claxedoToolName(part.tool, asRecord(part.state?.input)) !== undefined
}

export function isSubagentToolPart(part: { type: string; tool?: string; state?: { input?: unknown } }): boolean {
  if (part.type !== "tool") return false
  if (part.tool && isSubagentSpawnToolName(part.tool)) return true
  const input = part.state?.input
  return typeof input === "object" && input !== null && (input as { intent?: unknown }).intent === "task"
}

function spawnFailed(part: AgentContentPart) {
  return part.type === "tool" && part.state.status === "error"
}

export function isGroupablePart(part: AgentContentPart, hasText: (part: AgentContentPart) => boolean, showReasoning: boolean) {
  if (part.type === "tool") {
    if (isHiddenTool(part)) return false
    return !isPendingQuestion(part)
  }
  if (part.type === "text") return hasText(part)
  if (part.type === "reasoning") return showReasoning && hasText(part)
  return GROUPABLE_PART_TYPES.has(part.type)
}

function partRef(item: GroupablePart): PartRef {
  return { messageId: item.messageId, partId: item.part.id }
}

function workGroupTool(slice: GroupablePart[]): WorkGroupTool {
  if (slice.some((item) => item.part.type === "tool" && EDIT_TOOL_NAMES.has(canonicalToolName(item.part.tool)))) return "edit"
  if (slice.some((item) => item.part.type === "tool" && WEB_TOOL_NAMES.has(canonicalToolName(item.part.tool)))) return "webfetch"
  return "bash"
}

export function groupParts(input: GroupablePart[]) {
  const parts = input.filter((item) => !isPendingQuestion(item.part))
  const result: PartGroup[] = []
  let contextStart = -1
  let workStart = -1
  let taskStart = -1

  const flushContext = (end: number) => {
    if (contextStart < 0) return
    const first = parts[contextStart]
    if (!first) {
      contextStart = -1
      return
    }
    result.push({
      key: `context:${first.part.id}`,
      type: "context",
      refs: parts.slice(contextStart, end + 1).map(partRef),
    })
    contextStart = -1
  }

  const flushWork = (end: number) => {
    if (workStart < 0) return
    const slice = parts.slice(workStart, end + 1)
    const first = parts[workStart]
    if (!first) {
      workStart = -1
      return
    }
    if (slice.length >= 2) {
      result.push({
        key: `work:${first.part.id}`,
        type: "work",
        tool: workGroupTool(slice),
        refs: slice.map(partRef),
      })
    } else {
      result.push({ key: `part:${first.messageId}:${first.part.id}`, type: "part", ref: partRef(first) })
    }
    workStart = -1
  }

  const flushTask = (end: number) => {
    if (taskStart < 0) return
    const slice = parts.slice(taskStart, end + 1)
    const first = parts[taskStart]
    if (!first) {
      taskStart = -1
      return
    }
    result.push({ key: `agents:${first.part.id}`, type: "agents", refs: slice.map(partRef) })
    taskStart = -1
  }

  parts.forEach((item, index) => {
    const isContext = isContextGroupTool(item.part)
    const isWork = isWorkGroupTool(item.part)
    const isTask = !isClaxedoToolPart(item.part) && isSubagentToolPart(item.part) && !spawnFailed(item.part)

    if (isContext) {
      flushWork(index - 1)
      flushTask(index - 1)
      if (contextStart < 0) contextStart = index
      return
    }

    if (isWork) {
      flushContext(index - 1)
      flushTask(index - 1)
      if (workStart < 0) workStart = index
      return
    }

    if (isTask) {
      flushContext(index - 1)
      flushWork(index - 1)
      if (taskStart < 0) taskStart = index
      return
    }

    flushContext(index - 1)
    flushWork(index - 1)
    flushTask(index - 1)
    result.push({ key: `part:${item.messageId}:${item.part.id}`, type: "part", ref: partRef(item) })
  })

  flushContext(parts.length - 1)
  flushWork(parts.length - 1)
  flushTask(parts.length - 1)
  return result
}

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

export function groupMembers(group: PartGroup): PartRef[] {
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

export type TurnPartRef = GroupablePart & { messageIndex: number }

export type TurnFoldShape = {
  /** The assistant message the turn was interrupted at, or -1. */
  interruptedMessageIndex: number
  /** The interruption is the message's own abort error rather than the runtime's cancelled outcome. */
  harnessInterrupted: boolean
  /** The message that failed the turn; an abort is an interruption, not a failure. */
  errorMessage: AgentAssistantMessage | undefined
  settled: boolean
  compaction: boolean
  refs: TurnPartRef[]
}

function assistantMessageInterrupted(message: AgentAssistantMessage) {
  if (message.error?.name === "MessageAbortedError") return true
  if (message.error?.name !== "UnknownError") return false
  return asRecord(message.error.data)?.message === "Codex turn aborted"
}

export function turnInterruption(messages: readonly AgentAssistantMessage[], cancelledAssistantMessageId?: string) {
  const harnessIndex = messages.findIndex(assistantMessageInterrupted)
  if (harnessIndex !== -1 || cancelledAssistantMessageId === undefined) return { index: harnessIndex, harness: harnessIndex !== -1 }
  return { index: messages.findIndex((message) => message.id === cancelledAssistantMessageId), harness: false }
}

export function turnFoldShape(input: {
  assistantMessages: readonly AgentAssistantMessage[]
  partsOf: (messageId: string) => readonly AgentContentPart[]
  hasText: (part: AgentContentPart) => boolean
  showReasoning: boolean
  compaction: boolean
  cancelledAssistantMessageId?: string
}): TurnFoldShape {
  const messages = input.assistantMessages
  const interruption = turnInterruption(messages, input.cancelledAssistantMessageId)
  const interrupted = interruption.index !== -1
  return {
    interruptedMessageIndex: interruption.index,
    harnessInterrupted: interruption.harness,
    errorMessage: messages.find((message) => message.error && message.error.name !== "MessageAbortedError"),
    settled: messages.some(assistantMessageSettled),
    compaction: input.compaction,
    refs: messages.flatMap((message, messageIndex) =>
      input.partsOf(message.id)
        .filter((part) =>
          isGroupablePart(part, input.hasText, input.showReasoning) &&
          !(interrupted && part.type === "tool" && (part.state.status === "pending" || part.state.status === "running")))
        .map((part) => ({ messageId: message.id, messageIndex, part })),
    ),
  }
}

export function turnSegments(
  refs: readonly TurnPartRef[],
  shape: Pick<TurnFoldShape, "interruptedMessageIndex" | "compaction">,
): PartGroup[][] {
  if (shape.interruptedMessageIndex === -1 || shape.compaction) return [groupParts([...refs])]
  return [
    groupParts(refs.filter((ref) => ref.messageIndex <= shape.interruptedMessageIndex)),
    groupParts(refs.filter((ref) => ref.messageIndex > shape.interruptedMessageIndex)),
  ]
}
