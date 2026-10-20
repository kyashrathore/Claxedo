import type { WorkspaceStartResult } from "@claxedo/plugin-api"
import type { TasksClient } from "../../client/client"
import type { ConfigurationSlot, PresetPlacement, SessionRef, StartBlocker, StartPreview, StartResponse, Task, TaskSummary } from "../../contracts"
import type { Translate } from "../dictionary"
import { tasksRefusalOf } from "../refusal"
import { groupLinksBySlot, slotAttempt } from "./model"

export type TaskStartRequest = {
  readonly taskId: string
  readonly taskRevision: number
  readonly presetId: string
  readonly presetRevision: number
  readonly slot: ConfigurationSlot
  readonly attempt: number
  readonly continueFromPrevious: boolean
}

export type StartChoice = {
  readonly presetId: string
  readonly presetRevision: number
  readonly placement: PresetPlacement
  readonly slot: ConfigurationSlot
  readonly continueFromPrevious?: boolean
}

export type StartOutcome = { readonly ok: true } | { readonly ok: false; readonly message: string }

export type StartProgress =
  | { readonly kind: "idle" }
  | { readonly kind: "preparing"; readonly taskId: string; readonly slot: ConfigurationSlot; readonly placement: PresetPlacement }
  | { readonly kind: "starting"; readonly taskId: string; readonly slot: ConfigurationSlot }
  | { readonly kind: "machine"; readonly taskId: string; readonly slot: ConfigurationSlot; readonly step: string | undefined }

export type StartProgressEvent =
  | { readonly type: "startBegan"; readonly taskId: string; readonly slot: ConfigurationSlot; readonly placement: PresetPlacement }
  | { readonly type: "previewAnswered" }
  | { readonly type: "machineStep"; readonly step: string | undefined }
  | { readonly type: "machineRunning" }
  | { readonly type: "settled" }

export const START_IDLE: StartProgress = { kind: "idle" }

export function startProgressTransition(state: StartProgress, event: StartProgressEvent): StartProgress {
  switch (event.type) {
    case "startBegan":
      return { kind: "preparing", taskId: event.taskId, slot: event.slot, placement: event.placement }
    case "previewAnswered":
      return state.kind === "preparing" && state.placement === "local" ? { kind: "starting", taskId: state.taskId, slot: state.slot } : state
    case "machineStep":
      return state.kind === "idle" ? state : { kind: "machine", taskId: state.taskId, slot: state.slot, step: event.step }
    case "machineRunning":
      return state.kind === "machine" ? { kind: "starting", taskId: state.taskId, slot: state.slot } : state
  }
  return START_IDLE
}

export function startProgressText(t: Translate, progress: StartProgress): string | undefined {
  if (progress.kind === "idle") return undefined
  if (progress.kind === "starting") return t("claxedo-tasks.start.progress.session")
  if (progress.kind === "machine") return progress.step ? t("claxedo-tasks.start.progress.machine", { step: progress.step }) : t("claxedo-tasks.start.progress.cloud")
  return t(progress.placement === "cloud" ? "claxedo-tasks.start.progress.cloud" : "claxedo-tasks.start.progress.local")
}

export type StartCalls = {
  readonly client: Pick<TasksClient, "getTask" | "startPreview" | "start">
  readonly followStart: (workspaceId: string, onProgress: (text: string | undefined) => void) => Promise<WorkspaceStartResult>
  readonly openSession: (session: SessionRef) => Promise<void>
  readonly requestId: () => string
  readonly t: Translate
}

async function startRequest(calls: StartCalls, task: Task | TaskSummary, choice: StartChoice): Promise<TaskStartRequest> {
  const detail = await calls.client.getTask(task.id)
  const next = slotAttempt(groupLinksBySlot(detail.links), choice.slot)
  return {
    taskId: task.id,
    taskRevision: detail.task.revision,
    presetId: choice.presetId,
    presetRevision: choice.presetRevision,
    slot: choice.slot,
    attempt: next.attempt,
    continueFromPrevious: choice.continueFromPrevious === true,
  }
}

async function sendStart(calls: StartCalls, request: TaskStartRequest, previewDigest: string, clientRequestId: string): Promise<StartResponse> {
  const { taskId, ...body } = request
  return calls.client.start(taskId, { ...body, clientRequestId, previewDigest, handoffText: null })
}

async function sessionOf(calls: StartCalls, request: TaskStartRequest, preview: StartPreview, report: (event: StartProgressEvent) => void): Promise<SessionRef | { readonly refused: string }> {
  const clientRequestId = calls.requestId()
  const answered = await sendStart(calls, request, preview.digest, clientRequestId)
  if ("link" in answered) return answered.link.sessionRef
  report({ type: "machineStep", step: undefined })
  const root = await calls.followStart(answered.preparing.workspaceId, (step) => report({ type: "machineStep", step }))
  if (root.kind === "failed") return { refused: root.message || calls.t("claxedo-tasks.start.rootDidNotStart") }
  report({ type: "machineRunning" })
  const again = await sendStart(calls, request, preview.digest, clientRequestId)
  return "link" in again ? again.link.sessionRef : { refused: calls.t("claxedo-tasks.start.rootStillStarting") }
}

function blockedMessage(t: Translate, blocker: StartBlocker | undefined): string {
  if (!blocker) return t("claxedo-tasks.start.cannotRun")
  return blocker.code === "rate_limited" ? t("claxedo-tasks.error.rateLimit") : blocker.detail
}

export async function startNow(calls: StartCalls, task: Task | TaskSummary, choice: StartChoice, report: (event: StartProgressEvent) => void): Promise<StartOutcome> {
  try {
    report({ type: "startBegan", taskId: task.id, slot: choice.slot, placement: choice.placement })
    const request = await startRequest(calls, task, choice)
    const { taskId, ...body } = request
    const preview = (await calls.client.startPreview(taskId, body)).preview
    if (!preview.available) return { ok: false, message: blockedMessage(calls.t, preview.blockers[0]) }
    if (request.continueFromPrevious && !preview.previousTranscriptReadable) return { ok: false, message: calls.t("claxedo-tasks.start.unreadablePrevious") }
    report({ type: "previewAnswered" })
    const session = await sessionOf(calls, { ...request, attempt: preview.attempt }, preview, report)
    if ("refused" in session) return { ok: false, message: session.refused }
    await calls.openSession(session)
    return { ok: true }
  } catch (error) {
    return { ok: false, message: tasksRefusalOf(error, calls.t).message }
  } finally {
    report({ type: "settled" })
  }
}
