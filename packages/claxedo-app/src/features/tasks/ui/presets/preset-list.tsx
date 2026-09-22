import { For, Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import type { Preset } from "@claxedo/tasks"
import { SettingsEmpty, SettingsList, SettingsRow } from "@/ui/controls/settings-list"
import { ListFailureNotice, type ListFailure } from "../shared/list-failure"
import { LoadMore, type MorePages } from "../shared/load-more"
import { PLACEMENT_LABELS, SLOT_LABELS, configuredSlotsOf, shortAge } from "../../view-model"

export type PresetListProps = {
  presets: readonly Preset[]
  selectedPresetId?: string
  loading?: boolean
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

/**
 * The preset catalog, as the rows every other Settings section is made of.
 *
 * It was a six-column table, which is the Tasks surface's language: presets are
 * only ever read here, and a table of its own read as another product's screen
 * dropped into Settings. The columns that survived the move are the ones a
 * preset is chosen by, on the row's second line.
 */
export function PresetList(props: PresetListProps) {
  const now = Date.now()

  return (
    <div class="flex flex-col gap-3" data-testid="preset-list">
      <Show when={props.error}>
        {(message) => (
          <p class="text-12-regular text-icon-critical-base" role="alert">
            {message()}
          </p>
        )}
      </Show>
      <ListFailureNotice failure={props.failure} testId="preset-list-retry" />

      <div aria-busy={props.loading ? "true" : "false"}>
        <Show
          when={props.presets.length > 0}
          fallback={(
            <Show when={props.failure === undefined}>
              <SettingsEmpty>
                <span class="flex flex-col items-center gap-2">
                  <span>No presets yet.</span>
                  <Button size="small" variant="secondary" data-testid="preset-list-create" onClick={() => props.onCreate()}>
                    New preset
                  </Button>
                </span>
              </SettingsEmpty>
            </Show>
          )}
        >
          <SettingsList>
            <For each={props.presets}>
              {(preset) => (
                <SettingsRow
                  title={(
                    <button
                      type="button"
                      class="flex min-w-0 items-center gap-2 border-none bg-transparent p-0 text-left text-14-medium text-text-strong"
                      data-testid={`preset-list-row-${preset.id}`}
                      aria-current={props.selectedPresetId === preset.id ? "true" : undefined}
                      onClick={() => props.onSelect(preset.id)}
                    >
                      <span class="truncate">{preset.name}</span>
                      <Show when={preset.archivedAt !== null}>
                        <span class="shrink-0 text-12-regular text-text-weak">Archived</span>
                      </Show>
                    </button>
                  )}
                  description={presetSummary(preset, now)}
                >
                  <Show
                    when={preset.archivedAt === null}
                    fallback={(
                      <Button
                        size="small"
                        variant="ghost"
                        data-testid={`preset-list-restore-${preset.id}`}
                        disabled={props.busyPresetId === preset.id}
                        onClick={() => props.onRestore({ presetId: preset.id, revision: preset.revision })}
                      >
                        Restore
                      </Button>
                    )}
                  >
                    <Button
                      size="small"
                      variant="ghost"
                      data-testid={`preset-list-archive-${preset.id}`}
                      disabled={props.busyPresetId === preset.id}
                      onClick={() => props.onArchive({ presetId: preset.id, revision: preset.revision })}
                    >
                      Archive
                    </Button>
                  </Show>
                </SettingsRow>
              )}
            </For>
          </SettingsList>
        </Show>
      </div>

      <LoadMore more={props.more} testId="preset-list-load-more" />
    </div>
  )
}

/** What a preset is chosen by, in the order it is read: where, what, how much, how old. */
function presetSummary(preset: Preset, now: number) {
  const slots = configuredSlotsOf(preset).map((slot) => SLOT_LABELS[slot])
  return [
    PLACEMENT_LABELS[preset.execution.placement],
    primarySummary(preset),
    ...(slots.length > 0 ? [slots.join(" · ")] : []),
    shortAge(preset.updatedAt, now),
  ].filter(Boolean).join(" · ")
}

/** The primary slot as one line: harness, model, effort — the fields a preset is chosen by. */
function primarySummary(preset: Preset) {
  const primary = preset.configurations.primary
  return [primary.harness.id, primary.model.modelID, primary.effort].filter(Boolean).join(" · ")
}
