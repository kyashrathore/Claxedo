import { Show, createSignal } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { presetEditorDraftOf, emptyPresetEditorDraft } from "../../preset-editor-model"
import { PresetList } from "./preset-list"
import { uuid } from "@/lib/uuid"
import { refusalOf } from "../../data/tasks-api"
import { followRetry, listFailure, useTasksClient, useTasksInvalidation, usePresetList, type TasksScope } from "../../data/queries"
import type { TasksStore } from "../../store/tasks-store"
import { PresetDraftEditor } from "./preset-draft-editor"
import { Switch } from "@opencode-ai/ui/switch"
import { SettingsSectionHeading } from "@/ui/controls/settings-list"

export type PresetsViewProps = {
  store: TasksStore
  scope: () => TasksScope
}

/** The personal preset catalog, and the editor for whichever preset is open. */
export function PresetsView(props: PresetsViewProps) {
  const [includeArchived, showArchived] = createSignal(false)
  const presets = usePresetList(props.scope, includeArchived)
  const client = useTasksClient()
  const invalidate = useTasksInvalidation(props.scope)
  const [busy, setBusy] = createSignal(false)

  const editPreset = (presetId: string) => {
    const preset = presets.items().find((entry) => entry.id === presetId)
    if (!preset) return
    props.store.selectPreset(presetId)
    props.store.openPresetDraft(presetEditorDraftOf(preset), preset)
  }

  const createPreset = () => {
    props.store.selectPreset(undefined)
    props.store.openPresetDraft(emptyPresetEditorDraft())
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

  const editing = () => props.store.state.presetDraft !== undefined
  // The empty state carries its own New preset, and two of the same primary
  // action on one screen is a choice the reader has to make for no reason.
  const emptyStateOffersCreate = () => presets.items().length === 0 && listFailure(presets) === undefined

  return (
    <div class="flex flex-col pb-10" data-testid="presets-view">
      <SettingsSectionHeading
        title="Presets"
        description="Presets are yours. They describe how and where an agent works, and are reusable across your projects."
        action={
          <Show when={!editing()}>
            <Switch
              data-testid="preset-list-include-archived"
              checked={includeArchived()}
              onChange={(value: boolean) => showArchived(value)}
            >
              Show archived
            </Switch>
            <Show when={!emptyStateOffersCreate()}>
              <Button variant="primary" size="small" data-testid="preset-list-create" onClick={createPreset}>
                New preset
              </Button>
            </Show>
          </Show>
        }
      />

      <Show
        when={editing()}
        fallback={
          <PresetList
            presets={presets.items()}
            loading={presets.pending()}
            busyPresetId={busy() ? props.store.state.selectedPresetId : undefined}
            selectedPresetId={props.store.state.selectedPresetId}
            error={props.store.state.presetRefusal?.message}
            failure={listFailure(presets)}
            more={followRetry(presets)}
            onSelect={editPreset}
            onCreate={createPreset}
            onArchive={(input) => void archiveOrRestore("preset.archive", input)}
            onRestore={(input) => void archiveOrRestore("preset.restore", input)}
          />
        }
      >
        <div class="tsk tsk-root tsk-page">
          <PresetDraftEditor store={props.store} scope={props.scope} />
        </div>
      </Show>
    </div>
  )
}
