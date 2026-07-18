import { parseCommentNote, readCommentMetadata } from "@/features/session/data/comment-note"
import { AssistantMessage, Part, SessionStatus, SnapshotFileDiff, UserMessage } from "@opencode-ai/sdk/v2"
import type { PartGroup, WorkGroupTool } from "@/ui/session-kit"
import { Data, Equal } from "effect"
import { firstTurnRecoveryClass, type FirstTurnRecoveryClass } from "../onboarding/first-turn-recovery"

export type SummaryDiff = SnapshotFileDiff & { file: string }

// Keeps the last diff per file in display order. Set-based so large
// summaries stay linear instead of scanning the result per diff.
export function uniqueSummaryDiffs(diffs: SnapshotFileDiff[] | undefined) {
  const files = new Set<string>()
  return (diffs ?? [])
    .reduceRight<SummaryDiff[]>((result, diff) => {
      if (!isSummaryDiff(diff)) return result
      if (files.has(diff.file)) return result
      files.add(diff.file)
      result.push(diff)
      return result
    }, [])
    .reverse()
}

function isSummaryDiff(value: SnapshotFileDiff): value is SummaryDiff {
  return typeof value.file === "string"
}

export type TimelineRowMap = {
  TurnGap: { userMessageID: string }
  CommentStrip: {
    userMessageID: string
  }
  UserMessage: {
    userMessageID: string
    anchor: boolean
  }
  TurnDivider: {
    userMessageID: string
    label: "compaction" | "interrupted"
  }
  AssistantPart: {
    userMessageID: string
    group: PartGroup
    previousAssistantPart: boolean
    lastAssistantPart: boolean
  }
  Thinking: { userMessageID: string; reasoningHeading?: string }
  Retry: { userMessageID: string }
  TurnFold: {
    userMessageID: string
    durationMs?: number
    foldCount: number
    folded: boolean
    running?: boolean
    tokens?: number
    cost?: number
  }
  DiffSummary: { userMessageID: string; diffs: SummaryDiff[] }
  Error: { userMessageID: string; text: string; recoveryClass?: FirstTurnRecoveryClass }
}

export namespace TimelineRow {
  export class TurnGap extends Data.TaggedClass("TurnGap")<{
    userMessageID: string
  }> {}
  export class CommentStrip extends Data.TaggedClass("CommentStrip")<{
    userMessageID: string
  }> {}
  export class UserMessage extends Data.TaggedClass("UserMessage")<{
    userMessageID: string
    anchor: boolean
  }> {}
  export class TurnDivider extends Data.TaggedClass("TurnDivider")<{
    userMessageID: string
    label: "compaction" | "interrupted"
  }> {}
  export class AssistantPart extends Data.TaggedClass("AssistantPart")<{
    userMessageID: string
    group: PartGroup
    previousAssistantPart: boolean
    lastAssistantPart: boolean
  }> {}
  export class Thinking extends Data.TaggedClass("Thinking")<{
    userMessageID: string
    reasoningHeading?: string
  }> {}
  export class DiffSummary extends Data.TaggedClass("DiffSummary")<{
    userMessageID: string
    diffs: SummaryDiff[]
  }> {}
  export class Error extends Data.TaggedClass("Error")<{
    userMessageID: string
    text: string
    recoveryClass?: FirstTurnRecoveryClass
  }> {}
  export class Retry extends Data.TaggedClass("Retry")<{
    userMessageID: string
  }> {}
  export class TurnFold extends Data.TaggedClass("TurnFold")<{
    userMessageID: string
    durationMs?: number
    foldCount: number
    folded: boolean
    running?: boolean
    tokens?: number
    cost?: number
  }> {}

  export type TimelineRow =
    | TurnGap
    | CommentStrip
    | UserMessage
    | TurnDivider
    | AssistantPart
    | Thinking
    | DiffSummary
    | Error
    | Retry
    | TurnFold

