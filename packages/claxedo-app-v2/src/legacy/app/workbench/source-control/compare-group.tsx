import { errorMessage } from "@claxedo/helpers"
import { For, Show } from "solid-js"
import { useLanguage } from "@/platform/i18n/provider"
import type { WorkspaceDiffSummaryEntry } from "@/platform/files/workspace-diff-summary-query"
import { ChangeRow, SourceControlSectionHeader } from "./change-group"

/** The files a ref comparison changes, above the worktree groups while that comparison is the pane's review. */
export function CompareGroup(props: {
  label: string
  entries?: readonly WorkspaceDiffSummaryEntry[]
  loading: boolean
  /** The summary read failed (a persisted ref that no longer resolves, say); shown in place of the rows. */
  error?: unknown
  collapsed: boolean
  onToggle: () => void
  activePath?: string
  onOpen: (entry: WorkspaceDiffSummaryEntry) => void
}) {
  const language = useLanguage()
  return (
    <section data-testid="source-control-section-compare" aria-label={language.t("navigator.sourceControl.group.compare")} class="flex shrink-0 flex-col">
      <SourceControlSectionHeader
        testId="source-control-group-compare"
        label={props.label}
        title={language.t("navigator.sourceControl.group.compare")}
        count={props.entries?.length}
        collapsed={props.collapsed}
        active
        onToggle={props.onToggle}
      />
      <Show when={!props.collapsed}>
        <Show
          when={!props.loading}
          fallback={
            <div data-testid="source-control-compare-loading" aria-label={language.t("navigator.sourceControl.loading")} class="flex flex-col gap-1 p-2">
              <div class="h-6 w-[82%] rounded-md bg-surface-base" />
              <div class="h-6 w-[69%] rounded-md bg-surface-base" />
            </div>
          }
        >
          <Show
            when={props.error === undefined || props.error === null}
            fallback={
              <div data-testid="source-control-compare-error" role="alert" class="px-3 py-2 text-11-regular text-icon-critical-base">
                {errorMessage(props.error)}
              </div>
            }
          >
            <Show
              when={(props.entries?.length ?? 0) > 0}
              fallback={
                <div data-testid="source-control-compare-empty" class="px-3 py-2 text-12-regular text-text-weak">
                  {language.t("navigator.sourceControl.empty")}
                </div>
              }
            >
              <div class="flex flex-col gap-px px-2 pb-1" role="list">
                <For each={props.entries}>
                  {(entry) => (
                    <ChangeRow entry={entry} group="compare" active={props.activePath === entry.path} onOpen={() => props.onOpen(entry)} />
                  )}
                </For>
              </div>
            </Show>
          </Show>
        </Show>
      </Show>
    </section>
  )
}
