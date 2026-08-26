import type { PartGroup } from "@/ui/session-kit"
import type { SessionErrorClass } from "../onboarding/first-turn-recovery"
import type { SummaryDiff } from "./message-timeline.data"

export type TimelineRowMap = {
  TurnGap: { userMessageID: string }
  CommentStrip: { userMessageID: string }
  UserMessage: { userMessageID: string; anchor: boolean }
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
    summary?: string
    recoveryClass?: SessionErrorClass
    error?: unknown
    providerID?: string
    modelID?: string
  }
}

class TaggedRow<Tag extends string> {
  constructor(readonly _tag: Tag, fields: object) {
    Object.assign(this, fields)
  }
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
  export class TurnGap extends TaggedRow<"TurnGap"> {
    declare readonly userMessageID: string
    constructor(fields: TimelineRowMap["TurnGap"]) { super("TurnGap", fields) }
  }
  export class CommentStrip extends TaggedRow<"CommentStrip"> {
    declare readonly userMessageID: string
    constructor(fields: TimelineRowMap["CommentStrip"]) { super("CommentStrip", fields) }
  }
  export class UserMessage extends TaggedRow<"UserMessage"> {
    declare readonly userMessageID: string
    declare readonly anchor: boolean
    constructor(fields: TimelineRowMap["UserMessage"]) { super("UserMessage", fields) }
  }
  export class TurnDivider extends TaggedRow<"TurnDivider"> {
    declare readonly userMessageID: string
    declare readonly label: "compaction" | "interrupted"
    declare readonly durationMs?: number
    constructor(fields: TimelineRowMap["TurnDivider"]) { super("TurnDivider", fields) }
  }
  export class AssistantPart extends TaggedRow<"AssistantPart"> {
    declare readonly userMessageID: string
    declare readonly group: PartGroup
    declare readonly previousAssistantPart: boolean
    declare readonly lastAssistantPart: boolean
    constructor(fields: TimelineRowMap["AssistantPart"]) { super("AssistantPart", fields) }
  }
  export class Thinking extends TaggedRow<"Thinking"> {
    declare readonly userMessageID: string
    declare readonly reasoningHeading?: string
    constructor(fields: TimelineRowMap["Thinking"]) { super("Thinking", fields) }
  }
  export class DiffSummary extends TaggedRow<"DiffSummary"> {
    declare readonly userMessageID: string
    declare readonly diffs: SummaryDiff[]
    constructor(fields: TimelineRowMap["DiffSummary"]) { super("DiffSummary", fields) }
  }
  export class Error extends TaggedRow<"Error"> {
    declare readonly userMessageID: string
    declare readonly text: string
    declare readonly summary?: string
    declare readonly recoveryClass?: SessionErrorClass
    declare readonly error?: unknown
    declare readonly providerID?: string
    declare readonly modelID?: string
    constructor(fields: TimelineRowMap["Error"]) { super("Error", fields) }
  }
  export class Retry extends TaggedRow<"Retry"> {
    declare readonly userMessageID: string
    constructor(fields: TimelineRowMap["Retry"]) { super("Retry", fields) }
  }
  export class TurnFold extends TaggedRow<"TurnFold"> {
    declare readonly userMessageID: string
    declare readonly durationMs?: number
    declare readonly foldCount: number
    declare readonly folded: boolean
    declare readonly running?: boolean
    declare readonly tokens?: number
    declare readonly cost?: number
    constructor(fields: TimelineRowMap["TurnFold"]) { super("TurnFold", fields) }
  }

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
      case "TurnGap": return `turn-gap:${row.userMessageID}`
      case "CommentStrip": return `comment-strip:${row.userMessageID}`
      case "UserMessage": return `user-message:${row.userMessageID}`
      case "TurnDivider": return `turn-divider:${row.userMessageID}:${row.label}`
      case "AssistantPart": return `assistant-part:${row.userMessageID}:${row.group.key}`
      case "Thinking": return `thinking:${row.userMessageID}`
      case "DiffSummary": return `diff-summary:${row.userMessageID}`
      case "Error": return `error:${row.userMessageID}`
      case "Retry": return `retry:${row.userMessageID}`
      case "TurnFold": return `turn-fold:${row.userMessageID}`
    }
  }

  export function is(value: unknown): value is TimelineRow {
    if (!value || typeof value !== "object" || !("_tag" in value)) return false
    switch (value._tag) {
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
