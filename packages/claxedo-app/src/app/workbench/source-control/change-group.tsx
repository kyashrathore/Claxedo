import { For, Show, type JSX } from "solid-js"
import { DiffChanges } from "@opencode-ai/ui/diff-changes"
import { getDirectory, getFilename } from "@opencode-ai/ui/utils/path"
import { Spinner } from "@opencode-ai/ui/spinner"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import { SemanticIcon } from "@/ui/semantic-icon"
import { useLanguage } from "@/platform/i18n/provider"
import type { GitStatusEntry } from "@/platform/runtime/workspace-git-client"

export type ChangeGroupId = "staged" | "changes"

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
  count?: number
  collapsed: boolean
  onToggle: () => void
  children?: JSX.Element
}) {
  return (
    <div
      data-testid={props.testId}
      data-count={props.count}
      data-collapsed={props.collapsed ? "true" : undefined}
      class="claxedo-source-control-header group flex h-7 shrink-0 items-center gap-1 pr-1.5 pl-2"
    >
      <button
        type="button"
        aria-expanded={!props.collapsed}
        class="flex min-w-0 flex-1 items-center gap-1 text-left text-xs font-medium uppercase tracking-normal text-text-weaker hover:text-text-base"
        onClick={() => props.onToggle()}
      >
        <Icon
          name="chevron-down"
          size="small"
          class="claxedo-source-control-chevron shrink-0 text-icon-weak-base"
          classList={{ "-rotate-90": props.collapsed }}
        />
        <span class="truncate">{props.label}</span>
        <Show when={props.count !== undefined}>
          <span class="text-text-weaker/80">({props.count})</span>
        </Show>
      </button>
      {props.children}
    </div>
  )
}

export function ChangeGroup(props: {
  id: ChangeGroupId
  entries: readonly GitStatusEntry[]
  collapsed: boolean
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
        <div class="flex flex-col gap-px px-1 pb-1" role="list">
          <For each={props.entries}>
            {(entry) => (
              <div
                role="listitem"
                data-testid="source-control-row"
                data-path={entry.path}
                data-status={entry.status}
                data-group={props.id}
                class="claxedo-source-control-row group flex h-7 min-w-0 items-center gap-1 rounded-md pr-1 pl-1.5 text-12-medium text-text-weak hover:bg-surface-raised-base-hover"
                classList={{ "bg-surface-base-active": props.activePath === entry.path }}
              >
                <button
                  type="button"
                  data-slot="open"
                  class="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left"
                  onClick={() => props.onOpen(entry)}
                >
                  <span
                    class="w-3.5 shrink-0 text-center text-12-medium"
                    style={statusColor(entry.status)}
                    aria-label={language.t(STATUS_LABEL_KEY[entry.status])}
                    title={language.t(STATUS_LABEL_KEY[entry.status])}
                  >
                    {STATUS_LETTER[entry.status]}
                  </span>
                  <span class="flex min-w-0 flex-1 items-baseline gap-1.5">
                    <span class="min-w-0 truncate text-text-base">{getFilename(entry.path)}</span>
                    <Show when={getDirectory(entry.path).replace(/\/$/, "")}>
                      {(directory) => <span class="min-w-0 truncate text-11-regular text-text-weak/70">{directory()}</span>}
                    </Show>
                  </span>
                  <DiffChanges
                    class="shrink-0 text-11-regular"
                    changes={{ additions: entry.additions, deletions: entry.deletions }}
                  />
                </button>
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
              </div>
            )}
          </For>
        </div>
      </Show>
    </section>
  )
}
