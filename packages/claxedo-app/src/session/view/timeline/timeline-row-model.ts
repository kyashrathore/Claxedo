import type { PartGroup } from "@claxedo/agent-runtime-contract/turn-fold"
import type { DispatchContext } from "./provider-error-detail"
import type { SessionErrorClass } from "./turn-recovery"
import type { SummaryDiff } from "./message-timeline.data"

export type TimelineRowMap = {
  PreviousMessages: { userMessageId: string; count: number }
  TurnGap: { userMessageId: string }
  CommentStrip: {
    userMessageId: string
  }
  UserMessage: {
    userMessageId: string
    anchor: boolean
  }
  TurnDivider: {
    userMessageId: string
    label: "compaction" | "handoff" | "interrupted"
    harness?: string
    durationMs?: number
  }
  AssistantPart: {
    userMessageId: string
    group: PartGroup
    previousAssistantPart: boolean
    lastAssistantPart: boolean
  }
  Thinking: { userMessageId: string; reasoningHeading?: string }
  Retry: { userMessageId: string }
  TurnLoading: { userMessageId: string }
  TurnFold: {
    userMessageId: string
    durationMs?: number
    foldCount: number
    folded: boolean
    tokens?: number
    cost?: number
  }
  DiffSummary: { userMessageId: string; diffs: SummaryDiff[] }
  Error: {
    userMessageId: string
    text: string
    presentation?: "turn-conflict"
    summary?: string
    recoveryClass?: SessionErrorClass
    error?: unknown
  } & DispatchContext
}

type TaggedRow<Tag extends string, Fields extends object> = Readonly<Fields> & { readonly _tag: Tag }

function taggedRow<Tag extends string, Fields extends object>(tag: Tag) {
  return (fields: Fields): TaggedRow<Tag, Fields> => ({ ...fields, _tag: tag })
}

function samePartRef(a: { messageId: string; partId: string }, b: { messageId: string; partId: string }) {
  return a.messageId === b.messageId && a.partId === b.partId
}

function samePartRefs(
  a: ReadonlyArray<{ messageId: string; partId: string }>,
  b: ReadonlyArray<{ messageId: string; partId: string }>,
) {
  return a.length === b.length && a.every((ref, index) => samePartRef(ref, b[index]))
}

function samePartGroup(a: PartGroup, b: PartGroup) {
  if (a === b) return true
  if (a.key !== b.key || a.type !== b.type) return false
  if (a.type === "part") return b.type === "part" && samePartRef(a.ref, b.ref)
  if (b.type === "part") return false
  if (a.type === "work" && (b.type !== "work" || a.tool !== b.tool)) return false
  return "refs" in b && samePartRefs(a.refs, b.refs)
}

function sameSummaryDiff(a: SummaryDiff, b: SummaryDiff) {
  return a.file === b.file && a.patch === b.patch && a.additions === b.additions &&
    a.deletions === b.deletions && a.status === b.status
}

function sameSummaryDiffs(a: SummaryDiff[], b: SummaryDiff[]) {
  if (a === b) return true
  if (a.length !== b.length) return false
  return a.every((diff, index) => {
    const other = b[index]
    return !!other && sameSummaryDiff(diff, other)
  })
}

export namespace TimelineRow {
  export const PreviousMessages = taggedRow<"PreviousMessages", TimelineRowMap["PreviousMessages"]>("PreviousMessages")
  export type PreviousMessages = ReturnType<typeof PreviousMessages>
  export const TurnGap = taggedRow<"TurnGap", TimelineRowMap["TurnGap"]>("TurnGap")
  export type TurnGap = ReturnType<typeof TurnGap>
  export const CommentStrip = taggedRow<"CommentStrip", TimelineRowMap["CommentStrip"]>("CommentStrip")
  export type CommentStrip = ReturnType<typeof CommentStrip>
  export const UserMessage = taggedRow<"UserMessage", TimelineRowMap["UserMessage"]>("UserMessage")
  export type UserMessage = ReturnType<typeof UserMessage>
  export const TurnDivider = taggedRow<"TurnDivider", TimelineRowMap["TurnDivider"]>("TurnDivider")
  export type TurnDivider = ReturnType<typeof TurnDivider>
  export const AssistantPart = taggedRow<"AssistantPart", TimelineRowMap["AssistantPart"]>("AssistantPart")
  export type AssistantPart = ReturnType<typeof AssistantPart>
  export const Thinking = taggedRow<"Thinking", TimelineRowMap["Thinking"]>("Thinking")
  export type Thinking = ReturnType<typeof Thinking>
  export const DiffSummary = taggedRow<"DiffSummary", TimelineRowMap["DiffSummary"]>("DiffSummary")
  export type DiffSummary = ReturnType<typeof DiffSummary>
  export const Error = taggedRow<"Error", TimelineRowMap["Error"]>("Error")
  export type Error = ReturnType<typeof Error>
  export const Retry = taggedRow<"Retry", TimelineRowMap["Retry"]>("Retry")
  export type Retry = ReturnType<typeof Retry>
  export const TurnLoading = taggedRow<"TurnLoading", TimelineRowMap["TurnLoading"]>("TurnLoading")
  export type TurnLoading = ReturnType<typeof TurnLoading>
  export const TurnFold = taggedRow<"TurnFold", TimelineRowMap["TurnFold"]>("TurnFold")
  export type TurnFold = ReturnType<typeof TurnFold>

