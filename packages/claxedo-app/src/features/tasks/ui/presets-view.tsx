import { Show, createEffect, createSignal, on } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { PresetList, presetEditorDraftOf, emptyPresetEditorDraft } from "@claxedo/tasks/solid"
import { uuid } from "@/lib/uuid"
import { refusalOf } from "../data/tasks-api"
import { followRetry, listFailure, useTasksClient, useTasksInvalidation, usePresetList, type TasksScope } from "../data/queries"
import type { TasksStore } from "../store/tasks-store"
import { PresetDraftEditor } from "./preset-draft-editor"
import { TasksHeader } from "./tasks-header"

export type PresetsViewProps = {
  store: TasksStore
  scope: () => TasksScope
  /** The preset the URL names; the editor page opens on it. */
  presetId: () => string | undefined
  onOpenPreset: (presetId: string | undefined) => void
  onOpenTasks: () => void
}

/** `/tasks/presets` and `/tasks/presets/<presetId>`: the personal preset catalog. */
export function PresetsView(props: PresetsViewProps) {
  const [includeArchived, showArchived] = createSignal(false)
  const presets = usePresetList(props.scope, includeArchived)
  const client = useTasksClient()
  const invalidate = useTasksInvalidation(props.scope)
  const [busy, setBusy] = createSignal(false)

  // The URL names the preset; the draft follows it. A preset the catalog has
  // not read yet leaves the page on the list rather than on an empty form.
  createEffect(
    on([props.presetId, () => presets.items()], ([presetId, items]) => {
      props.store.selectPreset(presetId)
      if (!presetId) {
        if (props.store.state.presetDraftId) props.store.closePresetDraft()
        return
      }
      if (props.store.state.presetDraftId === presetId) return
      const preset = items.find((entry) => entry.id === presetId)
      if (preset) props.store.openPresetDraft(presetEditorDraftOf(preset), preset)
    }),
  )

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

  const editing = () => props.store.state.presetDraft !== undefined

  return (
    <div class="tsk tsk-root" data-testid="presets-view">
      <TasksHeader
        active="presets"
        count={presets.items().length}
        onOpenTasks={() => props.onOpenTasks()}
        onOpenPresets={() => props.onOpenPreset(undefined)}
        action={
          <Show when={!editing()}>
            <Button
              variant="primary"
              size="small"
              data-testid="preset-list-create"
              onClick={() => props.store.openPresetDraft(emptyPresetEditorDraft())}
            >
              New preset
            </Button>
          </Show>
        }
      />

      <Show
        when={editing()}
        fallback={
          <PresetList
            presets={presets.items()}
            loading={presets.pending()}
            includeArchived={includeArchived()}
            onIncludeArchivedChange={showArchived}
            busyPresetId={busy() ? props.store.state.selectedPresetId : undefined}
            selectedPresetId={props.store.state.selectedPresetId}
            error={props.store.state.presetRefusal?.message}
            failure={listFailure(presets)}
            more={followRetry(presets)}
            onSelect={(presetId) => props.onOpenPreset(presetId)}
            onCreate={() => props.store.openPresetDraft(emptyPresetEditorDraft())}
            onArchive={(input) => void archiveOrRestore("preset.archive", input)}
            onRestore={(input) => void archiveOrRestore("preset.restore", input)}
          />
        }
      >
        <div class="tsk-page">
          <PresetDraftEditor
            store={props.store}
            scope={props.scope}
            onClose={() => props.onOpenPreset(undefined)}
          />
        </div>
      </Show>
    </div>
  )
}
