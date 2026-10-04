import { Show, createSignal, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { uuid } from "@/lib/uuid"
import { SettingsIntro } from "@/settings"
import { Button, Switch } from "@/ui"
import {
  followRetry,
  listFailure,
  usePresetList,
  useTasksApi,
  useTasksCapabilities,
  useTasksInvalidation,
} from "../data/queries"
import { refusalOf } from "../data/refusal"
import { tasksDictionary } from "../i18n"
import "../view/tasks.css"
import { useCapabilityCatalog } from "./capabilities"
import { emptyPresetEditorDraft, parsePresetEditorDraft, presetEditorDraftOf, type PresetEditorDraft } from "./draft"
import { PresetEditor } from "./preset-editor"
import { PresetList } from "./preset-list"
import { createPresetsStore, type PresetsStore } from "./store"

function createPresetCommands(store: PresetsStore) {
  const api = useTasksApi()
  const invalidate = useTasksInvalidation()
  const [busy, setBusy] = createSignal(false)
  const run = async (work: () => Promise<unknown>, after?: () => void) => {
    setBusy(true)
    try {
      await work()
      await invalidate.everything()
      after?.()
    } catch (error) {
      store.refuse(refusalOf(error))
    } finally {
      setBusy(false)
    }
  }
  const save = (draft: PresetEditorDraft) => {
    const parsed = parsePresetEditorDraft(draft)
    if (!parsed.ok) return
    const { draftId, revision } = store.state
    const command =
      draftId !== undefined && revision !== undefined
        ? ({ type: "preset.edit", input: { ...parsed.draft, presetId: draftId, revision } } as const)
        : ({ type: "preset.create", input: parsed.draft } as const)
    void run(() => api.client.command({ clientRequestId: uuid(), command }), store.close)
  }
  const archive = (type: "preset.archive" | "preset.restore", input: { presetId: string; revision: number }) =>
    void run(() => api.client.command({ clientRequestId: uuid(), command: { type, input } }))
  return { busy, save, archive }
}

function DraftEditor(props: {
  readonly store: PresetsStore
  readonly commands: ReturnType<typeof createPresetCommands>
}) {
  const t = useTranslator(tasksDictionary)
  const capabilities = useTasksCapabilities()
  const catalog = useCapabilityCatalog()
  return (
    <Show when={props.store.state.draft}>
      {(draft) => (
        <div class="tsk tsk-root tsk-page">
          <PresetEditor
            draft={draft()}
            onDraftChange={props.store.setDraft}
            placements={capabilities.data?.placements ?? ["local"]}
            catalog={catalog}
            busy={props.commands.busy()}
            error={props.store.state.refusal?.message}
            fieldErrors={props.store.state.refusal?.fields}
            submitLabel={props.store.state.draftId ? t("tasks.preset.save") : t("tasks.preset.create")}
            onSubmit={props.commands.save}
            onCancel={props.store.close}
          />
        </div>
      )}
    </Show>
  )
}

export function PresetsSection(): JSX.Element {
  const t = useTranslator(tasksDictionary)
  const store = createPresetsStore()
  const [includeArchived, setIncludeArchived] = createSignal(false)
  const presets = usePresetList(includeArchived)
  const commands = createPresetCommands(store)
  const editing = () => store.state.draft !== undefined
  const edit = (presetId: string) => {
    const preset = presets.items().find((entry) => entry.id === presetId)
    if (preset) store.open(presetEditorDraftOf(preset), preset)
  }
  const create = () => store.open(emptyPresetEditorDraft())
  const listOffersCreate = () => presets.items().length > 0 || listFailure(presets) !== undefined
  return (
    <div class="settings-body" data-testid="presets-view">
      <SettingsIntro
        description={t("tasks.preset.description")}
        action={
          <Show when={!editing()}>
            <Switch
              data-testid="preset-list-include-archived"
              checked={includeArchived()}
              onChange={(value: boolean) => setIncludeArchived(value)}
            >
              {t("tasks.preset.showArchived")}
            </Switch>
            <Show when={listOffersCreate()}>
              <Button variant="contrast" size="small" data-testid="preset-list-create" onClick={create}>
                {t("tasks.preset.new")}
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
            busyPresetId={commands.busy() ? store.state.selectedPresetId : undefined}
            selectedPresetId={store.state.selectedPresetId}
            error={store.state.refusal?.message}
            failure={listFailure(presets)}
            more={followRetry(presets)}
            onSelect={edit}
            onCreate={create}
            onArchive={(input) => {
              store.select(input.presetId)
              commands.archive("preset.archive", input)
            }}
            onRestore={(input) => {
              store.select(input.presetId)
              commands.archive("preset.restore", input)
            }}
          />
        }
      >
        <DraftEditor store={store} commands={commands} />
      </Show>
    </div>
  )
}
