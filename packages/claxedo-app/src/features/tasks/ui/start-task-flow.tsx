import { createEffect, createMemo, createResource, createSignal } from "solid-js"
import type { ConfigurationSlot, StartPreview, Task } from "@claxedo/tasks"
import { StartTaskDialog, emptyPresetEditorDraft, type StartDraft, type StartPreviewState } from "@claxedo/tasks/solid"
import { uuid } from "@/lib/uuid"
import { useTasksAppPorts } from "../app-ports"
import { refusalOf } from "../data/tasks-api"
import { followRetry, listFailure, useTasksClient, useTasksInvalidation, usePresetList, type TasksScope } from "../data/queries"
import type { TasksStore } from "../store/tasks-store"
import { PresetDraftEditor } from "./preset-draft-editor"

export type StartTaskFlowProps = {
  store: TasksStore
  scope: () => TasksScope
  task: Task
  slot: ConfigurationSlot
  attempt: number
  onClose: () => void
}

/**
 * The Start dialog's data half: preview, inline preset creation and the start
 * call itself. The draft lives here, so a failed preview or a refused start
 * re-renders the same choices instead of dropping the user back to an empty
 * dialog.
 */
export function StartTaskFlow(props: StartTaskFlowProps) {
  const openSession = useTasksAppPorts().useOpenSession()
  const client = useTasksClient()
  const invalidate = useTasksInvalidation(props.scope)
  const presets = usePresetList(props.scope, () => false)
  const [draft, setDraft] = createSignal<StartDraft>({
    presetId: null,
    slot: props.slot,
    handoffText: "",
    continueFromPrevious: false,
  })
  const [busy, setBusy] = createSignal(false)
  const [startError, setStartError] = createSignal<string | undefined>()
  /**
   * A successful Start advances the task's revision, so the revision this
   * dialog opened with goes stale as soon as another client links a session —
   * or as soon as a lost response is re-sent. The host answers such a request
   * with the record to rebase onto; this holds it so the preview and the retry
   * claim the revision the host actually has.
   */
  const [rebased, setRebased] = createSignal<Task | undefined>()
  const task = () => rebased() ?? props.task

  const selectedPreset = createMemo(() => presets.items().find((preset) => preset.id === draft().presetId))

  const previewInput = createMemo(() => {
    const preset = selectedPreset()
    if (!preset) return undefined
    return {
      taskId: task().id,
      taskRevision: task().revision,
      presetId: preset.id,
      presetRevision: preset.revision,
      slot: draft().slot,
      attempt: props.attempt,
      continueFromPrevious: draft().continueFromPrevious,
    }
  })

  const [preview] = createResource(previewInput, async (input) => {
    const response = await client().startPreview(input.taskId, {
      taskRevision: input.taskRevision,
      presetId: input.presetId,
      presetRevision: input.presetRevision,
      slot: input.slot,
      attempt: input.attempt,
      continueFromPrevious: input.continueFromPrevious,
    })
    return response.preview
  })

  /** Returns the rebased record, or nothing when the refusal is not one. */
  const rebaseFrom = (error: unknown): Task | undefined => {
    const current = refusalOf(error).stale?.task
    if (!current || current.revision === task().revision) return undefined
    setRebased(current)
    return current
  }

  createEffect(() => {
    const failure = preview.error
    if (failure) rebaseFrom(failure)
  })

  const previewState = (): StartPreviewState => {
    if (!previewInput()) return { status: "idle" }
    const failure = preview.error
    if (failure) return { status: "error", message: refusalOf(failure).message }
    const resolved: StartPreview | undefined = preview.latest
    if (!resolved) return { status: "loading" }
    return { status: "ready", preview: resolved, refreshing: preview.loading }
  }

  type StartChoice = { presetId: string; presetRevision: number; slot: ConfigurationSlot; attempt: number }

  const send = async (current: Task, choice: StartChoice, previewDigest: string) => {
    const response = await client().start(current.id, {
      clientRequestId: uuid(),
      taskRevision: current.revision,
      presetId: choice.presetId,
      presetRevision: choice.presetRevision,
      slot: choice.slot,
      attempt: choice.attempt,
      previewDigest,
      handoffText: draft().handoffText.trim().length > 0 ? draft().handoffText : null,
      continueFromPrevious: draft().continueFromPrevious,
    })
    invalidate.task(current.id)
    await invalidate.everything()
    openSession(response.link.sessionRef)
    props.onClose()
  }

  const start = async () => {
    const input = previewInput()
    const resolved = preview.latest
    // `latest` outlives its input while a re-preview is in flight, and the
    // digest the host accepts belongs to the input that produced it.
    if (!input || !resolved || preview.loading) return
    setBusy(true)
    setStartError(undefined)
    try {
      await send(task(), input, resolved.digest)
    } catch (error) {
      const current = rebaseFrom(error)
      if (!current) {
        setStartError(refusalOf(error).message)
        return
      }
      try {
        // The digest binds a preview to the revision it resolved against, so
        // the rebased attempt needs its own preview before it can be sent.
        const rebasedPreview = await client().startPreview(current.id, {
          taskRevision: current.revision,
          presetId: input.presetId,
          presetRevision: input.presetRevision,
          slot: input.slot,
          attempt: input.attempt,
          continueFromPrevious: draft().continueFromPrevious,
        })
        await send(current, input, rebasedPreview.preview.digest)
      } catch (retried) {
        setStartError(refusalOf(retried).message)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <StartTaskDialog
      taskTitle={task().title}
      attempt={props.attempt}
      presets={presets.items()}
      draft={draft()}
      preview={previewState()}
      busy={busy()}
      error={startError()}
      morePresets={followRetry(presets)}
      presetsFailure={listFailure(presets)}
      inlinePresetEditor={
        props.store.state.presetDraft ? (
          <PresetDraftEditor
            store={props.store}
            scope={props.scope}
            onSaved={(preset) => setDraft({ ...draft(), presetId: preset.id })}
            onClose={() => props.store.closePresetDraft()}
          />
        ) : undefined
      }
      onDraftChange={setDraft}
      onCreatePreset={() => props.store.openPresetDraft(emptyPresetEditorDraft())}
      onStart={() => void start()}
      onCancel={() => props.onClose()}
    />
  )
}
