import { For, Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Switch } from "@opencode-ai/ui/switch"
import { CONFIGURATION_SLOTS, type Preset } from "@claxedo/tasks"
import { ListFailureNotice, type ListFailure } from "../shared/list-failure"
import { LoadMore, type MorePages } from "../shared/load-more"
import { PLACEMENT_LABELS, SLOT_LABELS, shortAge } from "../../view-model"

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
  const now = Date.now()

  return (
    <div class="tsk tsk-root" data-testid="preset-list">
      <div class="tsk-toolbar">
        <p class="tsk-hint tsk-spacer">
          Presets are yours. They describe how and where an agent works, and are reusable across your projects.
        </p>
        <Switch
          data-testid="preset-list-include-archived"
          checked={props.includeArchived}
          onChange={(value: boolean) => props.onIncludeArchivedChange(value)}
        >
          Show archived
        </Switch>
      </div>

      <Show when={props.error}>
        {(message) => (
          <p class="tsk-error tsk-inset" role="alert">
            {message()}
          </p>
        )}
      </Show>
      <ListFailureNotice failure={props.failure} testId="preset-list-retry" />

      <div class="tsk-listing" aria-busy={props.loading ? "true" : "false"}>
        <div class="tsk-thead tsk-tr-preset">
          <span>Name</span>
          <span class="tsk-cell">Placement</span>
          <span class="tsk-cell">Primary configuration</span>
          <span class="tsk-cell">Slots</span>
          <span class="tsk-cell">Updated</span>
          <span />
        </div>

        <For
          each={props.presets}
          fallback={
            <Show when={props.failure === undefined}>
              <div class="tsk-empty">
                <p>No presets yet.</p>
                <Button size="small" variant="ghost" class="tsk-empty-action" onClick={() => props.onCreate()}>
                  New preset
                </Button>
              </div>
            </Show>
          }
        >
          {(preset, index) => (
            <div
              class="tsk-tr tsk-tr-preset tsk-rise"
              style={{ "--tsk-i": String(index()) }}
              data-selected={props.selectedPresetId === preset.id ? "true" : undefined}
              data-archived={preset.archivedAt === null ? undefined : "true"}
            >
              <button
                type="button"
                class="tsk-open"
                data-testid={`preset-list-row-${preset.id}`}
                aria-current={props.selectedPresetId === preset.id ? "true" : undefined}
                onClick={() => props.onSelect(preset.id)}
              >
                <span class="tsk-open-name">{preset.name}</span>
                <Show when={preset.archivedAt !== null}>
                  <span class="tsk-parent">Archived</span>
                </Show>
              </button>

              <span class="tsk-cell">{PLACEMENT_LABELS[preset.execution.placement]}</span>
              <span class="tsk-cell tsk-mono tsk-truncate">{primarySummary(preset)}</span>
              <span class="tsk-cell tsk-truncate">{slotSummary(preset)}</span>
              <span class="tsk-cell tsk-cell-time">{shortAge(preset.updatedAt, now)}</span>

              <Show
                when={preset.archivedAt === null}
                fallback={
                  <Button
                    size="small"
                    variant="ghost"
                    class="tsk-row-quiet"
                    data-testid={`preset-list-restore-${preset.id}`}
                    disabled={props.busyPresetId === preset.id}
                    onClick={() => props.onRestore({ presetId: preset.id, revision: preset.revision })}
                  >
                    Restore
                  </Button>
                }
              >
                <Button
                  size="small"
                  variant="ghost"
                  class="tsk-row-quiet"
                  data-testid={`preset-list-archive-${preset.id}`}
                  disabled={props.busyPresetId === preset.id}
                  onClick={() => props.onArchive({ presetId: preset.id, revision: preset.revision })}
                >
                  Archive
                </Button>
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

/** The primary slot as one line: harness, model, effort — the fields a preset is chosen by. */
function primarySummary(preset: Preset) {
  const primary = preset.configurations.primary
  return [primary.harness.id, primary.model.modelID, primary.effort].filter(Boolean).join(" · ")
}
