import { createMemo, createSignal, type Accessor } from "solid-js"
import { ServerError, toAppError, type PromptAttachment, type PromptInput } from "@/server"
import type { SessionView } from "@/session"
import { formatCommentNote, formatImageMarkNote, formatQuoteNote } from "@/lib/comment-note"
import { machine } from "@/lib/machine"
import type { Draft, EditorMode, HistoryComment, QuoteSource, SendEvent, SendState, StopEvent, StopState, Submission } from "./model"
import { promptFilled, promptImages, promptText, promptWithoutText, randomId, sendTransition, stopTransition } from "./model"
import { flattenMarkedImages } from "./marks/flatten"
import { numberImageMarks } from "./marks/marks"
import type { ComposerKey, ComposerStore } from "./store"

export type GoalIntent = { kind: "none" } | { kind: "arm" } | { kind: "submit"; objective: string }

export function goalIntent(text: string, armed: boolean, goalCapable: boolean): GoalIntent {
  const trimmed = text.trim()
  const slash = /^\/goal(?:\s+([\s\S]*))?$/.exec(trimmed)
  if (slash) {
    if (!goalCapable) return { kind: "none" }
    const objective = slash[1]?.trim() ?? ""
    return objective ? { kind: "submit", objective } : { kind: "arm" }
  }
  if (armed && trimmed) return { kind: "submit", objective: trimmed }
  return { kind: "none" }
}

function commentLabel(path: string, selection?: { startLine: number; endLine: number }) {
  if (!selection) return path
  return selection.startLine === selection.endLine
    ? `${path}:${selection.startLine}`
    : `${path}:${selection.startLine}-${selection.endLine}`
}

function quoteLabel(source: QuoteSource) {
  if (source.kind === "file") return source.path
  return source.kind === "plan" ? "Plan" : "Conversation"
}

export function historyComments(draft: Draft): HistoryComment[] {
  return draft.context.flatMap((item) => {
    if (item.type !== "file" || !item.comment?.trim()) return []
    const start = item.selection?.startLine ?? 0
    const end = item.selection?.endLine ?? start
    return [
      {
        id: item.commentId ?? item.key,
        path: item.path,
        selection: { start, end },
        comment: item.comment,
        time: Date.now(),
        origin: item.commentOrigin,
        preview: item.preview,
      },
    ]
  })
}

function noteAttachments(draft: Draft): PromptAttachment[] {
  const comments = draft.context.flatMap((item): PromptAttachment[] => {
    if (item.type === "text") return [{ kind: "text", text: item.text, label: item.label }]
    if (item.type === "quote") return [{ kind: "text", text: formatQuoteNote(item), label: quoteLabel(item.source) }]
    const comment = item.comment?.trim()
    if (!comment) return []
    const text = formatCommentNote({ path: item.path, selection: item.selection, comment })
    return [{ kind: "text", text, label: commentLabel(item.path, item.selection) }]
  })
  const marks = numberImageMarks(promptImages(draft.prompt)).flatMap((entry): PromptAttachment[] => {
    const comment = entry.mark.comment.trim()
    if (!comment) return []
    const note = { filename: entry.filename, number: entry.number, comment }
    return [{ kind: "text", text: formatImageMarkNote(note), label: `${entry.filename} #${entry.number}` }]
  })
  return [...comments, ...marks]
}

export async function buildPromptInput(input: {
  draft: Draft
  submission: Submission
  goal: GoalIntent
  delivery: PromptInput["delivery"]
}): Promise<PromptInput> {
  const images = await flattenMarkedImages(promptImages(input.draft.prompt))
  const text = promptText(input.draft.prompt).trim()
  const files = input.draft.prompt.flatMap((part): PromptAttachment[] => (part.type === "file" ? [{ kind: "file", path: part.path }] : []))
  return {
    clientRequestId: randomId(),
    text,
    attachments: [
      ...images.map((image): PromptAttachment => ({ kind: "image", dataUrl: image.dataUrl, name: image.filename, mime: image.mime })),
      ...files,
      ...noteAttachments(input.draft),
    ],
    model: input.submission.model,
    effort: input.submission.effort,
    serviceTier: input.submission.serviceTier,
    permissionMode: input.submission.permissionMode,
    goal: input.goal.kind === "submit" ? { objective: input.goal.objective } : undefined,
    delivery: input.delivery,
  }
}