  export type TimelineRow =
    | PreviousMessages
    | TurnGap
    | CommentStrip
    | UserMessage
    | TurnDivider
    | AssistantPart
    | Thinking
    | DiffSummary
    | Error
    | Retry
    | TurnLoading
    | TurnFold

  export const keyIsThinking = (key: string) => key.startsWith("thinking:")

  export const key = (row: TimelineRow) => {
    switch (row._tag) {
      case "PreviousMessages":
        return `previous-messages:${row.userMessageId}`
      case "TurnGap":
        return `turn-gap:${row.userMessageId}`
      case "CommentStrip":
        return `comment-strip:${row.userMessageId}`
      case "UserMessage":
        return `user-message:${row.userMessageId}`
      case "TurnDivider":
        return `turn-divider:${row.userMessageId}:${row.label}`
      case "AssistantPart":
        return `assistant-part:${row.userMessageId}:${row.group.key}`
      case "Thinking":
        return `thinking:${row.userMessageId}`
      case "DiffSummary":
        return `diff-summary:${row.userMessageId}`
      case "Error":
        return `error:${row.userMessageId}`
      case "Retry":
        return `retry:${row.userMessageId}`
      case "TurnLoading":
        return `turn-loading:${row.userMessageId}`
      case "TurnFold":
        return `turn-fold:${row.userMessageId}`
      default: {
        const exhaustive: never = row
        return exhaustive
      }
    }
  }

  export function is(value: unknown): value is TimelineRow {
    if (!value || typeof value !== "object" || !("_tag" in value)) return false
    switch ((value as { _tag?: unknown })._tag) {
      case "PreviousMessages":
      case "TurnGap":
      case "CommentStrip":
      case "UserMessage":
      case "TurnDivider":
      case "AssistantPart":
      case "Thinking":
      case "DiffSummary":
      case "Error":
      case "Retry":
      case "TurnLoading":
      case "TurnFold":
        return true
    }
    return false
  }

  export function equals(a: TimelineRow, b: TimelineRow) {
    if (a === b) return true
    if (a._tag !== b._tag || a.userMessageId !== b.userMessageId) return false
    switch (a._tag) {
      case "PreviousMessages":
        return b._tag === "PreviousMessages" && a.count === b.count
      case "TurnGap":
      case "CommentStrip":
      case "Retry":
      case "TurnLoading":
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
          a.modelID === b.modelID && a.presentation === b.presentation
      case "TurnFold":
        return b._tag === "TurnFold" && a.durationMs === b.durationMs && a.foldCount === b.foldCount &&
          a.folded === b.folded && a.tokens === b.tokens && a.cost === b.cost
      default: {
        const exhaustive: never = a
        return exhaustive
      }
    }
  }

  export function anchorsReadingPosition(row: TimelineRow) {
    return row._tag !== "PreviousMessages"
  }

  export function anchorsMessage(row: TimelineRow) {
    return row._tag === "CommentStrip" || (row._tag === "UserMessage" && row.anchor)
  }

  export function contentMessageId(row: TimelineRow) {
    switch (row._tag) {
      case "UserMessage":
        return row.userMessageId
      case "AssistantPart":
        return "ref" in row.group ? row.group.ref.messageId : row.group.refs[0]?.messageId
      default:
        return undefined
    }
  }

  export function contentPartId(row: TimelineRow) {
    if (row._tag !== "AssistantPart") return undefined
    return "ref" in row.group ? row.group.ref.partId : row.group.refs[0]?.partId
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
