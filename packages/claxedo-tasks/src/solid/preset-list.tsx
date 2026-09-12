import { For, Show } from "solid-js"
import { CONFIGURATION_SLOTS, type Preset } from "../contracts"
import { ListFailureNotice, type ListFailure } from "./list-failure"
import { LoadMore, type MorePages } from "./load-more"
import { PLACEMENT_LABELS, SLOT_LABELS } from "./view-model"

export type PresetListProps = {
  presets: readonly Preset[]
  selectedPresetId?: string
  loading?: boolean
  includeArchived: boolean
  onIncludeArchivedChange: (value: boolean) => void
  busyPresetId?: string
  /** A refused command, which the user retries by repeating the command rather than through a control here. */
  error?: string
  failure?: ListFailure
  more?: MorePages
  onSelect: (presetId: string) => void
  onCreate: () => void
  onArchive: (input: { presetId: string; revision: number }) => void
  onRestore: (input: { presetId: string; revision: number }) => void
}

export function PresetList(props: PresetListProps) {
  return (
    <div class="tsk tsk-stack" data-testid="preset-list">
      <div class="tsk-row tsk-spread">
        <h2 class="tsk-title">Presets</h2>
        <button type="button" class="tsk-button" data-variant="primary" data-testid="preset-list-create" onClick={() => props.onCreate()}>
          New preset
        </button>
      </div>
      <p class="tsk-muted">Presets are yours. They describe how and where an agent works, and are reusable across your projects.</p>
      <label class="tsk-checkbox">
        <input
          type="checkbox"
          data-testid="preset-list-include-archived"
          checked={props.includeArchived}
          onChange={(event) => props.onIncludeArchivedChange(event.currentTarget.checked)}
        />
        <span>Show archived presets</span>
      </label>
      <Show when={props.error}>{(message) => <p class="tsk-error" role="alert">{message()}</p>}</Show>
      <ListFailureNotice failure={props.failure} testId="preset-list-retry" />
      <div class="tsk-surface tsk-scroll" aria-busy={props.loading ? "true" : "false"}>
        <For
          each={props.presets}
          fallback={
            <Show when={props.failure === undefined}>
              <p class="tsk-empty">No presets yet.</p>
            </Show>
          }
        >
          {(preset) => (
            <div class="tsk-row">
              <button
                type="button"
                class="tsk-item"
                data-testid={`preset-list-row-${preset.id}`}
                aria-current={props.selectedPresetId === preset.id ? "true" : undefined}
                onClick={() => props.onSelect(preset.id)}
              >
                <span class="tsk-item-title">{preset.name}</span>
                <span class="tsk-status">{PLACEMENT_LABELS[preset.execution.placement]}</span>
                <span class="tsk-muted">{slotSummary(preset)}</span>
                <Show when={preset.archivedAt !== null}>
                  <span class="tsk-muted">Archived</span>
                </Show>
              </button>
              <Show
                when={preset.archivedAt === null}
                fallback={
                  <button
                    type="button"
                    class="tsk-button"
                    data-testid={`preset-list-restore-${preset.id}`}
                    disabled={props.busyPresetId === preset.id}
                    onClick={() => props.onRestore({ presetId: preset.id, revision: preset.revision })}
                  >
                    Restore
                  </button>
                }
              >
                <button
                  type="button"
                  class="tsk-button"
                  data-testid={`preset-list-archive-${preset.id}`}
                  disabled={props.busyPresetId === preset.id}
                  onClick={() => props.onArchive({ presetId: preset.id, revision: preset.revision })}
                >
                  Archive
                </button>
              </Show>
            </div>
          )}
        </For>
      </div>
      <LoadMore more={props.more} testId="preset-list-load-more" />
    </div>
  )
}

function slotSummary(preset: Preset) {
  return CONFIGURATION_SLOTS.filter((slot) => preset.configurations[slot])
    .map((slot) => SLOT_LABELS[slot])
    .join(" · ")
}
