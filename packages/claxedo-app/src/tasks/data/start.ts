import { createSignal } from "solid-js"
import { machine } from "@/lib/machine"
import type { ConfigurationSlot, Preset, SessionRef, StartPreview, Task, TaskSummary } from "@claxedo/tasks"
import { useTranslator, type DomainTranslate } from "@/i18n"
import { uuid } from "@/lib/uuid"
import { showToast } from "@/ui"
import { tasksDictionary, type TasksKey } from "../i18n"
import { useOpenPresetSettings, useOpenTaskSession } from "../links"
import { SLOT_KEYS, groupLinksBySlot, openableSlot } from "../model"
import type { TasksStore } from "../store"
import {
  followRetry,
  listFailure,
  usePresetList,
  useTasksApi,
  useTasksInvalidation,
  type ListFailure,
  type MorePages,
} from "./queries"
import { refusalOf } from "./refusal"
import { START_IDLE, startNow, startProgressKey, startProgressTransition, type StartChoiceInput, type StartOutcome, type TaskStartRequest } from "./start-run"

export type StartChoice = { readonly presetId: string; readonly slot: ConfigurationSlot }

export type TaskStartOffer = {
  readonly presets: readonly Preset[]
  readonly defaultPresetId: string | undefined
  readonly slot?: ConfigurationSlot
  readonly startLabel?: string
  readonly blocker?: string
  readonly busy?: boolean
  readonly progress?: TasksKey
  readonly presetsFailure?: ListFailure
  readonly morePresets?: MorePages
  readonly onStart: (choice: StartChoice) => void
  readonly onContinue?: () => void
  readonly onOpen?: () => void
  readonly onOpenPresetSettings: () => void
}

function createStartCalls() {
  const api = useTasksApi()
  const invalidate = useTasksInvalidation()
  const openSession = useOpenTaskSession()
  const preview = async (request: TaskStartRequest): Promise<StartPreview> => {
    const { taskId, ...body } = request
    return (await api.client.startPreview(taskId, body)).preview
  }
  const send = async (request: TaskStartRequest, previewDigest: string): Promise<SessionRef> => {
    const { taskId, ...body } = request
    const response = await api.client.start(taskId, {
      ...body,
      clientRequestId: uuid(),
      previewDigest,
      handoffText: null,
    })
    await invalidate.afterCommand(taskId)
    await openSession(response.link.sessionRef)
    return response.link.sessionRef
  }
  return { api, preview, send, openSession }
}

async function openLatest(calls: ReturnType<typeof createStartCalls>, t: DomainTranslate<TasksKey>, taskId: string): Promise<StartOutcome> {
  try {
    const chosen = openableSlot(groupLinksBySlot((await calls.api.client.getTask(taskId))?.links ?? []))
    if (!chosen) return { ok: false, message: t("tasks.start.noSession") }
    if (!chosen.open) {
      const slot = t(SLOT_KEYS[chosen.slot]).toLowerCase()
      return { ok: false, message: t("tasks.start.sessionGone", { slot, liveness: chosen.current.liveness }) }
    }
    await calls.openSession(chosen.open.sessionRef)
    return { ok: true }
  } catch (error) {
    return { ok: false, message: refusalOf(error).message }
  }
}

function useStartCommands() {
  const t = useTranslator(tasksDictionary)
  const calls = createStartCalls()
  const progress = machine(START_IDLE, startProgressTransition)
  return {
    progress: progress.state,
    startNow: async (task: Task | TaskSummary, choice: StartChoiceInput) => {
      const outcome = await startNow(calls, t, task, choice, progress.send)
      if (!outcome.ok) showToast({ variant: "error", title: t("tasks.start.failed", { title: task.title }), description: outcome.message })
      return outcome
    },
    openLatestSession: (taskId: string) => openLatest(calls, t, taskId),
  }
}

export type StartOfferOptions = {
  readonly slot?: ConfigurationSlot
  readonly startLabel?: string
  readonly continueWith?: string
  readonly onOpen?: () => void
}

function createBusy() {
  const [busyTaskId, setBusyTaskId] = createSignal<string | undefined>()
  const busyWhile = async <T>(taskId: string, run: () => Promise<T>): Promise<T> => {
    setBusyTaskId(taskId)
    try {
      return await run()
    } finally {
      setBusyTaskId(undefined)
    }
  }
  return { busyTaskId, busyWhile }
}

export function useTaskStartOffers(store: TasksStore) {
  const commands = useStartCommands()
  const presets = usePresetList(() => false)
  const openPresetSettings = useOpenPresetSettings()
  const { busyTaskId, busyWhile } = createBusy()
  const defaultPresetId = (offered: readonly Preset[]) => {
    const last = store.state.lastPresetId
    if (last !== undefined && offered.some((preset) => preset.id === last)) return last
    return offered[0]?.id
  }
  const start = (task: Task | TaskSummary, choice: StartChoice, continueFromPrevious = false) =>
    busyWhile(task.id, async () => {
      const preset = presets.items().find((entry) => entry.id === choice.presetId)
      if (!preset) return
      const input = { presetId: preset.id, presetRevision: preset.revision, placement: preset.execution.placement, slot: choice.slot, continueFromPrevious }
      const outcome = await commands.startNow(task, input)
      if (outcome.ok) store.startedWith(task.id, preset.id)
      else store.refuseStart(task.id, outcome.message)
    })
  const openLatestSession = (taskId: string) =>
    busyWhile(taskId, async () => {
      const outcome = await commands.openLatestSession(taskId)
      if (!outcome.ok) store.refuseStart(taskId, outcome.message)
    })
  const offerFor = (task: Task | TaskSummary, options: StartOfferOptions = {}) =>
    buildOffer({
      task,
      options,
      presets,
      store,
      busy: busyTaskId() === task.id,
      progress: startProgressKey(commands.progress(), task.id, options.slot),
      defaultPresetId,
      start,
      openPresetSettings,
    })
  return { busyTaskId, busyWhile, offerFor, openLatestSession }
}

function buildOffer(input: {
  readonly task: Task | TaskSummary
  readonly options: StartOfferOptions
  readonly presets: ReturnType<typeof usePresetList>
  readonly store: TasksStore
  readonly busy: boolean
  readonly progress: TasksKey | undefined
  readonly defaultPresetId: (offered: readonly Preset[]) => string | undefined
  readonly start: (task: Task | TaskSummary, choice: StartChoice, continueFromPrevious?: boolean) => Promise<void>
  readonly openPresetSettings: () => void
}): TaskStartOffer {
  const { task, options, presets } = input
  const slot = options.slot
  const offered = slot === undefined ? presets.items() : presets.items().filter((preset) => preset.configurations[slot])
  const continued =
    slot && options.continueWith ? offered.find((preset) => preset.id === options.continueWith) : undefined
  return {
    presets: offered,
    defaultPresetId: input.defaultPresetId(offered),
    slot,
    startLabel: options.startLabel,
    blocker: input.store.state.startRefusals[task.id],
    busy: input.busy,
    ...(input.progress ? { progress: input.progress } : {}),
    presetsFailure: listFailure(presets),
    morePresets: followRetry(presets),
    onStart: (choice) => void input.start(task, choice),
    onContinue: continued && slot ? () => void input.start(task, { presetId: continued.id, slot }, true) : undefined,
    onOpen: options.onOpen,
    onOpenPresetSettings: input.openPresetSettings,
  }
}
