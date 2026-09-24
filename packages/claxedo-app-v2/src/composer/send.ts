import { createMemo, type Accessor } from "solid-js"
import type { HarnessInfo, PromptAttachment, PromptInput } from "@/server"
import type { SessionView } from "@/session"
import { formatCommentNote, formatImageMarkNote } from "@/lib/comment-note"
import { machine } from "@/lib/machine"
import type { Draft, EditorMode, HistoryComment, SendEvent, SendState, StopEvent, StopState, Submission } from "./model"
import { promptFilled, promptImages, promptText, randomId, sendTransition, stopTransition } from "./model"
import { flattenMarkedImages } from "./marks/flatten"
import { numberImageMarks } from "./marks/marks"
import { asAppError } from "./errors"
import type { ComposerKey, ComposerStore } from "./store"

export type GoalIntent = { kind: "none" } | { kind: "arm" } | { kind: "submit"; objective: string }

export function goalIntent(text: string, armed: boolean, goalMode: HarnessInfo["goalMode"] | undefined): GoalIntent {
  const trimmed = text.trim()
  const slash = /^\/goal(?:\s+([\s\S]*))?$/.exec(trimmed)
  if (slash) {
    if (goalMode === "none" || goalMode === undefined) return { kind: "none" }
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
  mode: EditorMode
  submission: Submission
  goal: GoalIntent
  delivery: PromptInput["delivery"]
}): Promise<PromptInput> {
  const images = await flattenMarkedImages(promptImages(input.draft.prompt))
  const text = promptText(input.draft.prompt).trim()
  const files = input.draft.prompt.flatMap((part): PromptAttachment[] => (part.type === "file" ? [{ kind: "file", path: part.path }] : []))
  return {
    clientRequestId: randomId(),
    text: input.mode === "shell" ? `!${text}` : text,
    attachments: [
      ...images.map((image): PromptAttachment => ({ kind: "image", dataUrl: image.dataUrl, name: image.filename, mime: image.mime })),
      ...files,
      ...noteAttachments(input.draft),
    ],
    model: input.submission.model,
    effort: input.submission.effort,
    serviceTier: input.submission.serviceTier,
    goal: input.goal.kind === "submit" ? { objective: input.goal.objective } : undefined,
    delivery: input.delivery,
  }
}

type SendInput = {
  key: Accessor<ComposerKey>
  store: ComposerStore
  mode: Accessor<EditorMode>
  submission: () => Promise<Submission>
  working: Accessor<boolean>
  goalMode: Accessor<HarnessInfo["goalMode"] | undefined>
  view: Accessor<SessionView | undefined>
  createSession?: (submission: Submission) => Promise<SessionView>
  afterAccepted?: (view: SessionView) => void
  focusEditor: () => void
}

function createStop(view: Accessor<SessionView | undefined>) {
  const state = machine<StopState, StopEvent>({ kind: "idle" }, stopTransition)
  const stop = async () => {
    const current = view()
    if (!current || state.state().kind === "stopping") return
    state.send({ type: "stopStarted" })
    try {
      await current.stop()
      state.send({ type: "stopFinished" })
    } catch (error) {
      state.send({ type: "stopFailed", error: asAppError(error) })
    }
  }
  return { state: state.state, stop, dismiss: () => state.send({ type: "stopFinished" }) }
}

function createArmGoal(input: SendInput) {
  return () => {
    const key = input.key()
    input.store.setPrompt(key, promptImages(input.store.draft(key).prompt), 0)
    input.store.setGoalArmed(key, true)
    requestAnimationFrame(input.focusEditor)
  }
}

async function deliver(input: SendInput, draft: Draft, goal: GoalIntent, clientRequestId: string): Promise<SessionView> {
  const key = input.key()
  const delivery = input.working() ? "queue" : undefined
  const submission = await input.submission()
  const prompt = await buildPromptInput({ draft, mode: input.mode(), submission, goal, delivery })
  const view = input.view() ?? (await required(input.createSession)(submission))
  await view.send({ ...prompt, clientRequestId })
  input.store.addHistory(key, input.mode(), draft.prompt, historyComments(draft))
  input.store.reset(key)
  return view
}

export function createComposerSend(input: SendInput) {
  const state = machine<SendState, SendEvent>({ kind: "editing" }, sendTransition)
  const sending = createMemo(() => state.state().kind === "sending")
  const armGoal = createArmGoal(input)
  const stop = createStop(input.view)
  const send = async () => {
    const draft = input.store.draft(input.key())
    if (sending() || !promptFilled(draft)) return
    const goal = goalIntent(promptText(draft.prompt), draft.goalArmed, input.goalMode())
    if (goal.kind === "arm") return armGoal()
    const clientRequestId = randomId()
    state.send({ type: "sendStarted", clientRequestId })
    try {
      const view = await deliver(input, draft, goal, clientRequestId)
      state.send({ type: "sendAccepted", clientRequestId })
      input.afterAccepted?.(view)
    } catch (error) {
      state.send({ type: "sendRejected", error: asAppError(error) })
    }
  }
  return {
    state: state.state,
    sending,
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
  if (value === undefined) throw new Error("A draft composer needs createSession to send its first prompt")
  return value
}
