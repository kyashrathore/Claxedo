import { Show, createSignal } from "solid-js"
import type { Preset } from "@claxedo/tasks"
import {
  PresetEditor,
  PresetList,
  emptyPresetEditorDraft,
  parsePresetEditorDraft,
  presetEditorDraftOf,
  type PresetEditorDraft,
} from "@claxedo/tasks/solid"
import { uuid } from "@/lib/uuid"
import { useTasksAppPorts } from "../app-ports"
import { refusalOf } from "../data/tasks-api"
import { useTasksCapabilities, useTasksClient, useTasksInvalidation, usePresetList, type TasksScope } from "../data/queries"
import type { TasksStore } from "../store/tasks-store"

export type PresetsViewProps = {
  store: TasksStore
  scope: () => TasksScope
  /** Called with the saved preset so an inline create can hand it back to Start. */
  onSaved?: (preset: Preset) => void
}

export function PresetsView(props: PresetsViewProps) {
  const ports = useTasksAppPorts()
  const catalog = ports.useCapabilityCatalog()
  const capabilities = useTasksCapabilities(props.scope)
  const [includeArchived, showArchived] = createSignal(false)
  const presets = usePresetList(props.scope, includeArchived)
  const client = useTasksClient()
  const invalidate = useTasksInvalidation(props.scope)
  const [busy, setBusy] = createSignal(false)

  const placements = () => capabilities.data?.placements ?? ["local"]

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
    } catch (error) {
      props.store.refusePreset(refusalOf(error))
    } finally {
      setBusy(false)
    }
  }

  const archiveOrRestore = async (type: "preset.archive" | "preset.restore", input: { presetId: string; revision: number }) => {
    setBusy(true)
    try {
      await client().command({ clientRequestId: uuid(), command: { type, input } })
      await invalidate.everything()
    } catch (error) {
      props.store.refusePreset(refusalOf(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="tsk tsk-stack" data-testid="presets-view">
      <Show
        when={props.store.state.presetDraft}
        fallback={
          <PresetList
            presets={presets.data ?? []}
            loading={presets.isPending}
            includeArchived={includeArchived()}
            onIncludeArchivedChange={showArchived}
            selectedPresetId={props.store.state.selectedPresetId}
            error={presets.error ? refusalOf(presets.error).message : props.store.state.presetRefusal?.message}
            onSelect={(presetId) => {
              const preset = (presets.data ?? []).find((entry) => entry.id === presetId)
              props.store.selectPreset(presetId)
              if (preset) props.store.openPresetDraft(presetEditorDraftOf(preset), preset)
            }}
            onCreate={() => props.store.openPresetDraft(emptyPresetEditorDraft())}
            onArchive={(input) => void archiveOrRestore("preset.archive", input)}
            onRestore={(input) => void archiveOrRestore("preset.restore", input)}
          />
        }
      >
        {(draft) => (
          <PresetEditor
            editorKey={props.store.state.presetDraftId ?? "new"}
            draft={draft()}
            onDraftChange={(next) => props.store.setPresetDraft(next)}
            placements={placements()}
            catalog={catalog}
            configurationEditor={ports.ConfigurationEditor}
            busy={busy()}
            error={props.store.state.presetRefusal?.message}
            fieldErrors={props.store.state.presetRefusal?.fields}
            submitLabel={props.store.state.presetDraftId ? "Save preset" : "Create preset"}
            onSubmit={(next) => void save(next)}
            onCancel={() => props.store.closePresetDraft()}
          />
        )}
      </Show>
    </div>
  )
}
