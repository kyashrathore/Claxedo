import type { AppError, ModelChoice, QueuedPrompt } from "@/server"
import type { FileSelection } from "@/lib/file-selection"
import type { Transition } from "@/lib/machine"
import { unreachable } from "@/lib/machine"
import { uuid } from "@/lib/uuid"
import { parsePromptNote, type QuoteSource } from "@/lib/comment-note"

export type { FileSelection, QuoteSource }

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

export type QuoteContextItem = {
  type: "quote"
  key: string
  source: QuoteSource
  quote: string
  comment: string
}

export type ImageNoteContextItem = {
  type: "image-note"
  key: string
  filename: string
  number: number
  comment: string
}

export type ContextItem = FileContextItem | TextContextItem | QuoteContextItem | ImageNoteContextItem

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

export type Submission = {
  readonly harness?: string
  readonly model?: ModelChoice
  readonly effort?: string
  readonly serviceTier?: string
  readonly permissionMode?: string
}

export const emptyPrompt = (): Prompt => [{ type: "text", content: "", start: 0, end: 0 }]

export const emptyDraft = (): Draft => ({ prompt: emptyPrompt(), cursor: undefined, context: [], goalArmed: false })

function noteItem(text: string, key: string): ContextItem {
  const note = parsePromptNote(text)
  if (note?.kind === "quote") return { type: "quote", key, source: note.source, quote: note.quote, comment: note.comment }
  if (note?.kind === "image-mark") return { type: "image-note", key, filename: note.filename, number: note.number, comment: note.comment }
  if (note?.kind === "file") return { type: "file", key, path: note.path, comment: note.comment, ...(note.selection ? { selection: note.selection } : {}) }
  return { type: "text", key, label: "", text }
}

export function queuedDraft(record: Pick<QueuedPrompt, "seq" | "parts">): Draft | undefined {
  const context: ContextItem[] = []
  const text: PromptPart[] = []
  const images: PromptPart[] = []
  let offset = 0
  for (const [index, part] of record.parts.entries()) {
    if (part.type === "text" && part.text !== undefined && part.synthetic) context.push(noteItem(part.text, `queued-${record.seq}-note-${index}`))
    else if (part.type === "text" && part.text !== undefined) {
      const content = `${offset ? "\n\n" : ""}${part.text}`
      text.push({ type: "text", content, start: offset, end: offset + content.length })
      offset += content.length
    } else if (part.type === "file" && part.url && part.mime && part.filename) {
      images.push({ type: "image", id: `queued-${record.seq}-file-${index}`, filename: part.filename, mime: part.mime, dataUrl: part.url })
    } else return undefined
  }
  return { prompt: [...(text.length ? text : emptyPrompt()), ...images], context, goalArmed: false }
}

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

export function promptWithoutText(prompt: readonly PromptPart[]): Prompt {
  return [...emptyPrompt(), ...promptImages(prompt)]
}

export function promptFilled(draft: Pick<Draft, "prompt" | "context">) {
  if (promptImages(draft.prompt).length > 0) return true
  if (draft.context.some((item) => item.type !== "file" || !!item.comment?.trim())) return true
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

export type StopState = { kind: "idle" } | { kind: "stopping" } | { kind: "failed"; error: AppError }

export type StopEvent = { type: "stopStarted" } | { type: "stopFinished" } | { type: "stopFailed"; error: AppError }

export const stopTransition: Transition<StopState, StopEvent> = (state, event) => {
  switch (event.type) {
    case "stopStarted":
      return { kind: "stopping" }
    case "stopFinished":
      return { kind: "idle" }
    case "stopFailed":
      return { kind: "failed", error: event.error }
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

export function quoteContextItem(input: Pick<QuoteContextItem, "source" | "quote" | "comment">): QuoteContextItem {
  return { type: "quote", key: `quote:${randomId()}`, source: input.source, quote: input.quote, comment: input.comment }
}
