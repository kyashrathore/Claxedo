import { parseCommentNote, readCommentMetadata } from "@/features/session/data/comment-note"
import { AssistantMessage, Part, SessionStatus, SnapshotFileDiff, UserMessage } from "@opencode-ai/sdk/v2"
import type { PartGroup, WorkGroupTool } from "@/ui/session-kit"
import { sessionRecoveryClass, sessionRecoveryDescription, type SessionErrorClass } from "../onboarding/first-turn-recovery"
import { stripRelayPrefix } from "../onboarding/provider-error-detail"
import type { SessionTurnOutcome } from "../data/session-types"

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
    durationMs?: number
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
  Error: {
    userMessageID: string
    text: string
    /**
     * The human sentence for the row's PRIMARY line, composed here alongside
     * the raw text so the first paint is already readable. `text` is the raw
     * provider bytes and belongs only in the collapsed disclosure.
     */
    summary?: string
    recoveryClass?: SessionErrorClass
    error?: unknown
    providerID?: string
    modelID?: string
  }
}

type TaggedRow<Tag extends string, Fields extends object> = Readonly<Fields> & { readonly _tag: Tag }

function taggedRow<Tag extends string, Fields extends object>(tag: Tag) {
  return class {
    readonly _tag = tag

    constructor(fields: Fields) {
      Object.assign(this, fields)
    }
  } as unknown as new (fields: Fields) => TaggedRow<Tag, Fields>
}

function samePartRef(a: { messageID: string; partID: string }, b: { messageID: string; partID: string }) {
  return a.messageID === b.messageID && a.partID === b.partID
}

function samePartRefs(
  a: ReadonlyArray<{ messageID: string; partID: string }>,
  b: ReadonlyArray<{ messageID: string; partID: string }>,
) {
  return a.length === b.length && a.every((ref, index) => samePartRef(ref, b[index]!))
}

function samePartGroup(a: PartGroup, b: PartGroup) {
  if (a === b) return true
  if (a.key !== b.key || a.type !== b.type) return false
  if (a.type === "part") return b.type === "part" && samePartRef(a.ref, b.ref)
  if (b.type === "part") return false
  if (a.type === "work" && (b.type !== "work" || a.tool !== b.tool)) return false
  return "refs" in b && samePartRefs(a.refs, b.refs)
}

function sameSummaryDiffs(a: SummaryDiff[], b: SummaryDiff[]) {
  if (a === b) return true
  if (a.length !== b.length) return false
  return a.every((diff, index) => {
    const other = b[index]
    if (!other) return false
    const keys = Object.keys(diff) as Array<keyof SummaryDiff>
    const otherKeys = Object.keys(other)
    return keys.length === otherKeys.length && keys.every((key) => Object.is(diff[key], other[key]))
  })
}

