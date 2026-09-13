import { Show, createSignal } from "solid-js"
import type { Preset } from "@claxedo/tasks"
import { PresetEditor, parsePresetEditorDraft, type PresetEditorDraft } from "@claxedo/tasks/solid"
import { uuid } from "@/lib/uuid"
import { useTasksAppPorts } from "../app-ports"
import { refusalOf } from "../data/tasks-api"
import { useTasksCapabilities, useTasksClient, useTasksInvalidation, type TasksScope } from "../data/queries"
import type { TasksStore } from "../store/tasks-store"

export type PresetDraftEditorProps = {
  store: TasksStore
  scope: () => TasksScope
  /** Handed the saved record, so an inline create can name it to the flow that asked for it. */
  onSaved?: (preset: Preset) => void
  onClose: () => void
}

/**
 * The open preset draft and the command that saves it.
 *
 * One owner for both the Presets page and the Start dialog's inline create:
 * the draft lives in the store either way, and the only difference between
 * them is where closing goes, which is the caller's to say.
 */
export function PresetDraftEditor(props: PresetDraftEditorProps) {
  const ports = useTasksAppPorts()
  const catalog = ports.useCapabilityCatalog()
  const capabilities = useTasksCapabilities(props.scope)
  const client = useTasksClient()
  const invalidate = useTasksInvalidation(props.scope)
  const [busy, setBusy] = createSignal(false)

  const save = async (draft: PresetEditorDraft) => {
    const parsed = parsePresetEditorDraft(draft)
    if (!parsed.ok) return
    const presetId = props.store.state.presetDraftId
    const revision = props.store.state.presetRevision
    setBusy(true)
    try {
      const response = await client().command({
        clientRequestId: uuid(),
        command:
          presetId !== undefined && revision !== undefined
            ? { type: "preset.edit", input: { ...parsed.draft, presetId, revision } }
            : { type: "preset.create", input: parsed.draft },
      })
      await invalidate.everything()
      props.store.closePresetDraft()
      if (response.result.type === "preset.create" || response.result.type === "preset.edit") {
        props.onSaved?.(response.result.preset)
      }
      props.onClose()
    } catch (error) {
      props.store.refusePreset(refusalOf(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Show when={props.store.state.presetDraft}>
      {(draft) => (
        <PresetEditor
          editorKey={props.store.state.presetDraftId ?? "new"}
          draft={draft()}
          onDraftChange={(next) => props.store.setPresetDraft(next)}
          placements={capabilities.data?.placements ?? ["local"]}
          catalog={catalog}
          configurationEditor={ports.ConfigurationEditor}
          proseEditor={ports.ProseEditor}
          busy={busy()}
          error={props.store.state.presetRefusal?.message}
          fieldErrors={props.store.state.presetRefusal?.fields}
          submitLabel={props.store.state.presetDraftId ? "Save preset" : "Create preset"}
          onSubmit={(next) => void save(next)}
          onCancel={() => {
            props.store.closePresetDraft()
            props.onClose()
          }}
        />
      )}
    </Show>
  )
}
