import { createMemo, type Accessor } from "solid-js"
import type { HarnessInfo, PromptAttachment, PromptInput } from "@/server"
import type { SessionView } from "@/session"
import { machine } from "@/lib/machine"
import type { Draft, EditorMode, HistoryComment, Selection, SendEvent, SendState } from "./model"
import { promptFilled, promptImages, promptText, randomId, sendTransition } from "./model"
import { flattenMarkedImages } from "./marks/flatten"
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
    if (!item.comment?.trim()) return []
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

export async function buildPromptInput(input: {
  draft: Draft
  mode: EditorMode
  selection: Selection
  goal: GoalIntent
}): Promise<PromptInput> {
  const images = await flattenMarkedImages(promptImages(input.draft.prompt))
  const text = promptText(input.draft.prompt).trim()
  const files = input.draft.prompt.flatMap((part): PromptAttachment[] => (part.type === "file" ? [{ kind: "file", path: part.path }] : []))
  const comments = input.draft.context.flatMap((item): PromptAttachment[] =>
    item.comment?.trim() ? [{ kind: "text", text: item.comment, label: commentLabel(item.path, item.selection) }] : [],
  )
  return {
    clientRequestId: randomId(),
    text: input.mode === "shell" ? `!${text}` : text,
    attachments: [...images.map((image): PromptAttachment => ({ kind: "image", dataUrl: image.dataUrl, name: image.filename, mime: image.mime })), ...files, ...comments],
    model: input.selection.model,
    effort: input.selection.effort,
    permissionMode: input.selection.permissionMode,
    goal: input.goal.kind === "submit" ? { objective: input.goal.objective } : undefined,
  }
}

export function createComposerSend(input: {
  key: Accessor<ComposerKey>
  store: ComposerStore
  mode: Accessor<EditorMode>
  goalMode: Accessor<HarnessInfo["goalMode"] | undefined>
  view: Accessor<SessionView | undefined>
  createSession?: () => Promise<SessionView>
  afterAccepted?: (view: SessionView) => void
  focusEditor: () => void
}) {
  const state = machine<SendState, SendEvent>({ kind: "editing" }, sendTransition)
  const sending = createMemo(() => state.state().kind === "sending")

  const arm = () => {
    input.store.setGoalArmed(input.key(), true)
    input.store.reset(input.key())
    input.store.setGoalArmed(input.key(), true)
    requestAnimationFrame(input.focusEditor)
  }

  const send = async () => {
    const key = input.key()
    const draft = input.store.draft(key)
    if (sending() || !promptFilled(draft)) return
    const goal = goalIntent(promptText(draft.prompt), draft.goalArmed, input.goalMode())
    if (goal.kind === "arm") return arm()
    const clientRequestId = randomId()
    state.send({ type: "sendStarted", clientRequestId })
    try {
      const prompt = await buildPromptInput({ draft, mode: input.mode(), selection: input.store.selection(key), goal })
      const view = input.view() ?? (await required(input.createSession)())
      await view.send({ ...prompt, clientRequestId })
      input.store.addHistory(key, input.mode(), draft.prompt, historyComments(draft))
      input.store.reset(key)
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
    edited: () => state.send({ type: "edited" }),
    stop: async () => {
      const view = input.view()
      if (view) await view.stop()
    },
  }
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("A draft composer needs createSession to send its first prompt")
  return value
}
