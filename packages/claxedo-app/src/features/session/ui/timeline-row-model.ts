// The message timeline's row model: the tagged TimelineRow union, its
// constructors, keys, structural equality, and identity-preserving reuse.
// Pure data — no rendering, no row construction policy (that lives in
// message-timeline.data.ts's Timeline.constructMessageRows, alongside the
// SummaryDiff type referenced here; that import is type-only, so no runtime
// cycle exists).
import type { PartGroup } from "@/ui/session-kit"
import type { SessionErrorClass } from "../onboarding/first-turn-recovery"
import type { SummaryDiff } from "./message-timeline.data"

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
    label: "compaction" | "handoff" | "interrupted"
    harness?: string
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
    // as-any: Object.assign applies the field set, so TS cannot verify the shape.
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

  /**
   * The row's OWN message id, distinct from the turn key: a UserMessage row
   * is its user message; an AssistantPart row belongs to the assistant
   * message its parts came from (`data-message-id` carries the TURN key).
   * External observers verifying "this exact message painted" read the
   * `data-content-message-id` attribute stamped from this.
   */
  /** Rows that anchor a user-message position (scroll targets, row index). */
  export function anchorsMessage(row: TimelineRow) {
    return row._tag === "CommentStrip" || (row._tag === "UserMessage" && row.anchor)
  }

  export function contentMessageID(row: TimelineRow) {
    switch (row._tag) {
      case "UserMessage":
        return row.userMessageID
      case "AssistantPart":
        return "ref" in row.group ? row.group.ref.messageID : row.group.refs[0]?.messageID
      default:
        return undefined
    }
  }

  /**
   * Part-level identity beside the message-level one: assistant messages
   * render one row PER PART GROUP (all sharing the message id), so content
   * verification needs to know WHICH part a row shows.
   */
  export function contentPartID(row: TimelineRow) {
    if (row._tag !== "AssistantPart") return undefined
    return "ref" in row.group ? row.group.ref.partID : row.group.refs[0]?.partID
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
