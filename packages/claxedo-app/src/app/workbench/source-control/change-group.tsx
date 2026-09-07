import { For, Show, type JSX } from "solid-js"
import { DiffChanges } from "@opencode-ai/ui/diff-changes"
import { getDirectory, getFilename } from "@opencode-ai/ui/utils/path"
import { Spinner } from "@opencode-ai/ui/spinner"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import { SemanticIcon } from "@/ui/semantic-icon"
import { useLanguage } from "@/platform/i18n/provider"
import type { GitStatusEntry } from "@/platform/runtime/workspace-git-client"

export type ChangeGroupId = "staged" | "changes"

export type ChangeEntry = Pick<GitStatusEntry, "path" | "status" | "additions" | "deletions">

const STATUS_LETTER: Record<GitStatusEntry["status"], string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  untracked: "U",
  conflicted: "C",
}

const STATUS_LABEL_KEY = {
  added: "navigator.sourceControl.status.added",
  modified: "navigator.sourceControl.status.modified",
  deleted: "navigator.sourceControl.status.deleted",
  renamed: "navigator.sourceControl.status.renamed",
  untracked: "navigator.sourceControl.status.untracked",
  conflicted: "navigator.sourceControl.status.conflicted",
} as const satisfies Record<GitStatusEntry["status"], string>

function statusColor(status: GitStatusEntry["status"]) {
  if (status === "added" || status === "untracked") return "color: var(--icon-diff-add-base)"
  if (status === "deleted") return "color: var(--icon-diff-delete-base)"
  if (status === "conflicted") return "color: var(--icon-critical-base)"
  return "color: var(--icon-diff-modified-base)"
}

export function SourceControlSectionHeader(props: {
  testId: string
  label: string
  title?: string
  count?: number
  collapsed: boolean
  /** The group the pane's review currently shows. */
  active?: boolean
  onToggle: () => void
  children?: JSX.Element
}) {
  return (
    <div
      data-testid={props.testId}
      data-count={props.count}
      data-collapsed={props.collapsed ? "true" : undefined}
      data-active={props.active ? "true" : undefined}
      class="claxedo-source-control-header group flex h-7 shrink-0 items-center gap-1 pr-2 pl-3"
    >
      <button
        type="button"
        aria-expanded={!props.collapsed}
        class="flex min-w-0 flex-1 items-center gap-1 text-left text-xs font-medium hover:text-text-base"
        classList={{ "text-text-base": props.active, "text-text-weaker": !props.active }}
        onClick={() => props.onToggle()}
      >
        <Icon
          name="chevron-down"
          size="small"
          class="claxedo-source-control-chevron shrink-0 text-icon-weak-base"
          classList={{ "-rotate-90": props.collapsed }}
        />
        <span class="truncate" title={props.title}>{props.label}</span>
        <Show when={props.count !== undefined}>
          <span class="text-text-weaker/80">({props.count})</span>
        </Show>
      </button>
      {props.children}
    </div>
  )
}

export function ChangeRow(props: {
  entry: ChangeEntry
  group: string
  active: boolean
  onOpen: () => void
  action?: JSX.Element
}) {
  const language = useLanguage()
  return (
    <div
      role="listitem"
      data-testid="source-control-row"
      data-path={props.entry.path}
      data-status={props.entry.status}
      data-group={props.group}
      class="claxedo-source-control-row group flex h-7 min-w-0 items-center gap-1 rounded-md pr-1 pl-1.5 text-12-medium text-text-weak hover:bg-surface-base-hover"
      classList={{ "bg-surface-base-active": props.active }}
    >
      <button type="button" data-slot="open" class="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left" onClick={() => props.onOpen()}>
        <span
          class="w-3.5 shrink-0 text-center text-12-medium"
          style={statusColor(props.entry.status)}
          aria-label={language.t(STATUS_LABEL_KEY[props.entry.status])}
          title={language.t(STATUS_LABEL_KEY[props.entry.status])}
        >
          {STATUS_LETTER[props.entry.status]}
        </span>
        <span class="flex min-w-0 flex-1 items-baseline gap-1.5">
          <span class="min-w-0 truncate text-text-base">{getFilename(props.entry.path)}</span>
          <Show when={getDirectory(props.entry.path).replace(/\/$/, "")}>
            {(directory) => <span class="min-w-0 truncate text-11-regular text-text-weak/70">{directory()}</span>}
          </Show>
        </span>
        <DiffChanges class="shrink-0 text-11-regular" changes={{ additions: props.entry.additions, deletions: props.entry.deletions }} />
      </button>
      {props.action}
    </div>
  )
}

export function ChangeGroup(props: {
  id: ChangeGroupId
  entries: readonly GitStatusEntry[]
  collapsed: boolean
  active: boolean
  onToggle: () => void
  activePath?: string
  pending?: string
  onAction: (paths: string[]) => void
  onOpen: (entry: GitStatusEntry) => void
}) {
  const language = useLanguage()
  const action = (): "stage" | "unstage" => (props.id === "staged" ? "unstage" : "stage")
  const actionLabel = () =>
    action() === "stage" ? language.t("navigator.sourceControl.stage") : language.t("navigator.sourceControl.unstage")
  const actionAllLabel = () =>
    action() === "stage"
      ? language.t("navigator.sourceControl.stageAll")
      : language.t("navigator.sourceControl.unstageAll")
  const actionPending = () => props.pending === action()

  return (
    <section data-testid={`source-control-section-${props.id}`} class="flex shrink-0 flex-col">
      <SourceControlSectionHeader
        testId={`source-control-group-${props.id}`}
        label={
          props.id === "staged"
            ? language.t("navigator.sourceControl.group.staged")
            : language.t("navigator.sourceControl.group.changes")
        }
        count={props.entries.length}
        collapsed={props.collapsed}
        active={props.active}
        onToggle={props.onToggle}
      >
        <Show when={props.entries.length > 0}>
          <button
            type="button"
            data-action={`${action()}-all`}
            aria-label={actionAllLabel()}
            title={actionAllLabel()}
            class="claxedo-source-control-action flex size-5 shrink-0 items-center justify-center rounded text-icon-weak-base hover:bg-surface-base-active hover:text-icon-base"
            onClick={() => props.onAction(props.entries.map((entry) => entry.path))}
          >
            <Show when={actionPending()} fallback={<SemanticIcon concept={action()} size="small" />}>
              <Spinner class="size-3" />
            </Show>
          </button>
        </Show>
      </SourceControlSectionHeader>
      <Show when={!props.collapsed}>
        <div class="flex flex-col gap-px px-2 pb-1" role="list">
          <For each={props.entries}>
            {(entry) => (
              <ChangeRow
                entry={entry}
                group={props.id}
                active={props.activePath === entry.path}
                onOpen={() => props.onOpen(entry)}
                action={
                  <button
                    type="button"
                    data-action={action()}
                    aria-label={`${actionLabel()} ${entry.path}`}
                    title={actionLabel()}
                    class="claxedo-source-control-action flex size-5 shrink-0 items-center justify-center rounded text-icon-weak-base hover:bg-surface-base-active hover:text-icon-base"
                    onClick={() => props.onAction([entry.path])}
                  >
                    <SemanticIcon concept={action()} size="small" />
                  </button>
                }
              />
            )}
          </For>
        </div>
      </Show>
    </section>
  )
}