  export const key = (row: TimelineRow) => {
    switch (row._tag) {
      case "TurnGap":
        return `turn-gap:${row.userMessageID}`
      case "CommentStrip":
        return `comment-strip:${row.userMessageID}`
      case "UserMessage":
        return `user-message:${row.userMessageID}`
      case "TurnDivider":
        return `turn-divider:${row.userMessageID}:${row.label}`
      case "AssistantPart":
        return `assistant-part:${row.userMessageID}:${row.group.key}`
      case "Thinking":
        return `thinking:${row.userMessageID}`
      case "DiffSummary":
        return `diff-summary:${row.userMessageID}`
      case "Error":
        return `error:${row.userMessageID}`
      case "Retry":
        return `retry:${row.userMessageID}`
      case "TurnFold":
        return `turn-fold:${row.userMessageID}`
    }
  }

  export function is(value: unknown): value is TimelineRow {
    if (!value || typeof value !== "object" || !("_tag" in value)) return false
    switch ((value as { _tag?: unknown })._tag) {
      case "TurnGap":
      case "CommentStrip":
      case "UserMessage":
      case "TurnDivider":
      case "AssistantPart":
      case "Thinking":
      case "DiffSummary":
      case "Error":
      case "Retry":
      case "TurnFold":
        return true
    }
    return false
  }

  export function equals(a: TimelineRow, b: TimelineRow) {
    return Equal.equals(a, b)
  }

  export function reuse(previous: TimelineRow[] | undefined, rows: TimelineRow[]) {
    const currentRows = rows.filter(is)
    if (!previous?.length) return currentRows
    const byKey = new Map(previous.filter(is).map((row) => [key(row), row] as const))
    return currentRows.map((row) => {
      const existing = byKey.get(key(row))
      if (!existing) return row
      return equals(existing, row) ? existing : row
    })
  }
}

