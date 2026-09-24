import type { AppError, ModelChoice } from "@/server"
import type { FileSelection } from "@/lib/file-selection"
import type { Transition } from "@/lib/machine"
import { unreachable } from "@/lib/machine"
import { uuid } from "@/lib/uuid"

export type { FileSelection }

export type LineRange = {
  readonly start: number
  readonly end: number
  readonly side?: "additions" | "deletions"
  readonly endSide?: "additions" | "deletions"
}

type Span = { content: string; start: number; end: number }

export type TextPart = Span & { type: "text" }
export type FilePart = Span & { type: "file"; path: string; selection?: FileSelection }
export type AgentPart = Span & { type: "agent"; name: string }

export type ImageMark = { x: number; y: number; width: number; height: number; comment: string }

export type ImagePart = {
  type: "image"
  id: string
  filename: string
  mime: string
  dataUrl: string
  marks?: ImageMark[]
}

export type PromptPart = TextPart | FilePart | AgentPart | ImagePart
export type Prompt = PromptPart[]

export type FileContextItem = {
  type: "file"
  key: string
  path: string
  selection?: FileSelection
  comment?: string
  commentId?: string
  commentOrigin?: "review" | "file"
  preview?: string
}

export type TextContextItem = {
  type: "text"
  key: string
  label: string
  text: string
}

export type ContextItem = FileContextItem | TextContextItem

export type EditorMode = "normal" | "shell"

export type Draft = {
  prompt: Prompt
  cursor?: number
  context: ContextItem[]
  goalArmed: boolean
}

export type HistoryComment = {
  id: string
  path: string
  selection: LineRange
  comment: string
  time: number
  origin?: "review" | "file"
  preview?: string
}

export type HistoryEntry = { prompt: Prompt; comments: HistoryComment[] }
export type History = Record<EditorMode, HistoryEntry[]>

export type Selection = {
  harness?: string
  model?: ModelChoice
  effort?: string
  permissionMode?: string
}

export const emptyPrompt = (): Prompt => [{ type: "text", content: "", start: 0, end: 0 }]

export const emptyDraft = (): Draft => ({ prompt: emptyPrompt(), cursor: undefined, context: [], goalArmed: false })

export const randomId = () => uuid()

function clonePart(part: PromptPart): PromptPart {
  if (part.type === "text" || part.type === "agent") return { ...part }
  if (part.type === "image") return part.marks ? { ...part, marks: part.marks.map((mark) => ({ ...mark })) } : { ...part }
  return { ...part, selection: part.selection ? { ...part.selection } : undefined }
}

export function clonePrompt(prompt: readonly PromptPart[]): Prompt {
  return prompt.map(clonePart)
}

export function promptText(prompt: readonly PromptPart[]) {
  return prompt.map((part) => ("content" in part ? part.content : "")).join("")
}

export function promptImages(prompt: readonly PromptPart[]): ImagePart[] {
  return prompt.filter((part): part is ImagePart => part.type === "image")
}

export function promptFilled(draft: Pick<Draft, "prompt" | "context">) {
  if (promptImages(draft.prompt).length > 0) return true
  if (draft.context.some((item) => item.type === "text" || !!item.comment?.trim())) return true
  return promptText(draft.prompt).trim().length > 0
}

export type SendState =
  | { kind: "editing" }
  | { kind: "sending"; clientRequestId: string }
  | { kind: "accepted"; clientRequestId: string }
  | { kind: "rejected"; error: AppError }

export type SendEvent =
  | { type: "sendStarted"; clientRequestId: string }
  | { type: "sendAccepted"; clientRequestId: string }
  | { type: "sendRejected"; error: AppError }
  | { type: "edited" }

export const sendTransition: Transition<SendState, SendEvent> = (state, event) => {
  switch (event.type) {
    case "sendStarted":
      return state.kind === "sending" ? state : { kind: "sending", clientRequestId: event.clientRequestId }
    case "sendAccepted":
      return state.kind === "sending" && state.clientRequestId === event.clientRequestId
        ? { kind: "accepted", clientRequestId: event.clientRequestId }
        : state
    case "sendRejected":
      return state.kind === "sending" ? { kind: "rejected", error: event.error } : state
    case "edited":
      return state.kind === "sending" ? state : { kind: "editing" }
    default:
      return unreachable(event)
  }
}

export type AttachmentState =
  | { kind: "reading"; id: string; filename: string }
  | { kind: "ready"; id: string; part: ImagePart }
  | { kind: "failed"; id: string; filename: string; error: AppError; refusal?: AttachmentRefusal }

export type AttachmentRefusal = { harness: string; mime: string }

export type AttachmentEvent =
  | { type: "read"; part: ImagePart }
  | { type: "failed"; error: AppError; refusal?: AttachmentRefusal }

export const attachmentTransition: Transition<AttachmentState, AttachmentEvent> = (state, event) => {
  if (state.kind !== "reading") return state
  switch (event.type) {
    case "read":
      return { kind: "ready", id: state.id, part: event.part }
    case "failed":
      return { kind: "failed", id: state.id, filename: state.filename, error: event.error, refusal: event.refusal }
    default:
      return unreachable(event)
  }
}
