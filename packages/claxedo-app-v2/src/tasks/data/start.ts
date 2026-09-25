import { createSignal } from "solid-js"
import type { ConfigurationSlot, Preset, SessionReference, StartPreview, Task, TaskSummary } from "@claxedo/tasks"
import { useTranslator, type DomainTranslate } from "@/i18n"
import { uuid } from "@/lib/uuid"
import { tasksDictionary, type TasksKey } from "../i18n"
import { useOpenPresetSettings, useOpenTaskSession } from "../links"
import { SLOT_KEYS, groupLinksBySlot, openableSlot, slotAttempt } from "../model"
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

type StartRequest = {
  readonly taskId: string
  readonly taskRevision: number
  readonly presetId: string
  readonly presetRevision: number
  readonly slot: ConfigurationSlot
  readonly attempt: number
  readonly continueFromPrevious: boolean
}

export type StartOutcome = { readonly ok: true } | { readonly ok: false; readonly message: string }

export type StartChoice = { readonly presetId: string; readonly slot: ConfigurationSlot }

export type TaskStartOffer = {
  readonly presets: readonly Preset[]
  readonly defaultPresetId: string | undefined
  readonly slot?: ConfigurationSlot
  readonly startLabel?: string
  readonly blocker?: string
  readonly busy?: boolean
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
  const preview = async (request: StartRequest): Promise<StartPreview> => {
    const { taskId, ...body } = request
    return (await api.client.startPreview(taskId, body)).preview
  }
  const send = async (request: StartRequest, previewDigest: string): Promise<SessionReference> => {
    const { taskId, ...body } = request
    const response = await api.client.start(taskId, {
      ...body,
      clientRequestId: uuid(),
      previewDigest,
      handoffText: null,
    })
    await invalidate.afterCommand(taskId)
    openSession(response.link.sessionRef)
    return response.link.sessionRef
  }
  return { api, preview, send, openSession }
}

type StartChoiceInput = {
  readonly presetId: string
  readonly presetRevision: number
  readonly slot: ConfigurationSlot
  readonly continueFromPrevious?: boolean
}

type StartCalls = ReturnType<typeof createStartCalls>
type Translate = DomainTranslate<TasksKey>

async function startRequest(
  calls: StartCalls,
  task: Task | TaskSummary,
  choice: StartChoiceInput,
): Promise<StartRequest> {
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

async function startNow(
  calls: StartCalls,
  t: Translate,
  task: Task | TaskSummary,
  choice: StartChoiceInput,
): Promise<StartOutcome> {
  try {
    const request = await startRequest(calls, task, choice)
    const resolved = await calls.preview(request)
    if (!resolved.available) return { ok: false, message: resolved.blockers[0]?.detail ?? t("tasks.start.cannotRun") }
    if (request.continueFromPrevious && !resolved.previousTranscriptReadable)
      return { ok: false, message: t("tasks.start.unreadablePrevious") }
    await calls.send({ ...request, attempt: resolved.attempt }, resolved.digest)
    return { ok: true }
  } catch (error) {
    return { ok: false, message: refusalOf(error).message }
  }
}

async function openLatest(calls: StartCalls, t: Translate, taskId: string): Promise<StartOutcome> {
  try {
    const chosen = openableSlot(groupLinksBySlot((await calls.api.client.getTask(taskId))?.links ?? []))
    if (!chosen) return { ok: false, message: t("tasks.start.noSession") }
    if (!chosen.open) {
      const slot = t(SLOT_KEYS[chosen.slot]).toLowerCase()
      return { ok: false, message: t("tasks.start.sessionGone", { slot, liveness: chosen.current.liveness }) }
    }
    calls.openSession(chosen.open.sessionRef)
    return { ok: true }
  } catch (error) {
    return { ok: false, message: refusalOf(error).message }
  }
}

function useStartCommands() {
  const t = useTranslator(tasksDictionary)
  const calls = createStartCalls()
  return {
    startNow: (task: Task | TaskSummary, choice: StartChoiceInput) => startNow(calls, t, task, choice),
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
      const input = { presetId: preset.id, presetRevision: preset.revision, slot: choice.slot, continueFromPrevious }
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
    presetsFailure: listFailure(presets),
    morePresets: followRetry(presets),
    onStart: (choice) => void input.start(task, choice),
    onContinue: continued && slot ? () => void input.start(task, { presetId: continued.id, slot }, true) : undefined,
    onOpen: options.onOpen,
    onOpenPresetSettings: input.openPresetSettings,
  }
}