export namespace Timeline {
  export function constructMessageRows(
    userMessage: UserMessage,
    getMessageParts: (messageID: string) => Part[],
    assistantMessages: AssistantMessage[],
    index: number,
    showReasoning: boolean,
    status: SessionStatus["type"],
    isActive: boolean,
    firstTurnRecovery = index === 0,
    isFoldedChoice: (userMessageID: string) => boolean | undefined = () => undefined,
    foldWhileRunning = false,
  ) {
    const rows: TimelineRow.TimelineRow[] = []

    const previousUserMessage = index > 0
    const userParts = getMessageParts(userMessage.id)
    const comments = userParts.flatMap((p) => MessageComment.fromPart(p) ?? [])
    const compaction = userParts.some((p) => p.type === "compaction")
    const interruptedMessageIndex = assistantMessages.findIndex((m) => m.error?.name === "MessageAbortedError")
    const interrupted = interruptedMessageIndex !== -1
    const error = assistantMessages.find((m) => m.error && m.error.name !== "MessageAbortedError")?.error
    const settled = assistantMessages.some(assistantMessageSettled)
    const assistantPartRefs = assistantMessages.flatMap((message, messageIndex) =>
      getMessageParts(message.id)
        .filter((part) => renderablePart(part, showReasoning))
        .map((part) => ({ messageID: message.id, messageIndex, part })),
    )
    const assistantItems =
      interrupted && !compaction
        ? [
            ...groupParts(assistantPartRefs.filter((ref) => ref.messageIndex <= interruptedMessageIndex)).map(
              (group) => ({
                type: "part" as const,
                group,
              }),
            ),
            { type: "interrupted" as const },
            ...groupParts(assistantPartRefs.filter((ref) => ref.messageIndex > interruptedMessageIndex)).map(
              (group) => ({
                type: "part" as const,
                group,
              }),
            ),
          ]
        : groupParts(assistantPartRefs).map((group) => ({ type: "part" as const, group }))
    if (previousUserMessage) rows.push(new TimelineRow.TurnGap({ userMessageID: userMessage.id }))

    if (comments.length > 0)
      rows.push(
        new TimelineRow.CommentStrip({
          userMessageID: userMessage.id,
        }),
      )

    rows.push(
      new TimelineRow.UserMessage({
        userMessageID: userMessage.id,
        anchor: comments.length === 0,
      }),
    )

    if (compaction) {
      rows.push(
        new TimelineRow.TurnDivider({
          userMessageID: userMessage.id,
          label: "compaction",
        }),
      )
    }

    // Turn fold (T5): when a turn is settled and produced ≥2 foldable rows (work/context
    // groups + standalone tool parts), its work folds behind one "Worked for Xs" divider,
    // leaving the prose visible. Auto-folds on completion; an explicit user toggle wins.
    const partByID = new Map(assistantPartRefs.map((ref) => [ref.part.id, ref.part] as const))
    const isGroupFoldable = (group: PartGroup): boolean => {
      if (group.type === "context" || group.type === "work" || group.type === "agents") return true
      if (group.type === "part") return partByID.get(group.ref.partID)?.type === "tool"
      return false
    }
    const foldableCount = assistantItems.filter((item) => item.type === "part" && isGroupFoldable(item.group)).length
    const completedTimes = assistantMessages
      .map((message) => message.time.completed)
      .filter((value): value is number => typeof value === "number")
    const createdTime = userMessage.time?.created
    const durationMs =
      completedTimes.length && typeof createdTime === "number"
        ? Math.max(0, Math.max(...completedTimes) - createdTime)
        : undefined
    const running = isActive && status === "busy" && !settled && !error
    const canFoldSettled = settled && !interrupted && !error && foldableCount >= 2
    // T7: while a turn is still running, fold its *completed* phases (≥3 groups) behind the
    // summary but keep the latest live group visible so active work never disappears.
    const canFoldRunning = running && foldWhileRunning && foldableCount >= 3
    const userChoice = isFoldedChoice(userMessage.id)
    const foldActive = canFoldSettled || canFoldRunning ? (userChoice ?? true) : false
    const turnTokens = assistantMessages.reduce((sum, message) => {
      const t = message.tokens
      if (!t) return sum
      return sum + (t.input ?? 0) + (t.output ?? 0) + (t.reasoning ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0)
    }, 0)
    const turnCost = assistantMessages.reduce((sum, message) => sum + (message.cost ?? 0), 0)

    let lastFoldableIndex = -1
    assistantItems.forEach((item, i) => {
      if (item.type === "part" && isGroupFoldable(item.group)) lastFoldableIndex = i
    })
    const shouldFold = (item: (typeof assistantItems)[number], itemIndex: number) => {
      if (!foldActive || item.type !== "part" || !isGroupFoldable(item.group)) return false
      // Running-only phase fold keeps the last (live) group visible.
      if (canFoldRunning && !canFoldSettled && itemIndex === lastFoldableIndex) return false
      return true
    }
    const emittedCount = assistantItems.filter((item, i) => item.type === "part" && !shouldFold(item, i)).length

    // The fold row is the turn's HEADER (D§3.6): "Worked for 2m 14s" + a hairline rule
    // sits above the turn's content, not wherever the first tool happened to land. Folded
    // hides the work beneath it; unfolded reveals it in place.
    if (canFoldSettled || canFoldRunning) {
      rows.push(
        new TimelineRow.TurnFold({
          userMessageID: userMessage.id,
          durationMs,
          foldCount: foldableCount,
          folded: foldActive,
          running: running && !settled,
          tokens: turnTokens,
          cost: turnCost,
        }),
      )
    }

    let assistantGroupIndex = 0
    assistantItems.forEach((item, itemIndex) => {
      if (item.type === "interrupted") {
        rows.push(
          new TimelineRow.TurnDivider({
            userMessageID: userMessage.id,
            label: "interrupted",
          }),
        )
        return
      }

      if (shouldFold(item, itemIndex)) return

      rows.push(
        new TimelineRow.AssistantPart({
          userMessageID: userMessage.id,
          group: item.group,
          previousAssistantPart: assistantGroupIndex > 0,
          lastAssistantPart: assistantGroupIndex === emittedCount - 1,
        }),
      )
      assistantGroupIndex += 1
    })

    if (isActive && status === "busy" && !settled && !error && (showReasoning ? assistantPartRefs.length === 0 : true)) {
      const heading = assistantMessages
        .flatMap((message) => getMessageParts(message.id))
        .map((part) => (part.type === "reasoning" && part.text ? reasoningHeading(part.text) : undefined))
        .find((value): value is string => !!value)

      rows.push(
        new TimelineRow.Thinking({
          userMessageID: userMessage.id,
          reasoningHeading: heading,
        }),
      )
    }

    if (isActive && status === "retry") rows.push(new TimelineRow.Retry({ userMessageID: userMessage.id }))

    const diffs = uniqueSummaryDiffs(userMessage.summary?.diffs)
    if (diffs.length > 0 && (status === "idle" || !isActive)) {
      rows.push(
        new TimelineRow.DiffSummary({
          userMessageID: userMessage.id,
          diffs,
        }),
      )
    }

    if (error) {
      const data = error.data?.message
      rows.push(
        new TimelineRow.Error({
          userMessageID: userMessage.id,
          text: unwrapErrorMessage(
            typeof data === "string" ? data : data === undefined || data === null ? "" : String(data),
          ),
          ...(firstTurnRecovery ? { recoveryClass: firstTurnRecoveryClass(error) } : {}),
        }),
      )
    }

    return rows
  }

