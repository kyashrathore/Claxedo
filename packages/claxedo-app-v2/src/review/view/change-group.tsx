import { For, Show, type JSX } from "solid-js"
import { basename, parentPath } from "@/files"
import { useTranslator } from "@/i18n"
import type { ChangeStatus } from "@/server"
import { ClaxedoIcon as Icon, SemanticIcon, DiffChanges, Spinner } from "@/ui"
import type { GitAction } from "../git-actions"
import { dictionary, type ReviewKey } from "../i18n"

export type ChangeGroupId = "staged" | "changes"

export type ChangeEntry = {
  readonly path: string
  readonly status: ChangeStatus
  readonly additions: number
  readonly deletions: number
}

const STATUS_LETTER: Readonly<Record<ChangeStatus, string>> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  untracked: "U",
  conflicted: "C",
}

const STATUS_LABEL: Readonly<Record<ChangeStatus, ReviewKey>> = {
  added: "review.status.added",
  modified: "review.status.modified",
  deleted: "review.status.deleted",
  renamed: "review.status.renamed",
  untracked: "review.status.untracked",
  conflicted: "review.status.conflicted",
}

function statusColor(status: ChangeStatus): string {
  if (status === "added" || status === "untracked") return "color: var(--icon-diff-add-base)"
  if (status === "deleted") return "color: var(--icon-diff-delete-base)"
  if (status === "conflicted") return "color: var(--icon-critical-base)"
  return "color: var(--icon-diff-modified-base)"
}

export function SourceControlSectionHeader(props: {
  readonly testId: string
  readonly label: string
  readonly title?: string
  readonly count?: number
  readonly collapsed: boolean
  readonly active?: boolean
  readonly onToggle: () => void
  readonly children?: JSX.Element
}): JSX.Element {
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
        <span class="truncate" title={props.title}>
          {props.label}
        </span>
        <Show when={props.count !== undefined}>
          <span class="text-text-weaker/80">({props.count})</span>
        </Show>
      </button>
      {props.children}
    </div>
  )
}

export function ChangeRow(props: {
  readonly entry: ChangeEntry
  readonly group: string
  readonly active: boolean
  readonly onOpen: () => void
  readonly action?: JSX.Element
}): JSX.Element {
  const t = useTranslator(dictionary)
  const label = () => t(STATUS_LABEL[props.entry.status])
  return (
    <div
      role="listitem"
      data-testid="source-control-row"
      data-path={props.entry.path}
      data-status={props.entry.status}
      data-group={props.group}
      data-active={props.active ? "true" : undefined}
      class="claxedo-source-control-row group flex h-7 min-w-0 items-center gap-1 rounded-md pr-1 pl-1.5 text-12-medium text-text-weak hover:bg-surface-base-hover"
      classList={{ "bg-surface-base-active": props.active }}
    >
      <button
        type="button"
        data-slot="open"
        class="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left"
        onClick={() => props.onOpen()}
      >
        <span
          class="w-3.5 shrink-0 text-center text-12-medium"
          style={statusColor(props.entry.status)}
          aria-label={label()}
          title={label()}
        >
          {STATUS_LETTER[props.entry.status]}
        </span>
        <span class="flex min-w-0 flex-1 items-baseline gap-1.5">
          <span class="min-w-0 truncate text-text-base">{basename(props.entry.path)}</span>
          <Show when={parentPath(props.entry.path)}>
            {(directory) => <span class="min-w-0 truncate text-11-regular text-text-weak/70">{directory()}</span>}
          </Show>
        </span>
        <DiffChanges
          class="shrink-0 text-11-regular"
          changes={{ additions: props.entry.additions, deletions: props.entry.deletions }}
        />
      </button>
      {props.action}
    </div>
  )
}

function GroupAction(props: {
  readonly action: "stage" | "unstage"
  readonly label: string
  readonly title: string
  readonly dataAction: string
  readonly pending?: boolean
  readonly onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      data-action={props.dataAction}
      aria-label={props.label}
      title={props.title}
      class="claxedo-source-control-action flex size-5 shrink-0 items-center justify-center rounded text-icon-weak-base hover:bg-surface-base-active hover:text-icon-base"
      onClick={() => props.onClick()}
    >
      <Show when={props.pending} fallback={<SemanticIcon concept={props.action} size="small" />}>
        <Spinner class="size-3" />
      </Show>
    </button>
  )
}

export function ChangeGroup(props: {
  readonly id: ChangeGroupId
  readonly entries: readonly ChangeEntry[]
  readonly collapsed: boolean
  readonly active: boolean
  readonly onToggle: () => void
  readonly activePath?: string
  readonly pending?: GitAction
  readonly onAction: (paths: string[]) => void
  readonly onOpen: (entry: ChangeEntry) => void
}): JSX.Element {
  const t = useTranslator(dictionary)
  const action = (): "stage" | "unstage" => (props.id === "staged" ? "unstage" : "stage")
  const actionLabel = () => (action() === "stage" ? t("review.sourceControl.stage") : t("review.sourceControl.unstage"))
  const actionAllLabel = () =>
    action() === "stage" ? t("review.sourceControl.stageAll") : t("review.sourceControl.unstageAll")
  return (
    <section data-testid={`source-control-section-${props.id}`} class="flex shrink-0 flex-col">
      <SourceControlSectionHeader
        testId={`source-control-group-${props.id}`}
        label={props.id === "staged" ? t("review.sourceControl.group.staged") : t("review.sourceControl.group.changes")}
        count={props.entries.length}
        collapsed={props.collapsed}
        active={props.active}
        onToggle={props.onToggle}
      >
        <Show when={props.entries.length > 0}>
          <GroupAction
            action={action()}
            label={actionAllLabel()}
            title={actionAllLabel()}
            dataAction={`${action()}-all`}
            pending={props.pending === action()}
            onClick={() => props.onAction(props.entries.map((entry) => entry.path))}
          />
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
                  <GroupAction
                    action={action()}
                    label={`${actionLabel()} ${entry.path}`}
                    title={actionLabel()}
                    dataAction={action()}
                    onClick={() => props.onAction([entry.path])}
                  />
                }
              />
            )}
          </For>
        </div>
      </Show>
    </section>
  )
}
