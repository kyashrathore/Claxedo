import { For, Show, type JSX } from "solid-js"
import { useI18n, useTranslator } from "@/i18n"
import { formatRelativeTime } from "@/lib/relative-time"
import type { GitCommit } from "@/server"
import { reviewDictionary } from "../i18n"
import { SourceControlSectionHeader } from "./change-group"

function CommitRow(props: {
  readonly commit: GitCommit
  readonly selected: boolean
  readonly onSelect: (commit: GitCommit) => void
}): JSX.Element {
  const i18n = useI18n()
  return (
    <li
      role="option"
      tabIndex={0}
      aria-selected={props.selected}
      data-testid="source-control-commit-row"
      data-hash={props.commit.hash}
      class="claxedo-source-control-commit relative flex min-w-0 cursor-default items-start gap-2 rounded-md py-1 pr-1.5 pl-1.5 text-12-regular text-text-weak hover:bg-surface-base-hover"
      classList={{ "bg-surface-base-active": props.selected }}
      title={props.commit.hash}
      onClick={() => props.onSelect(props.commit)}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return
        event.preventDefault()
        props.onSelect(props.commit)
      }}
    >
      <span
        class="claxedo-source-control-dot mt-[7px] size-1.5 shrink-0 rounded-full bg-icon-weak-base"
        aria-hidden="true"
      />
      <span class="flex min-w-0 flex-1 flex-col gap-px">
        <span class="flex min-w-0 items-center gap-1.5">
          <span class="min-w-0 truncate text-text-base">{props.commit.subject}</span>
          <For each={props.commit.refs}>
            {(ref) => (
              <span class="claxedo-source-control-chip shrink-0 truncate rounded px-1 text-11-regular text-text-weak">
                {ref}
              </span>
            )}
          </For>
        </span>
        <span class="flex min-w-0 items-center gap-1.5 text-11-regular text-text-weak/70">
          <span class="shrink-0 font-mono">{props.commit.shortHash}</span>
          <span class="min-w-0 truncate">{props.commit.author}</span>
          <span class="shrink-0">{formatRelativeTime(Date.parse(props.commit.date), i18n.intlTag())}</span>
        </span>
      </span>
    </li>
  )
}

export function CommitGraph(props: {
  readonly commits: readonly GitCommit[]
  readonly loading: boolean
  readonly collapsed: boolean
  readonly onToggle: () => void
  readonly selectedHash?: string
  readonly onSelect: (commit: GitCommit) => void
}): JSX.Element {
  const t = useTranslator(reviewDictionary)
  return (
    <section
      data-testid="source-control-graph"
      class="flex min-h-0 flex-col border-t border-border-weak-base"
      classList={{ "shrink-0": props.collapsed, "flex-1": !props.collapsed }}
    >
      <SourceControlSectionHeader
        testId="source-control-group-graph"
        label={t("review.sourceControl.group.graph")}
        collapsed={props.collapsed}
        onToggle={props.onToggle}
      />
      <Show when={!props.collapsed}>
        <Show
          when={props.commits.length > 0}
          fallback={
            <Show when={!props.loading}>
              <div class="px-3 py-2 text-12-regular text-text-weak">{t("review.sourceControl.graphEmpty")}</div>
            </Show>
          }
        >
          <div class="min-h-0 flex-1 overflow-auto">
            <ol
              role="listbox"
              aria-label={t("review.sourceControl.group.graph")}
              class="claxedo-source-control-graph flex flex-col px-2 pb-2"
            >
              <For each={props.commits}>
                {(commit) => (
                  <CommitRow commit={commit} selected={props.selectedHash === commit.hash} onSelect={props.onSelect} />
                )}
              </For>
            </ol>
          </div>
        </Show>
      </Show>
    </section>
  )
}
