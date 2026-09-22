import { createSignal } from "solid-js"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import type { ConfigurationSlot, Preset, SessionReference, StartPreview, Task, TaskSummary } from "@claxedo/tasks"
import type { StartChoice, TaskStartOffer } from "../ui/shared/task-row-controls"
import { SLOT_LABELS, groupLinksBySlot, openableSlot, slotAttempt } from "../view-model"
import { uuid } from "@/lib/uuid"
import { useTasksAppPorts } from "../app-ports"
import { refusalOf } from "./tasks-api"
import { followRetry, listFailure, usePresetList, useTasksClient, useTasksInvalidation, type TasksScope } from "./queries"
import type { TasksStore } from "../store/tasks-store"

type StartRequest = {
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
 * The digest binds a preview to the revision it resolved against, so a second
 * spelling of "preview then start" is a second chance to send one that does
 * not match.
 */
function useStartTaskCommands(scope: () => TasksScope) {
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

  const send = async (request: StartRequest, previewDigest: string): Promise<SessionReference> => {
    const response = await client().start(request.taskId, {
      clientRequestId: uuid(),
      taskRevision: request.taskRevision,
      presetId: request.presetId,
      presetRevision: request.presetRevision,
      slot: request.slot,
      attempt: request.attempt,
      previewDigest,
      handoffText: null,
      continueFromPrevious: request.continueFromPrevious,
    })
    await invalidate.afterCommand(request.taskId)
    openSession(response.link.sessionRef)
    return response.link.sessionRef
  }

  /**
   * The whole of a Start. A preview the host refuses is reported as the blocker
   * it named rather than sent anyway: `available` is the server's answer about
   * this machine, and the control has no dialog to show it in.
   *
   * The task is read first because the attempt is not a constant: the service
   * accepts the slot's current attempt only while its session is live, and
   * `current + 1` once it is gone. Asking for 1 every time was refused by every
   * slot that had already run.
   *
   * A continue the host cannot read is refused here rather than started: the
   * service drops an unreadable transcript and starts a fresh session, which is
   * not what the person who chose to continue asked for.
   */
  const startNow = async (
    task: Task | TaskSummary,
    choice: { presetId: string; presetRevision: number; slot: ConfigurationSlot; continueFromPrevious?: boolean },
  ): Promise<StartOutcome> => {
    try {
      const detail = await client().getTask(task.id)
      const next = slotAttempt(groupLinksBySlot(detail?.links ?? []), choice.slot)
      const request: StartRequest = {
        taskId: task.id,
        taskRevision: detail?.task.revision ?? task.revision,
        presetId: choice.presetId,
        presetRevision: choice.presetRevision,
        slot: choice.slot,
        attempt: next.attempt,
        continueFromPrevious: choice.continueFromPrevious === true,
      }
      const resolved = await preview(request)
      if (!resolved.available) {
        return { ok: false, message: resolved.blockers[0]?.detail ?? "This preset cannot run here." }
      }
      if (request.continueFromPrevious && !resolved.previousTranscriptReadable) {
        return { ok: false, message: "The previous session cannot be read from here, so there is nothing to continue from." }
      }
      await send({ ...request, attempt: resolved.attempt }, resolved.digest)
      return { ok: true }
    } catch (error) {
      return { ok: false, message: refusalOf(error).message }
    }
  }

  /**
   * The session a row's Open goes to, read when it is pressed. A list read
   * carries a link count and no liveness, so both which slot ran and whether
   * its session is still there are questions only the task's own read answers
   * — and a session the host reports gone is not somewhere to navigate to.
   */
  const openLatestSession = async (taskId: string): Promise<StartOutcome> => {
    try {
      const detail = await client().getTask(taskId)
      const chosen = openableSlot(groupLinksBySlot(detail?.links ?? []))
      if (!chosen) return { ok: false, message: "This task has no session to open." }
      if (chosen.open) {
        openSession(chosen.open.sessionRef)
        return { ok: true }
      }
      return {
        ok: false,
        message: `The ${SLOT_LABELS[chosen.slot].toLowerCase()} session for this task is ${chosen.current.liveness}. Start it again to get a new one.`,
      }
    } catch (error) {
      return { ok: false, message: refusalOf(error).message }
    }
  }

  return { startNow, openLatestSession }
}

export type StartOfferOptions = {
  /** One slot's control, on the task page; absent on a row, whose menu spans every slot a preset configures. */
  slot?: ConfigurationSlot
  /** The word on the main part where the slot has run and its session is gone. */
  startLabel?: string
  /** The preset the slot's last attempt ran, which is the one a continue repeats. */
  continueWith?: string
  /** Present only where the surface already knows there is a session to open. */
  onOpen?: () => void
}

/**
 * What a Start control may offer, and the calls behind it.
 *
 * One builder for the list row, the board card and the task page: they start
 * the same way, and a second answer to which preset a bare Start uses, or to
 * what a refusal does, would be a second product.
 */
export function useTaskStartOffers(scope: () => TasksScope, store: TasksStore) {
  const ports = useTasksAppPorts()
  const dialog = useDialog()
  const openPresetSettings = ports.useOpenPresetSettings()
  const commands = useStartTaskCommands(scope)
  const presets = usePresetList(scope, () => false)
  const [busyTaskId, setBusyTaskId] = createSignal<string | undefined>()

  const busyWhile = async <T>(taskId: string, run: () => Promise<T>): Promise<T> => {
    setBusyTaskId(taskId)
    try {
      return await run()
    } finally {
      setBusyTaskId(undefined)
    }
  }

  /**
   * The preset a bare Start uses: the last one started in this scope, else the
   * first the control can offer — never a guess between several, which the
   * caret is for.
   */
  const defaultPresetId = (offered: readonly Preset[]) => {
    const last = store.state.lastPresetId
    if (last !== undefined && offered.some((preset) => preset.id === last)) return last
    return offered[0]?.id
  }

  const start = (task: Task | TaskSummary, choice: StartChoice, continueFromPrevious = false) =>
    busyWhile(task.id, async () => {
      const preset = presets.items().find((entry) => entry.id === choice.presetId)
      if (!preset) return
      const outcome = await commands.startNow(task, {
        presetId: preset.id,
        presetRevision: preset.revision,
        slot: choice.slot,
        continueFromPrevious,
      })
      if (outcome.ok) store.startedWith(task.id, preset.id)
      else store.refuseStart(task.id, outcome.message)
    })

  const openLatestSession = (taskId: string) =>
    busyWhile(taskId, async () => {
      const outcome = await commands.openLatestSession(taskId)
      if (!outcome.ok) store.refuseStart(taskId, outcome.message)
    })

  const offerFor = (task: Task | TaskSummary, options: StartOfferOptions = {}): TaskStartOffer => {
    const slot = options.slot
    const offered = slot === undefined ? presets.items() : presets.items().filter((preset) => preset.configurations[slot])
    const continued =
      slot === undefined || options.continueWith === undefined
        ? undefined
        : offered.find((preset) => preset.id === options.continueWith)
    return {
      presets: offered,
      defaultPresetId: defaultPresetId(offered),
      slot,
      startLabel: options.startLabel,
      blocker: store.state.startRefusals[task.id],
      busy: busyTaskId() === task.id,
      presetsFailure: listFailure(presets),
      morePresets: followRetry(presets),
      onStart: (choice) => void start(task, choice),
      onContinue: continued && slot ? () => void start(task, { presetId: continued.id, slot }, true) : undefined,
      onOpen: options.onOpen,
      onOpenPresetSettings: openPresetSettings,
    }
  }

  return { busyTaskId, busyWhile, offerFor, openLatestSession }
}
