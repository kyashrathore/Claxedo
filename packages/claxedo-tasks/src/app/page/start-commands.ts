import type { ConfigurationSlot, Preset, SessionRef, Task, TaskSessionLinkView, TaskSummary } from "../../contracts"
import { SLOT_KEYS } from "../slots"
import { tasksRefusalOf } from "../refusal"
import { groupLinksBySlot, LIVENESS_KEYS, openableSlot } from "./model"
import type { PageModel } from "./page-model"
import { startNow, startProgressTransition, type StartCalls, type StartOutcome } from "./start-run"
import type { TaskReloads } from "./task-commands"

export function createStartCommands(model: PageModel, reloads: TaskReloads) {
  const { deps } = model
  const refused = (task: Pick<TaskSummary, "id" | "title">, message: string) => {
    model.patch({ startRefusal: { taskId: task.id, title: task.title, message } })
    deps.ui.toast({ kind: "error", title: deps.t("claxedo-tasks.start.refusedTitle", { title: task.title }), description: message })
  }
  const opened = async (session: SessionRef) => {
    const refresh = reloads.list(true)
    await deps.openSession(session)
    await refresh
  }
  const calls: StartCalls = { client: deps.client, followStart: deps.followStart, openSession: opened, requestId: deps.requestId, t: deps.t }
  const busy = async (task: Pick<TaskSummary, "id" | "title">, work: () => Promise<StartOutcome>) => {
    if (model.state().busyTaskId) return
    model.patch({ busyTaskId: task.id, startRefusal: undefined, progressTitle: task.title })
    const outcome = await work()
    model.patch({ busyTaskId: undefined })
    if (!outcome.ok) refused(task, outcome.message)
  }
  const start = (task: Task | TaskSummary, preset: Preset, slot: ConfigurationSlot, continueFromPrevious = false) =>
    busy(task, async () => {
      const outcome = await startNow(calls, task, { presetId: preset.id, presetRevision: preset.revision, placement: preset.execution.placement, slot, continueFromPrevious }, (event) =>
        model.patch((state) => ({ progress: startProgressTransition(state.progress, event) })),
      )
      if (outcome.ok) model.patch({ startWith: preset.id })
      return outcome
    })
  const openLatest = (task: Pick<TaskSummary, "id" | "title">) =>
    busy(task, async () => {
      try {
        const chosen = openableSlot(groupLinksBySlot((await deps.client.getTask(task.id)).links))
        if (!chosen) return { ok: false, message: deps.t("claxedo-tasks.start.noSession") }
        if (!chosen.open) return { ok: false, message: deps.t("claxedo-tasks.start.sessionGone", { slot: deps.t(SLOT_KEYS[chosen.slot]).toLowerCase(), liveness: deps.t(LIVENESS_KEYS[chosen.current.liveness]) }) }
        await deps.openSession(chosen.open.sessionRef)
        return { ok: true }
      } catch (error) {
        return { ok: false, message: tasksRefusalOf(error, deps.t).message }
      }
    })
  const openLink = (task: Pick<TaskSummary, "id" | "title">, link: TaskSessionLinkView | undefined) =>
    busy(task, async () => {
      if (!link) return { ok: false, message: deps.t("claxedo-tasks.start.noSession") }
      try {
        await deps.openSession(link.sessionRef)
        return { ok: true }
      } catch (error) {
        return { ok: false, message: tasksRefusalOf(error, deps.t).message }
      }
    })
  const sendTask = (task: Task, link: TaskSessionLinkView) =>
    busy(task, async () => {
      const request = { taskRevision: task.revision, presetId: link.presetId, presetRevision: link.presetRevision, slot: link.slot, attempt: link.attempt, continueFromPrevious: false }
      try {
        const preview = await deps.client.startPreview(task.id, request)
        await deps.client.start(task.id, { ...request, clientRequestId: deps.requestId(), previewDigest: preview.preview.digest, handoffText: null })
        await reloads.detail(task.id)
        return { ok: true }
      } catch (error) {
        return { ok: false, message: tasksRefusalOf(error, deps.t).message }
      }
    })
  return { start, openLatest, openLink, sendTask }
}

export type StartCommands = ReturnType<typeof createStartCommands>
