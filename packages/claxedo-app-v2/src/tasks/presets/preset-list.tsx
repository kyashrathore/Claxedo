import { For, Show, type JSX } from "solid-js"
import type { Preset } from "@claxedo/tasks"
import { useTranslator, type DomainTranslate } from "@/i18n"
import { SettingsEmpty, SettingsList, SettingsRow } from "@/settings"
import { Button } from "@/ui"
import type { ListFailure, MorePages } from "../data/queries"
import { dictionary, type TasksKey } from "../i18n"
import { SLOT_KEYS, configuredSlotsOf, shortAge } from "../model"
import { ListFailureNotice, LoadMore } from "../view/load-more"

type PresetInput = { presetId: string; revision: number }

export type PresetListProps = {
  readonly presets: readonly Preset[]
  readonly selectedPresetId?: string
  readonly loading?: boolean
  readonly busyPresetId?: string
  readonly error?: string
  readonly failure?: ListFailure
  readonly more?: MorePages
  readonly onSelect: (presetId: string) => void
  readonly onCreate: () => void
  readonly onArchive: (input: PresetInput) => void
  readonly onRestore: (input: PresetInput) => void
}

const PLACEMENT_KEYS: Readonly<Record<Preset["execution"]["placement"], TasksKey>> = {
  local: "tasks.preset.local",
  cloud: "tasks.preset.cloud",
}

function presetSummary(t: DomainTranslate<TasksKey>, preset: Preset, now: number) {
  const primary = preset.configurations.primary
  const age = shortAge(preset.updatedAt, now)
  const slots = configuredSlotsOf(preset).map((slot) => t(SLOT_KEYS[slot]))
  return [
    t(PLACEMENT_KEYS[preset.execution.placement]),
    [primary.harness.id, primary.model.modelID, primary.effort].filter(Boolean).join(" · "),
    ...(slots.length > 0 ? [slots.join(" · ")] : []),
    t(age.key, { count: age.count }),
  ]
    .filter(Boolean)
    .join(" · ")
}

function PresetRow(props: {
  readonly preset: Preset
  readonly list: PresetListProps
  readonly now: number
}): JSX.Element {
  const t = useTranslator(dictionary)
  const input = () => ({ presetId: props.preset.id, revision: props.preset.revision })
  const busy = () => props.list.busyPresetId === props.preset.id
  return (
    <SettingsRow
      title={
        <button
          type="button"
          class="flex min-w-0 items-center gap-2 border-none bg-transparent p-0 text-left text-14-medium text-text-strong"
          data-testid={`preset-list-row-${props.preset.id}`}
          aria-current={props.list.selectedPresetId === props.preset.id ? "true" : undefined}
          onClick={() => props.list.onSelect(props.preset.id)}
        >
          <span class="truncate">{props.preset.name}</span>
          <Show when={props.preset.archivedAt !== null}>
            <span class="shrink-0 text-12-regular text-text-weak">{t("tasks.archived")}</span>
          </Show>
        </button>
      }
      description={presetSummary(t, props.preset, props.now)}
    >
      <Show
        when={props.preset.archivedAt === null}
        fallback={
          <Button
            size="small"
            variant="ghost"
            data-testid={`preset-list-restore-${props.preset.id}`}
            disabled={busy()}
            onClick={() => props.list.onRestore(input())}
          >
            {t("tasks.preset.restore")}
          </Button>
        }
      >
        <Button
          size="small"
          variant="ghost"
          data-testid={`preset-list-archive-${props.preset.id}`}
          disabled={busy()}
          onClick={() => props.list.onArchive(input())}
        >
          {t("tasks.preset.archive")}
        </Button>
      </Show>
    </SettingsRow>
  )
}

export function PresetList(props: PresetListProps): JSX.Element {
  const t = useTranslator(dictionary)
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
          fallback={
            <Show when={props.failure === undefined}>
              <SettingsEmpty>
                <span class="flex flex-col items-center gap-2">
                  <span>{t("tasks.preset.none")}</span>
                  <Button
                    size="small"
                    variant="secondary"
                    data-testid="preset-list-create"
                    onClick={() => props.onCreate()}
                  >
                    {t("tasks.preset.new")}
                  </Button>
                </span>
              </SettingsEmpty>
            </Show>
          }
        >
          <SettingsList>
            <For each={props.presets}>{(preset) => <PresetRow preset={preset} list={props} now={now} />}</For>
          </SettingsList>
        </Show>
      </div>
      <LoadMore more={props.more} testId="preset-list-load-more" />
    </div>
  )
}
