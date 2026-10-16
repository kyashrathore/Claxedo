import type { ConfigurationSlot, PresetPlacement, SessionRef, StartPreview, Task, TaskSummary } from "@claxedo/tasks"
import type { TasksClient } from "@claxedo/tasks/client"
import type { DomainTranslate } from "@/i18n"
import { unreachable } from "@/lib/machine"
import type { TasksKey } from "../i18n"
import { groupLinksBySlot, slotAttempt } from "../model"
import { refusalOf } from "./refusal"

export type TaskStartRequest = {
  readonly taskId: string
  readonly taskRevision: number
  readonly presetId: string
  readonly presetRevision: number
  readonly slot: ConfigurationSlot
  readonly attempt: number
  readonly continueFromPrevious: boolean
}

export type StartOutcome = { readonly ok: true } | { readonly ok: false; readonly message: string }

export type StartChoiceInput = {
  readonly presetId: string
  readonly presetRevision: number
  readonly placement: PresetPlacement
  readonly slot: ConfigurationSlot
  readonly continueFromPrevious?: boolean
}

export type StartCalls = {
  readonly api: { readonly client: Pick<TasksClient, "getTask"> }
  readonly preview: (request: TaskStartRequest) => Promise<StartPreview>
  readonly send: (request: TaskStartRequest, previewDigest: string) => Promise<SessionRef>
}

async function startRequest(calls: StartCalls, task: Task | TaskSummary, choice: StartChoiceInput): Promise<TaskStartRequest> {
  const detail = await calls.api.client.getTask(task.id)
  const next = slotAttempt(groupLinksBySlot(detail?.links ?? []), choice.slot)
  return {
    taskId: task.id,
    taskRevision: detail?.task.revision ?? task.revision,
    presetId: choice.presetId,
    presetRevision: choice.presetRevision,
    slot: choice.slot,
    attempt: next.attempt,
    continueFromPrevious: choice.continueFromPrevious === true,
  }
}

export async function startNow(
  calls: StartCalls,
  t: DomainTranslate<TasksKey>,
  task: Task | TaskSummary,
  choice: StartChoiceInput,
  report: (event: TaskStartProgressEvent) => void,
): Promise<StartOutcome> {
  try {
    const request = await startRequest(calls, task, choice)
    report({ type: "previewSent", taskId: task.id, slot: choice.slot, placement: choice.placement })
    const resolved = await calls.preview(request)
    if (!resolved.available) return { ok: false, message: resolved.blockers[0]?.detail ?? t("tasks.start.cannotRun") }
    if (request.continueFromPrevious && !resolved.previousTranscriptReadable)
      return { ok: false, message: t("tasks.start.unreadablePrevious") }
    report({ type: "previewAnswered" })
    await calls.send({ ...request, attempt: resolved.attempt }, resolved.digest)
    return { ok: true }
  } catch (error) {
    return { ok: false, message: refusalOf(error).message }
  } finally {
    report({ type: "settled" })
  }
}

export type TaskStartProgress =
  | { readonly kind: "idle" }
  | { readonly kind: "preparing"; readonly taskId: string; readonly slot: ConfigurationSlot; readonly placement: PresetPlacement }
  | { readonly kind: "starting"; readonly taskId: string; readonly slot: ConfigurationSlot }

export type TaskStartProgressEvent =
  | { readonly type: "previewSent"; readonly taskId: string; readonly slot: ConfigurationSlot; readonly placement: PresetPlacement }
  | { readonly type: "previewAnswered" }
  | { readonly type: "settled" }

export const START_IDLE: TaskStartProgress = { kind: "idle" }

export function startProgressTransition(state: TaskStartProgress, event: TaskStartProgressEvent): TaskStartProgress {
  switch (event.type) {
    case "previewSent":
      return { kind: "preparing", taskId: event.taskId, slot: event.slot, placement: event.placement }
    case "previewAnswered":
      return state.kind === "preparing" ? { kind: "starting", taskId: state.taskId, slot: state.slot } : state
    case "settled":
      return START_IDLE
    default:
      return unreachable(event)
  }
}

export function startProgressKey(progress: TaskStartProgress, taskId: string, slot: ConfigurationSlot | undefined): TasksKey | undefined {
  if (progress.kind === "idle" || progress.taskId !== taskId || (slot !== undefined && progress.slot !== slot)) return undefined
  if (progress.kind === "starting") return "tasks.start.progress.session"
  return progress.placement === "cloud" ? "tasks.start.progress.cloud" : "tasks.start.progress.local"
}
