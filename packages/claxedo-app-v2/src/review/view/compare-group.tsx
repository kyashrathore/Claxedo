import { For, Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import type { AppError } from "@/server"
import { useErrorText } from "../errors"
import { reviewDictionary } from "../i18n"
import { ChangeRow, SourceControlSectionHeader, type ChangeEntry } from "./change-group"

function CompareRows(props: {
  readonly entries: readonly ChangeEntry[]
  readonly activePath?: string
  readonly onOpen: (entry: ChangeEntry) => void
}): JSX.Element {
  const t = useTranslator(reviewDictionary)
  return (
    <Show
      when={props.entries.length > 0}
      fallback={
        <div data-testid="source-control-compare-empty" class="px-3 py-2 text-12-regular text-text-weak">
          {t("review.sourceControl.empty")}
        </div>
      }
    >
      <div class="flex flex-col gap-px px-2 pb-1" role="list">
        <For each={props.entries}>
          {(entry) => (
            <ChangeRow
              entry={entry}
              group="compare"
              active={props.activePath === entry.path}
              onOpen={() => props.onOpen(entry)}
            />
          )}
        </For>
      </div>
    </Show>
  )
}

export function CompareGroup(props: {
  readonly label: string
  readonly entries?: readonly ChangeEntry[]
  readonly loading: boolean
  readonly error?: AppError
  readonly collapsed: boolean
  readonly onToggle: () => void
  readonly activePath?: string
  readonly onOpen: (entry: ChangeEntry) => void
}): JSX.Element {
  const t = useTranslator(reviewDictionary)
  const errorText = useErrorText()
  return (
    <section
      data-testid="source-control-section-compare"
      aria-label={t("review.sourceControl.group.compare")}
      class="flex shrink-0 flex-col"
    >
      <SourceControlSectionHeader
        testId="source-control-group-compare"
        label={props.label}
        title={t("review.sourceControl.group.compare")}
        count={props.entries?.length}
        collapsed={props.collapsed}
        active
        onToggle={props.onToggle}
      />
      <Show when={!props.collapsed}>
        <Show
          when={!props.loading}
          fallback={
            <div
              data-testid="source-control-compare-loading"
              aria-label={t("review.sourceControl.loading")}
              class="flex flex-col gap-1 p-2"
            >
              <div class="h-6 w-[82%] rounded-md bg-surface-base" />
              <div class="h-6 w-[69%] rounded-md bg-surface-base" />
            </div>
          }
        >
          <Show
            when={props.error}
            fallback={<CompareRows entries={props.entries ?? []} activePath={props.activePath} onOpen={props.onOpen} />}
          >
            {(error) => (
              <div
                data-testid="source-control-compare-error"
                role="alert"
                class="px-3 py-2 text-11-regular text-icon-critical-base"
              >
                {errorText(error())}
              </div>
            )}
          </Show>
        </Show>
      </Show>
    </section>
  )
}
