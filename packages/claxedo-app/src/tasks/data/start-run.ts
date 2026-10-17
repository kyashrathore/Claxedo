import type { ConfigurationSlot, PresetPlacement, SessionRef, StartBlocker, StartPreview, StartResponse, Task, TaskSummary } from "@claxedo/tasks"
import type { TasksClient } from "@claxedo/tasks/client"
import type { DomainTranslate } from "@/i18n"
import { unreachable } from "@/lib/machine"
import { uuid } from "@/lib/uuid"
import type { AppError, PlacementId } from "@/server"
import type { TasksKey } from "../i18n"
import { groupLinksBySlot, slotAttempt } from "../model"
import { rateLimitOf, refusalOf, startBlockerRateLimit } from "./refusal"

export type TaskStartRequest = {
  readonly taskId: string
  readonly taskRevision: number
  readonly presetId: string
  readonly presetRevision: number
  readonly slot: ConfigurationSlot
  readonly attempt: number
  readonly continueFromPrevious: boolean
}

export type StartCopy = {
  readonly t: DomainTranslate<TasksKey>
  readonly errorMessage: (error: AppError) => string
}

export type StartOutcome = { readonly ok: true } | { readonly ok: false; readonly message: string }

export type StartChoiceInput = {
  readonly presetId: string
  readonly presetRevision: number
  readonly placement: PresetPlacement
  readonly slot: ConfigurationSlot
  readonly continueFromPrevious?: boolean
}

export type RootRun = { readonly kind: "running" } | { readonly kind: "failed"; readonly message: string }

export type StartCalls = {
  readonly api: { readonly client: Pick<TasksClient, "getTask"> }
  readonly preview: (request: TaskStartRequest) => Promise<StartPreview>
  readonly start: (request: TaskStartRequest, previewDigest: string, clientRequestId: string) => Promise<StartResponse>
  readonly followRoot: (workspaceId: string, following: (placementId: PlacementId) => void) => Promise<RootRun>
  readonly open: (taskId: string, session: SessionRef) => Promise<void>
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

async function sessionOf(
  calls: StartCalls,
  copy: StartCopy,
  request: TaskStartRequest,
  previewDigest: string,
  report: (event: TaskStartProgressEvent) => void,
): Promise<SessionRef | { readonly refused: string }> {
  const clientRequestId = uuid()
  const answered = await calls.start(request, previewDigest, clientRequestId)
  if ("link" in answered) return answered.link.sessionRef
  const root = await calls.followRoot(answered.preparing.workspaceId, (placementId) => report({ type: "rootFollowed", placementId }))
  if (root.kind === "failed") return { refused: root.message }
  report({ type: "rootRunning" })
  const again = await calls.start(request, previewDigest, clientRequestId)
  return "link" in again ? again.link.sessionRef : { refused: copy.t("tasks.start.rootStillStarting") }
}

function blockedMessage(copy: StartCopy, blocker: StartBlocker | undefined): string {
  if (!blocker) return copy.t("tasks.start.cannotRun")
  const limited = startBlockerRateLimit(blocker)
  return limited ? copy.errorMessage(limited) : blocker.detail
}

function refusedMessage(copy: StartCopy, error: unknown): string {
  const limited = rateLimitOf(error)
  return limited ? copy.errorMessage(limited) : refusalOf(error).message
}

export async function startNow(
  calls: StartCalls,
  copy: StartCopy,
  task: Task | TaskSummary,
  choice: StartChoiceInput,
  report: (event: TaskStartProgressEvent) => void,
): Promise<StartOutcome> {
  try {
    const request = await startRequest(calls, task, choice)
    report({ type: "previewSent", taskId: task.id, slot: choice.slot, placement: choice.placement })
    const resolved = await calls.preview(request)
    if (!resolved.available) return { ok: false, message: blockedMessage(copy, resolved.blockers[0]) }
    if (request.continueFromPrevious && !resolved.previousTranscriptReadable)
      return { ok: false, message: copy.t("tasks.start.unreadablePrevious") }
    report({ type: "previewAnswered" })
    const session = await sessionOf(calls, copy, { ...request, attempt: resolved.attempt }, resolved.digest, report)
    if ("refused" in session) return { ok: false, message: session.refused }
    await calls.open(task.id, session)
    return { ok: true }
  } catch (error) {
    return { ok: false, message: refusedMessage(copy, error) }
  } finally {
    report({ type: "settled" })
  }
}

export type TaskStartProgress =
  | { readonly kind: "idle" }
  | { readonly kind: "preparing"; readonly taskId: string; readonly slot: ConfigurationSlot; readonly placement: PresetPlacement }
  | { readonly kind: "starting"; readonly taskId: string; readonly slot: ConfigurationSlot }
  | { readonly kind: "machine"; readonly taskId: string; readonly slot: ConfigurationSlot; readonly placementId: PlacementId }

export type TaskStartProgressEvent =
  | { readonly type: "previewSent"; readonly taskId: string; readonly slot: ConfigurationSlot; readonly placement: PresetPlacement }
  | { readonly type: "previewAnswered" }
  | { readonly type: "rootFollowed"; readonly placementId: PlacementId }
  | { readonly type: "rootRunning" }
  | { readonly type: "settled" }

export const START_IDLE: TaskStartProgress = { kind: "idle" }

export function startProgressTransition(state: TaskStartProgress, event: TaskStartProgressEvent): TaskStartProgress {
  switch (event.type) {
    case "previewSent":
      return { kind: "preparing", taskId: event.taskId, slot: event.slot, placement: event.placement }
    case "previewAnswered":
      return state.kind === "preparing" && state.placement === "local" ? { kind: "starting", taskId: state.taskId, slot: state.slot } : state
    case "rootFollowed":
      return state.kind === "preparing" ? { kind: "machine", taskId: state.taskId, slot: state.slot, placementId: event.placementId } : state
    case "rootRunning":
      return state.kind === "machine" ? { kind: "starting", taskId: state.taskId, slot: state.slot } : state
    case "settled":
      return START_IDLE
    default:
      return unreachable(event)
  }
}

export type TaskStartLine = { readonly kind: "key"; readonly key: TasksKey } | { readonly kind: "machine"; readonly placementId: PlacementId }

export function startProgressLine(progress: TaskStartProgress, taskId: string, slot: ConfigurationSlot | undefined): TaskStartLine | undefined {
  if (progress.kind === "idle" || progress.taskId !== taskId || (slot !== undefined && progress.slot !== slot)) return undefined
  if (progress.kind === "machine") return { kind: "machine", placementId: progress.placementId }
  if (progress.kind === "starting") return { kind: "key", key: "tasks.start.progress.session" }
  return { kind: "key", key: progress.placement === "cloud" ? "tasks.start.progress.cloud" : "tasks.start.progress.local" }
}
