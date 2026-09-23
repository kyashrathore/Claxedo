import { Show, createSignal } from "solid-js"
import { parsePresetEditorDraft, type PresetEditorDraft } from "../../preset-editor-model"
import { PresetEditor } from "./preset-editor"
import { uuid } from "@/lib/uuid"
import { useTasksAppPorts } from "../../app-ports"
import { refusalOf } from "../../data/tasks-api"
import { useTasksCapabilities, useTasksClient, useTasksInvalidation, type TasksScope } from "../../data/queries"
import type { TasksStore } from "../../store/tasks-store"

export type PresetDraftEditorProps = {
  store: TasksStore
  scope: () => TasksScope
}

/**
 * The open preset draft and the command that saves it.
 *
 * Saving and cancelling both close the draft in the store, which is what takes
 * the catalog back to its list — the editor never navigates.
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
      await client().command({
        clientRequestId: uuid(),
        command:
          presetId !== undefined && revision !== undefined
            ? { type: "preset.edit", input: { ...parsed.draft, presetId, revision } }
            : { type: "preset.create", input: parsed.draft },
      })
      await invalidate.everything()
      props.store.closePresetDraft()
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
          onCancel={() => props.store.closePresetDraft()}
        />
      )}
    </Show>
  )
}