  function reasoningHeading(text: string) {
    const markdown = text.replace(/\r\n?/g, "\n")
    const html = markdown.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i)
    if (html?.[1]) {
      const value = cleanHeading(html[1].replace(/<[^>]+>/g, " "))
      if (value) return value
    }

    const atx = markdown.match(/^\s{0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+[ \t]*)?$/m)
    if (atx?.[1]) {
      const value = cleanHeading(atx[1])
      if (value) return value
    }

    const setext = markdown.match(/^([^\n]+)\n(?:=+|-+)\s*$/m)
    if (setext?.[1]) {
      const value = cleanHeading(setext[1])
      if (value) return value
    }

    const strong = markdown.match(/^\s*(?:\*\*|__)(.+?)(?:\*\*|__)\s*$/m)
    if (strong?.[1]) {
      const value = cleanHeading(strong[1])
      if (value) return value
    }
  }

  function cleanHeading(value: string) {
    return value
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/[*_~]+/g, "")
      .trim()
  }

  function unwrapErrorMessage(message: string) {
    const text = message.replace(/^Error:\s*/, "").trim()

    const parse = (value: string) => {
      try {
        return JSON.parse(value) as unknown
      } catch {
        return undefined
      }
    }

    const read = (value: string) => {
      const first = parse(value)
      if (typeof first !== "string") return first
      return parse(first.trim())
    }

    let json = read(text)

    if (json === undefined) {
      const start = text.indexOf("{")
      const end = text.lastIndexOf("}")
      if (start !== -1 && end > start) json = read(text.slice(start, end + 1))
    }

    if (!record(json)) return message

    const err = record(json.error) ? json.error : undefined
    if (err) {
      const type = typeof err.type === "string" ? err.type : undefined
      const msg = typeof err.message === "string" ? err.message : undefined
      if (type && msg) return `${type}: ${msg}`
      if (msg) return msg
      if (type) return type
      const code = typeof err.code === "string" ? err.code : undefined
      if (code) return code
    }

    const msg = typeof json.message === "string" ? json.message : undefined
    if (msg) return msg

    const reason = typeof json.error === "string" ? json.error : undefined
    if (reason) return reason

    return message
  }

  function record(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value)
  }

  export function turnDurationMs(userMessage: UserMessage, assistantMessages: AssistantMessage[]) {
    const end = assistantMessages.reduce<number | undefined>((max, item) => {
      const completed = item.time.completed
      if (typeof completed !== "number") return max
      if (max === undefined) return completed
      return Math.max(max, completed)
    }, undefined)
    if (typeof end !== "number") return
    if (end < userMessage.time.created) return
    return end - userMessage.time.created
  }

  // Only the opencode-native harness stamps MessageAbortedError on abort. SDK-runtime
  // harnesses (codex/claude/cursor/ACP) emit no error and skip the finish event — the turn
  // just goes idle with its last assistant message unsettled (no completed time, no
  // error), so that is the abort signal for them. Pi's adapter always settles the message
  // (completed + UnknownError) on any failure, abort included, so it never trips the
  // unsettled branch.
  export function turnInterrupted(
    assistantMessages: AssistantMessage[],
    status: SessionStatus["type"],
    isActive: boolean,
  ) {
    if (assistantMessages.some((m) => m.error?.name === "MessageAbortedError")) return true
    const last = assistantMessages[assistantMessages.length - 1]
    if (!last) return false
    const turnStillRunning = isActive && (status === "busy" || status === "retry")
    return !turnStillRunning && !assistantMessageSettled(last)
  }
}