export namespace TimelineRow {
  export const TurnGap = taggedRow<"TurnGap", TimelineRowMap["TurnGap"]>("TurnGap")
  export type TurnGap = InstanceType<typeof TurnGap>
  export const CommentStrip = taggedRow<"CommentStrip", TimelineRowMap["CommentStrip"]>("CommentStrip")
  export type CommentStrip = InstanceType<typeof CommentStrip>
  export const UserMessage = taggedRow<"UserMessage", TimelineRowMap["UserMessage"]>("UserMessage")
  export type UserMessage = InstanceType<typeof UserMessage>
  export const TurnDivider = taggedRow<"TurnDivider", TimelineRowMap["TurnDivider"]>("TurnDivider")
  export type TurnDivider = InstanceType<typeof TurnDivider>
  export const AssistantPart = taggedRow<"AssistantPart", TimelineRowMap["AssistantPart"]>("AssistantPart")
  export type AssistantPart = InstanceType<typeof AssistantPart>
  export const Thinking = taggedRow<"Thinking", TimelineRowMap["Thinking"]>("Thinking")
  export type Thinking = InstanceType<typeof Thinking>
  export const DiffSummary = taggedRow<"DiffSummary", TimelineRowMap["DiffSummary"]>("DiffSummary")
  export type DiffSummary = InstanceType<typeof DiffSummary>
  export const Error = taggedRow<"Error", TimelineRowMap["Error"]>("Error")
  export type Error = InstanceType<typeof Error>
  export const Retry = taggedRow<"Retry", TimelineRowMap["Retry"]>("Retry")
  export type Retry = InstanceType<typeof Retry>
  export const TurnFold = taggedRow<"TurnFold", TimelineRowMap["TurnFold"]>("TurnFold")
  export type TurnFold = InstanceType<typeof TurnFold>

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
    if (a === b) return true
    if (a._tag !== b._tag || a.userMessageID !== b.userMessageID) return false
    switch (a._tag) {
      case "TurnGap":
      case "CommentStrip":
      case "Retry":
        return true
      case "UserMessage":
        return b._tag === "UserMessage" && a.anchor === b.anchor
      case "TurnDivider":
        return b._tag === "TurnDivider" && a.label === b.label && a.durationMs === b.durationMs
      case "AssistantPart":
        return b._tag === "AssistantPart" && a.previousAssistantPart === b.previousAssistantPart &&
          a.lastAssistantPart === b.lastAssistantPart && samePartGroup(a.group, b.group)
      case "Thinking":
        return b._tag === "Thinking" && a.reasoningHeading === b.reasoningHeading
      case "DiffSummary":
        return b._tag === "DiffSummary" && sameSummaryDiffs(a.diffs, b.diffs)
      case "Error":
        return b._tag === "Error" && a.text === b.text && a.summary === b.summary &&
          a.recoveryClass === b.recoveryClass && a.error === b.error && a.providerID === b.providerID &&
          a.modelID === b.modelID
      case "TurnFold":
        return b._tag === "TurnFold" && a.durationMs === b.durationMs && a.foldCount === b.foldCount &&
          a.folded === b.folded && a.running === b.running && a.tokens === b.tokens && a.cost === b.cost
    }
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
    lastTurn?: SessionTurnOutcome,
  ) {
    const rows: TimelineRow.TimelineRow[] = []

    const previousUserMessage = index > 0
    const userParts = getMessageParts(userMessage.id)
    const comments = userParts.flatMap((p) => MessageComment.fromPart(p) ?? [])
    const compaction = userParts.some((p) => p.type === "compaction")
    const lastAssistantMessage = assistantMessages[assistantMessages.length - 1]
    // OpenCode-native aborts are durable on the message itself. SDK-runtime aborts are
    // durable on the Session turn outcome, which must match the exact assistant message.
    // Missing completion metadata is not an abort signal: normal turns can be observed
    // between the idle event and their message completion checkpoint.
    const nativeInterruptedIndex = assistantMessages.findIndex(assistantMessageInterrupted)
    const sdkInterruptedIndex =
      nativeInterruptedIndex === -1 && lastTurn?.status === "cancelled" && lastTurn.assistantMessageId
        ? assistantMessages.findIndex((message) => message.id === lastTurn.assistantMessageId)
        : -1
    const interruptedMessageIndex =
      nativeInterruptedIndex !== -1 ? nativeInterruptedIndex : sdkInterruptedIndex
    const interrupted = interruptedMessageIndex !== -1
    // Keep the message, not just its error: its providerID/modelID are what the
    // turn actually dispatched with, and the error card names that provider.
    const errorMessage = assistantMessages.find((m) => m.error && m.error.name !== "MessageAbortedError")
    const error = errorMessage?.error
    const settled = assistantMessages.some(assistantMessageSettled)
    const assistantPartRefs = assistantMessages.flatMap((message, messageIndex) =>
      getMessageParts(message.id)
        .filter((part) =>
          renderablePart(part, showReasoning) &&
          !(interrupted && part.type === "tool" && (part.state.status === "pending" || part.state.status === "running"))
        )
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
    // SDK cancellation carries the canonical completion timestamp. Native aborts may not,
    // so fall back to the latest activity recorded on the interrupted message's parts.
    const interruptedActivityTime =
      sdkInterruptedIndex !== -1
        ? lastTurn?.completedAt
        : interrupted && lastAssistantMessage
          ? lastKnownPartActivity(getMessageParts(lastAssistantMessage.id))
          : undefined
    const endTimes =
      interruptedActivityTime !== undefined ? [...completedTimes, interruptedActivityTime] : completedTimes
    const createdTime = userMessage.time?.created
    const durationMs =
      endTimes.length && typeof createdTime === "number"
        ? Math.max(0, Math.max(...endTimes) - createdTime)
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
            ...(typeof durationMs === "number" ? { durationMs } : {}),
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

    if (error && !interrupted) {
      const data = error.data?.message
      const raw = typeof data === "string" ? data : data === undefined || data === null ? "" : String(data)
      // Upstream relays prefix the provider's message with their own
      // "Error from provider (<their account label>): ". That label describes
      // the relay's upstream account, not the provider we dispatched to, so it
      // reads as a mislabelled provider. Drop it here; the card's summary names
      // the real provider instead.
      const message = unwrapErrorMessage(stripRelayPrefix(raw).message)
      // The provider's response body carries the machine-readable code the
      // message often omits (auth error vs capacity vs rate limit). It rides in
      // the collapsed detail, never in the summary sentence.
      // `responseBody` is present on only some members of the wire error union,
      // so read it structurally rather than narrowing by name.
      const rawBody = (error.data as { responseBody?: unknown } | undefined)?.responseBody
      const body = typeof rawBody === "string" ? rawBody.trim() : ""
      const recoveryClass = sessionRecoveryClass(error)
      rows.push(
        new TimelineRow.Error({
          userMessageID: userMessage.id,
          text: body && body !== message ? `${message}\n${body}` : message,
          // Attach the recovery class on every turn, not just index 0. The class is
          // position-independent (regex/wire-stamped), the renderer mounts the card
          // purely on its presence, and retry is registered on every submit. The
          // firstTurnRecovery param survives for telemetry gating.
          recoveryClass: recoveryClass,
          // Composed here, not at mount: the row already carries the human
          // sentence, so the primary line never paints raw provider bytes
          // first and get replaced a beat later.
          summary: sessionRecoveryDescription(recoveryClass, error, {
            providerID: errorMessage?.providerID,
            modelID: errorMessage?.modelID,
          }),
          error,
          providerID: errorMessage?.providerID,
          modelID: errorMessage?.modelID,
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

  export function turnInterrupted(
    assistantMessages: AssistantMessage[],
    lastTurn?: SessionTurnOutcome,
  ) {
    if (assistantMessages.some(assistantMessageInterrupted)) return true
    if (lastTurn?.status !== "cancelled" || !lastTurn.assistantMessageId) return false
    return assistantMessages.some((message) => message.id === lastTurn.assistantMessageId)
  }

  function assistantMessageInterrupted(message: AssistantMessage) {
    if (message.error?.name === "MessageAbortedError") return true
    if (message.error?.name !== "UnknownError") return false
    return (message.error.data as { message?: unknown } | undefined)?.message === "Codex turn aborted"
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
// Mirrors PART_MAPPING's registered part types (message-part.tsx): non-text/reasoning/
// tool parts render only when a dedicated component exists. "file" carries assistant
// image/audio/resource-link attachments to FilePartDisplay.
const renderableParts = new Set(["compaction", "text", "reasoning", "tool", "file"])

export function assistantMessageSettled(message: AssistantMessage) {
  return typeof message.time.completed === "number" || !!message.error
}

// Best-effort stop timestamp for native aborts whose message has no completed time.
function lastKnownPartActivity(parts: Part[]): number | undefined {
  const times = parts.flatMap((part): number[] => {
    if (part.type === "text" || part.type === "reasoning") {
      return [part.time?.end, part.time?.start].filter((value): value is number => typeof value === "number")
    }
    if (part.type === "tool") {
      const state = part.state
      if (state.status === "completed" || state.status === "error") return [state.time.end]
      if (state.status === "running") return [state.time.start]
    }
    return []
  })
  return times.length ? Math.max(...times) : undefined
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