type SendInput = {
  key: Accessor<ComposerKey>
  store: ComposerStore
  mode: Accessor<EditorMode>
  normalMode: () => void
  submission: () => Promise<Submission>
  working: Accessor<boolean>
  goalCapable: Accessor<boolean>
  view: Accessor<SessionView | undefined>
  startSession?: (submission: Submission, prompt: PromptInput) => Promise<SessionView>
  afterAccepted?: (view: SessionView) => void
  queuedReplace: () => ((input: PromptInput) => Promise<boolean>) | undefined
  focusEditor: () => void
  goalStopFailed: (error: unknown) => void
}

async function stopSessionTurn(view: SessionView, goalStopFailed: (error: unknown) => void) {
  if (view.goal()?.status !== "active") return view.stop()
  try {
    await view.controlGoal("stop")
  } catch (error) {
    goalStopFailed(error)
    await view.stop()
  }
}

function createStop(view: Accessor<SessionView | undefined>, goalStopFailed: (error: unknown) => void) {
  const state = machine<StopState, StopEvent>({ kind: "idle" }, stopTransition)
  const stop = async () => {
    const current = view()
    if (!current || state.state().kind === "stopping") return
    state.send({ type: "stopStarted" })
    try {
      await stopSessionTurn(current, goalStopFailed)
      state.send({ type: "stopFinished" })
    } catch (error) {
      state.send({ type: "stopFailed", error: toAppError(error) })
    }
  }
  return { state: state.state, stop, dismiss: () => state.send({ type: "stopFinished" }) }
}

function createArmGoal(input: SendInput) {
  return () => {
    input.store.setGoalArmed(input.key(), true)
    requestAnimationFrame(input.focusEditor)
  }
}

async function startDraftSession(input: SendInput, submission: Submission, prompt: PromptInput, setBooting: (booting: boolean) => void): Promise<SessionView> {
  const key = input.key()
  const draft = input.store.take(key)
  setBooting(true)
  const view = await required(input.startSession)(submission, prompt).catch((error: unknown) => {
    input.store.restore(key, draft)
    throw error
  })
  input.store.addHistory(key, input.mode(), draft.prompt, historyComments(draft))
  input.normalMode()
  return view
}

async function deliverDraft(input: SendInput, draft: Draft, goal: GoalIntent, clientRequestId: string, setBooting: (booting: boolean) => void): Promise<SessionView> {
  const key = input.key()
  const replace = input.queuedReplace()
  const delivery = input.working() ? "queue" : undefined
  const submission = await input.submission()
  const prompt = await buildPromptInput({ draft, submission, goal, delivery })
  const existing = input.view()
  if (!existing) return startDraftSession(input, submission, { ...prompt, clientRequestId }, setBooting)
  if (replace) {
    if (!await replace(prompt)) throw new ServerError({ class: "conflict", code: "queue_edit_conflict", message: "The queued message changed; your edit has not been sent" })
    input.store.reset(key)
    input.normalMode()
    return existing
  }
  await existing.send({ ...prompt, clientRequestId })
  input.store.addHistory(key, input.mode(), draft.prompt, historyComments(draft))
  input.store.reset(key)
  input.normalMode()
  return existing
}

export function createComposerSend(input: SendInput) {
  const state = machine<SendState, SendEvent>({ kind: "editing" }, sendTransition)
  const sending = createMemo(() => state.state().kind === "sending")
  const [booting, setBooting] = createSignal(false)
  const armGoal = createArmGoal(input)
  const stop = createStop(input.view, input.goalStopFailed)
  const send = async () => {
    const draft = input.store.draft(input.key())
    if (sending() || !promptFilled(draft)) return
    const goal = input.queuedReplace() ? { kind: "none" as const } : goalIntent(promptText(draft.prompt), draft.goalArmed, input.goalCapable())
    if (goal.kind === "arm") {
      input.store.setPrompt(input.key(), promptWithoutText(draft.prompt), 0)
      return armGoal()
    }
    const clientRequestId = randomId()
    state.send({ type: "sendStarted", clientRequestId })
    try {
      const view = await deliverDraft(input, draft, goal, clientRequestId, setBooting)
      state.send({ type: "sendAccepted", clientRequestId })
      input.afterAccepted?.(view)
    } catch (error) {
      state.send({ type: "sendRejected", error: toAppError(error) })
    } finally {
      setBooting(false)
    }
  }
  return {
    state: state.state,
    sending,
    booting,
    send,
    armGoal,
    disarmGoal: () => input.store.setGoalArmed(input.key(), false),
    edited: () => state.send({ type: "edited" }),
    stop: stop.stop,
    stopState: stop.state,
    dismissStop: stop.dismiss,
  }
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("A draft composer needs startSession to send its first prompt")
  return value
}
