import type { ConfigurationSlot, SessionReference, StartPreview, Task, TaskSummary } from "@claxedo/tasks"
import { groupLinksBySlot } from "@claxedo/tasks/solid"
import { uuid } from "@/lib/uuid"
import { useTasksAppPorts } from "../app-ports"
import { refusalOf } from "./tasks-api"
import { useTasksClient, useTasksInvalidation, type TasksScope } from "./queries"

export type StartRequest = {
  taskId: string
  taskRevision: number
  presetId: string
  presetRevision: number
  slot: ConfigurationSlot
  attempt: number
  continueFromPrevious: boolean
}

export type StartOutcome = { ok: true } | { ok: false; message: string }

/**
 * The two calls a Start is made of, and the session it opens.
 *
 * The dialog and a list row both start tasks, and neither builds the request
 * itself: the digest binds a preview to the revision it resolved against, so a
 * second spelling of "preview then start" is a second chance to send one that
 * does not match.
 */
export function useStartTaskCommands(scope: () => TasksScope) {
  const client = useTasksClient()
  const invalidate = useTasksInvalidation(scope)
  const openSession = useTasksAppPorts().useOpenSession()

  const preview = async (request: StartRequest): Promise<StartPreview> => {
    const response = await client().startPreview(request.taskId, {
      taskRevision: request.taskRevision,
      presetId: request.presetId,
      presetRevision: request.presetRevision,
      slot: request.slot,
      attempt: request.attempt,
      continueFromPrevious: request.continueFromPrevious,
    })
    return response.preview
  }

  const send = async (
    request: StartRequest,
    previewDigest: string,
    handoffText: string | null,
  ): Promise<SessionReference> => {
    const response = await client().start(request.taskId, {
      clientRequestId: uuid(),
      taskRevision: request.taskRevision,
      presetId: request.presetId,
      presetRevision: request.presetRevision,
      slot: request.slot,
      attempt: request.attempt,
      previewDigest,
      handoffText,
      continueFromPrevious: request.continueFromPrevious,
    })
    invalidate.task(request.taskId)
    await invalidate.everything()
    openSession(response.link.sessionRef)
    return response.link.sessionRef
  }

  /**
   * The whole of a row's Start. A preview the host refuses is reported as the
   * blocker it named rather than sent anyway: `available` is the server's
   * answer about this machine, and the row has no dialog to show it in.
   */
  const startNow = async (task: Task | TaskSummary, choice: { presetId: string; presetRevision: number; slot: ConfigurationSlot }): Promise<StartOutcome> => {
    const request: StartRequest = {
      taskId: task.id,
      taskRevision: task.revision,
      presetId: choice.presetId,
      presetRevision: choice.presetRevision,
      slot: choice.slot,
      attempt: 1,
      continueFromPrevious: false,
    }
    try {
      const resolved = await preview(request)
      if (!resolved.available) {
        return { ok: false, message: resolved.blockers[0]?.detail ?? "This preset cannot run here." }
      }
      await send({ ...request, attempt: resolved.attempt }, resolved.digest, null)
      return { ok: true }
    } catch (error) {
      return { ok: false, message: refusalOf(error).message }
    }
  }

  /**
   * The session a row's Open goes to, read when it is pressed. A list read
   * carries a link count and no liveness, so which session is current is a
   * question only the task's own read answers.
   */
  const openLatestSession = async (taskId: string): Promise<StartOutcome> => {
    try {
      const detail = await client().getTask(taskId)
      const groups = groupLinksBySlot(detail?.links ?? [])
      const current = groups.find((group) => group.slot === "primary")?.current ?? groups.find((group) => group.current)?.current
      if (!current) return { ok: false, message: "This task has no session to open." }
      openSession(current.sessionRef)
      return { ok: true }
    } catch (error) {
      return { ok: false, message: refusalOf(error).message }
    }
  }

  return { preview, send, startNow, openLatestSession }
}
