import { For, Show } from "solid-js"
import { useLanguage } from "@/platform/i18n/provider"
import { formatRelativeTime } from "@/lib/relative-time"
import type { GitCommitSummary } from "@/platform/runtime/workspace-git-client"
import { SourceControlSectionHeader } from "./change-group"

export function CommitGraph(props: {
  commits: readonly GitCommitSummary[]
  loading: boolean
  collapsed: boolean
  onToggle: () => void
  /** The commit whose changes the pane reviews, if the review is one commit. */
  selectedHash?: string
  onSelect: (commit: GitCommitSummary) => void
}) {
  const language = useLanguage()
  return (
    <section
      data-testid="source-control-graph"
      class="flex min-h-0 flex-col border-t border-border-weak-base"
      classList={{ "shrink-0": props.collapsed, "flex-1": !props.collapsed }}
    >
      <SourceControlSectionHeader
        testId="source-control-group-graph"
        label={language.t("navigator.sourceControl.group.graph")}
        collapsed={props.collapsed}
        onToggle={props.onToggle}
      />
      <Show when={!props.collapsed}>
        <Show
          when={props.commits.length > 0}
          fallback={
            <Show when={!props.loading}>
              <div class="px-3 py-2 text-12-regular text-text-weak">{language.t("navigator.sourceControl.graph.empty")}</div>
            </Show>
          }
        >
          <div class="min-h-0 flex-1 overflow-auto">
            <ol role="listbox" aria-label={language.t("navigator.sourceControl.group.graph")} class="claxedo-source-control-graph flex flex-col px-2 pb-2">
              <For each={props.commits}>
                {(commit) => (
                  <li
                    role="option"
                    tabIndex={0}
                    aria-selected={props.selectedHash === commit.hash}
                    data-testid="source-control-commit-row"
                    data-hash={commit.hash}
                    class="claxedo-source-control-commit relative flex min-w-0 cursor-default items-start gap-2 rounded-md py-1 pr-1.5 pl-1.5 text-12-regular text-text-weak hover:bg-surface-base-hover"
                    classList={{ "bg-surface-base-active": props.selectedHash === commit.hash }}
                    title={commit.hash}
                    onClick={() => props.onSelect(commit)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return
                      event.preventDefault()
                      props.onSelect(commit)
                    }}
                  >
                    <span class="claxedo-source-control-dot mt-[7px] size-1.5 shrink-0 rounded-full bg-icon-weak-base" aria-hidden="true" />
                    <span class="flex min-w-0 flex-1 flex-col gap-px">
                      <span class="flex min-w-0 items-center gap-1.5">
                        <span class="min-w-0 truncate text-text-base">{commit.subject}</span>
                        <For each={commit.refs}>
                          {(ref) => (
                            <span class="claxedo-source-control-chip shrink-0 truncate rounded px-1 text-11-regular text-text-weak">{ref}</span>
                          )}
                        </For>
                      </span>
                      <span class="flex min-w-0 items-center gap-1.5 text-11-regular text-text-weak/70">
                        <span class="shrink-0 font-mono">{commit.shortHash}</span>
                        <span class="min-w-0 truncate">{commit.author}</span>
                        <span class="shrink-0">{formatRelativeTime(Date.parse(commit.date), language.intl())}</span>
                      </span>
                    </span>
                  </li>
                )}
              </For>
            </ol>
          </div>
        </Show>
      </Show>
    </section>
  )
}
