import { createMemo, createResource, createSignal } from "solid-js"
import type { ConfigurationSlot, StartPreview, Task } from "@claxedo/tasks"
import { StartTaskDialog, emptyPresetEditorDraft, type StartDraft, type StartPreviewState } from "@claxedo/tasks/solid"
import { uuid } from "@/lib/uuid"
import { useTasksAppPorts } from "../app-ports"
import { refusalOf } from "../data/tasks-api"
import { useTasksClient, useTasksInvalidation, usePresetList, type TasksScope } from "../data/queries"
import type { TasksStore } from "../store/tasks-store"
import { PresetsView } from "./presets-view"

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

  const selectedPreset = createMemo(() => presets.items().find((preset) => preset.id === draft().presetId))

  const previewInput = createMemo(() => {
    const preset = selectedPreset()
    if (!preset) return undefined
    return {
      taskId: props.task.id,
      taskRevision: props.task.revision,
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

  const previewState = (): StartPreviewState => {
    if (!previewInput()) return { status: "idle" }
    const failure = preview.error
    if (failure) return { status: "error", message: refusalOf(failure).message }
    const resolved: StartPreview | undefined = preview.latest
    if (!resolved) return { status: "loading" }
    return { status: "ready", preview: resolved, refreshing: preview.loading }
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
      const response = await client().start(props.task.id, {
        clientRequestId: uuid(),
        taskRevision: input.taskRevision,
        presetId: input.presetId,
        presetRevision: input.presetRevision,
        slot: input.slot,
        attempt: input.attempt,
        previewDigest: resolved.digest,
        handoffText: draft().handoffText.trim().length > 0 ? draft().handoffText : null,
        continueFromPrevious: draft().continueFromPrevious,
      })
      invalidate.task(props.task.id)
      await invalidate.everything()
      openSession(response.link.sessionRef)
      props.onClose()
    } catch (error) {
      setStartError(refusalOf(error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <StartTaskDialog
      taskTitle={props.task.title}
      attempt={props.attempt}
      presets={presets.items()}
      draft={draft()}
      preview={previewState()}
      busy={busy()}
      error={startError()}
      inlinePresetEditor={
        props.store.state.presetDraft ? (
          <PresetsView
            store={props.store}
            scope={props.scope}
            onSaved={(preset) => setDraft({ ...draft(), presetId: preset.id })}
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