// Tool vocabularies span harnesses: OpenCode emits `bash`/`read`/…, Codex emits
// `command`/`read_file`/… Keep both here or those runs never group (they'd render as
// loud one-per-row generic rows). Mirrors TOOL_NAME_ALIASES in session-ui message-part.
const contextGroupTools = new Set(["read", "glob", "grep", "list", "read_file"])
const workGroupTools = new Set([
  "bash",
  "command",
  "shell",
  "local_shell",
  "edit",
  "edit_file",
  "write",
  "write_file",
  "apply_patch",
  "webfetch",
  "websearch",
  "web_search",
])
const hiddenTools = new Set(["todowrite"])
const renderableParts = new Set(["compaction", "text", "reasoning", "tool"])

export function assistantMessageSettled(message: AssistantMessage) {
  return typeof message.time.completed === "number" || !!message.error
}

type GroupablePart = { messageID: string; part: Part }

function partRef(item: GroupablePart) {
  return { messageID: item.messageID, partID: item.part.id }
}

// Representative category for a work run's icon/summary (T3): edit wins if present,
// else web, else run-command.
const editToolNames = new Set(["edit", "edit_file", "write", "write_file", "apply_patch"])
const webToolNames = new Set(["webfetch", "websearch", "web_search"])

function workGroupTool(slice: GroupablePart[]): WorkGroupTool {
  if (slice.some((i) => i.part.type === "tool" && editToolNames.has(i.part.tool))) return "edit"
  if (slice.some((i) => i.part.type === "tool" && webToolNames.has(i.part.tool))) return "webfetch"
  return "bash"
}

// Single greedy pass (T3): consecutive context tools (read/glob/grep/list) fold into a
// context group; consecutive work tools (bash/edit/write/apply_patch/web) fold into a
// work group *only* when the run has ≥2 members — a lone work tool stays a standalone
// row. Any non-groupable part flushes both runs. Runs never cross since groupParts is
// called per (sub)turn already.
function groupParts(parts: GroupablePart[]) {
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
      result.push({ key: `part:${first.messageID}:${first.part.id}`, type: "part", ref: partRef(first) })
    }
    workStart = -1
  }

  // Consecutive subagent (task) calls fold into a chip row (T12); a lone task stays a card.
  const flushTask = (end: number) => {
    if (taskStart < 0) return
    const slice = parts.slice(taskStart, end + 1)
    const first = parts[taskStart]
    if (!first) {
      taskStart = -1
      return
    }
    if (slice.length >= 2) {
      result.push({ key: `agents:${first.part.id}`, type: "agents", refs: slice.map(partRef) })
    } else {
      result.push({ key: `part:${first.messageID}:${first.part.id}`, type: "part", ref: partRef(first) })
    }
    taskStart = -1
  }

  parts.forEach((item, index) => {
    const isContext = item.part.type === "tool" && contextGroupTools.has(item.part.tool)
    const isWork = item.part.type === "tool" && workGroupTools.has(item.part.tool)
    const isTask = item.part.type === "tool" && item.part.tool === "task"

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
    result.push({ key: `part:${item.messageID}:${item.part.id}`, type: "part", ref: partRef(item) })
  })

  flushContext(parts.length - 1)
  flushWork(parts.length - 1)
  flushTask(parts.length - 1)
  return result
}

function renderablePart(part: Part, showReasoning = true) {
  if (part.type === "tool") {
    if (hiddenTools.has(part.tool)) return false
    if (part.tool === "question") return part.state.status !== "pending" && part.state.status !== "running"
    return true
  }
  if (part.type === "text") return !!part.text?.trim()
  if (part.type === "reasoning") return showReasoning && !!part.text?.trim()
  return renderableParts.has(part.type)
}

export namespace MessageComment {
  export type MessageComment = {
    path: string
    comment: string
    selection?: {
      startLine: number
      endLine: number
    }
  }

  export const fromPart = (part: Part): MessageComment | undefined => {
    if (part.type !== "text" || !part.synthetic) return
    const next = readCommentMetadata(part.metadata) ?? parseCommentNote(part.text)
    if (!next) return
    return {
      path: next.path,
      comment: next.comment,
      selection: next.selection
        ? {
            startLine: next.selection.startLine,
            endLine: next.selection.endLine,
          }
        : undefined,
    }
  }
}
