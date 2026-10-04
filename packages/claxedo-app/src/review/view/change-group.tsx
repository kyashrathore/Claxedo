import { For, Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { ClaxedoIcon as Icon, SemanticIcon, Spinner } from "@/ui"
import type { GitAction } from "../git-actions"
import { reviewDictionary } from "../i18n"
import { ChangeRow, type ChangeEntry } from "./change-row"

type ChangeGroupId = "staged" | "changes"

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
      class="claxedo-source-control-header group flex h-7 shrink-0 items-center gap-1 pr-2 pl-2"
    >
      <button
        type="button"
        aria-expanded={!props.collapsed}
        class="sidebar-section-label flex min-w-0 flex-1 items-center gap-1.5 text-left transition-colors duration-100 hover:text-text-base"
        classList={{ "text-text-base": props.active }}
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
          <span class="tabular-nums text-text-weaker">{props.count}</span>
        </Show>
      </button>
      {props.children}
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
  const t = useTranslator(reviewDictionary)
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
