import { Show, type JSX } from "solid-js"
import type { TaskChildSummary, TaskSummary } from "@claxedo/tasks"
import { useTranslator } from "@/i18n"
import { tasksDictionary } from "../i18n"
import { shortAge, taskDate, type TaskDateField } from "../model"

export type SubtaskProgress = TaskChildSummary

export function ProgressCell(props: { readonly progress?: SubtaskProgress; readonly class?: string }): JSX.Element {
  const t = useTranslator(tasksDictionary)
  return (
    <Show when={props.progress && props.progress.total > 0 ? props.progress : undefined}>
      {(progress) => (
        <span
          class={props.class ?? "tsk-cell"}
          title={t("tasks.row.subtasksDone", { done: progress().done, total: progress().total })}
        >
          {`${progress().done}/${progress().total}`}
        </span>
      )}
    </Show>
  )
}

export function SessionMark(props: { readonly task: TaskSummary; readonly class: string }): JSX.Element {
  const t = useTranslator(tasksDictionary)
  return (
    <Show when={props.task.links.count > 0}>
      <span class={props.class} role="img" aria-label={t("tasks.row.hasSession")} />
    </Show>
  )
}

export function AgeCell(props: {
  readonly task: TaskSummary
  readonly field: TaskDateField
  readonly now: number
  readonly class: string
}): JSX.Element {
  const t = useTranslator(tasksDictionary)
  const at = () => taskDate(props.task, props.field)
  const age = () => shortAge(at(), props.now)
  return (
    <span class={props.class} title={new Date(at()).toLocaleString()}>
      {t(age().key, { count: age().count })}
    </span>
  )
}
