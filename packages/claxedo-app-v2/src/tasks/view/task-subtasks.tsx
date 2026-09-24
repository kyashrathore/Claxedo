import { For, Show, createMemo, createSignal, type JSX } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { TextField } from "@opencode-ai/ui/text-field"
import { TASKS_BOUNDS, type TaskStatus, type TaskSummary } from "@claxedo/tasks"
import { useTranslator } from "@/i18n"
import { Button } from "@/ui"
import type { MorePages } from "../data/queries"
import { dictionary } from "../i18n"
import { LoadMore } from "./load-more"
import { StatusControl } from "./status-control"

type StatusChange = (input: { taskId: string; revision: number; status: TaskStatus }) => void

export type TaskSubtasksProps = {
  readonly items: readonly TaskSummary[]
  readonly canAdd: boolean
  readonly busy?: boolean
  readonly error?: string
  readonly more?: MorePages
  readonly onOpen: (taskId: string) => void
  readonly onAdd: (title: string) => void
  readonly onStatusChange: StatusChange
}

function SubtaskRow(props: { readonly child: TaskSummary; readonly list: TaskSubtasksProps }): JSX.Element {
  const t = useTranslator(dictionary)
  return (
    <div class="tsk-subtask">
      <button
        type="button"
        class="tsk-subtask-open"
        data-done={props.child.status === "done" ? "true" : undefined}
        data-testid={`task-subtask-${props.child.id}`}
        onClick={() => props.list.onOpen(props.child.id)}
      >
        {props.child.title}
      </button>
      <Show when={props.child.archivedAt === null} fallback={<span class="tsk-cell">{t("tasks.archived")}</span>}>
        <StatusControl
          status={props.child.status}
          disabled={props.list.busy}
          label={t("tasks.row.statusOf", { title: props.child.title })}
          testId={`task-subtask-status-${props.child.id}`}
          onChange={(status) =>
            props.list.onStatusChange({ taskId: props.child.id, revision: props.child.revision, status })
          }
        />
      </Show>
    </div>
  )
}

function AddSubtask(props: { readonly busy?: boolean; readonly onAdd: (title: string) => void }): JSX.Element {
  const t = useTranslator(dictionary)
  const [title, setTitle] = createSignal("")
  const [adding, setAdding] = createSignal(false)
  const submit = () => {
    const value = title().trim()
    if (!value) return
    props.onAdd(value)
    setTitle("")
  }
  return (
    <Show
      when={adding()}
      fallback={
        <button
          type="button"
          class="tsk-add-trigger"
          data-testid="task-subtask-add-trigger"
          onClick={() => setAdding(true)}
        >
          <Icon name="plus-small" size="small" />
          {t("tasks.subtasks.add")}
        </button>
      }
    >
      <form
        class="tsk-add"
        data-testid="task-subtask-add"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <TextField
          ref={(element: HTMLInputElement) => queueMicrotask(() => element.focus())}
          data-testid="task-subtask-title"
          aria-label={t("tasks.subtasks.title")}
          maxLength={TASKS_BOUNDS.taskTitleMax}
          placeholder={t("tasks.subtasks.placeholder")}
          value={title()}
          onChange={setTitle}
          onKeyDown={(event: KeyboardEvent) => {
            if (event.key !== "Escape") return
            event.stopPropagation()
            setTitle("")
            setAdding(false)
          }}
        />
        <Button type="submit" size="small" disabled={props.busy || title().trim().length === 0}>
          {t("tasks.subtasks.addButton")}
        </Button>
      </form>
    </Show>
  )
}

export function TaskSubtasks(props: TaskSubtasksProps): JSX.Element {
  const t = useTranslator(dictionary)
  const done = createMemo(() => props.items.filter((child) => child.status === "done").length)
  return (
    <section class="tsk-subtasks" data-testid="task-subtasks" aria-label={t("tasks.subtasks")}>
      <div class="tsk-subtasks-head">
        <h3 class="tsk-section-title">{t("tasks.subtasks")}</h3>
        <Show when={props.items.length > 0}>
          <span class="tsk-count">
            {done()}/{props.items.length}
          </span>
        </Show>
      </div>
      <For each={props.items}>{(child) => <SubtaskRow child={child} list={props} />}</For>
      <LoadMore more={props.more} testId="task-subtasks-load-more" />
      <Show when={props.canAdd} fallback={<p class="tsk-hint">{t("tasks.subtasks.reopen")}</p>}>
        <AddSubtask busy={props.busy} onAdd={props.onAdd} />
      </Show>
      <Show when={props.error}>{(message) => <p class="tsk-error">{message()}</p>}</Show>
    </section>
  )
}
