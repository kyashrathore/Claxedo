import { createSignal, type Accessor } from "solid-js"
import { machine } from "@/lib/machine"
import type { ConfigurationSlot, Preset, StartPreview, Task, TaskSummary } from "@claxedo/tasks"
import { useWakeProgress } from "@/cloud"
import { useErrorCopy, useTranslator, type DomainTranslate } from "@/i18n"
import { useServer, type WorkspaceRuntime } from "@/server"
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
import { START_IDLE, startNow, startProgressLine, startProgressTransition, type StartCalls, type StartChoiceInput, type StartOutcome, type TaskStartProgress, type TaskStartRequest } from "./start-run"

export type StartChoice = { readonly presetId: string; readonly slot: ConfigurationSlot }

export type TaskStartOffer = {
  readonly presets: readonly Preset[]
  readonly defaultPresetId: string | undefined
  readonly slot?: ConfigurationSlot
  readonly startLabel?: string
  readonly blocker?: string
  readonly busy?: boolean
  readonly progress?: string
  readonly presetsFailure?: ListFailure
  readonly morePresets?: MorePages
  readonly onStart: (choice: StartChoice) => void
  readonly onContinue?: () => void
  readonly onOpen?: () => void
  readonly onOpenPresetSettings: () => void
}

function createStartCalls(t: DomainTranslate<TasksKey>) {
  const api = useTasksApi()
  const invalidate = useTasksInvalidation()
  const openSession = useOpenTaskSession()
  const preview = async (request: TaskStartRequest): Promise<StartPreview> => {
    const { taskId, ...body } = request
    return (await api.client.startPreview(taskId, body)).preview
  }
  const calls: StartCalls & { readonly openSession: typeof openSession } = {
    api,
    preview,
    start: async ({ taskId, ...body }, previewDigest, clientRequestId) =>
      api.client.start(taskId, { ...body, clientRequestId, previewDigest, handoffText: null }),
    followRoot: async (workspaceId, following) => {
      const run = await api.followRoot(workspaceId, following)
      return run.kind === "running" ? run : { kind: "failed", message: run.error?.message ?? t("tasks.start.rootDidNotStart") }
    },
    open: async (taskId, session) => {
      const refreshed = invalidate.afterCommand(taskId)
      await openSession(session)
      await refreshed
    },
    openSession,
  }
  return calls
}

const NO_MACHINE: WorkspaceRuntime = { kind: "live" }

function useStartProgressText(progress: Accessor<TaskStartProgress>, t: DomainTranslate<TasksKey>) {
  const cloud = useServer().cloud
  const machineStep = useWakeProgress(() => {
    const current = progress()
    return current.kind === "machine" ? cloud.runtime(current.placementId) : NO_MACHINE
  })
  return (taskId: string, slot: ConfigurationSlot | undefined): string | undefined => {
    const line = startProgressLine(progress(), taskId, slot)
    if (!line) return undefined
    if (line.kind === "key") return t(line.key)
    const step = machineStep()
    return step ? t("tasks.start.progress.machine", { step }) : t("tasks.start.progress.cloud")
  }
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
  const errorCopy = useErrorCopy("tasks")
  const calls = createStartCalls(t)
  const progress = machine(START_IDLE, startProgressTransition)
  return {
    progress: useStartProgressText(progress.state, t),
    startNow: async (task: Task | TaskSummary, choice: StartChoiceInput) => {
      const outcome = await startNow(calls, { t, errorMessage: (error) => errorCopy(error).message }, task, choice, progress.send)
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
      progress: commands.progress(task.id, options.slot),
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
  readonly progress: string | undefined
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
