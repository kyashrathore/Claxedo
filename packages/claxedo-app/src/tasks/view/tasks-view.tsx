import { Show, createMemo, type JSX } from "solid-js"
import type { TaskCreateStatus, TaskSummary } from "@claxedo/tasks"
import { useTranslator } from "@/i18n"
import { Button, useDialog } from "@/ui"
import { morePages, useTaskList } from "../data/queries"
import { refusalOf, type TaskListFilter } from "../data/refusal"
import { useTaskStartOffers } from "../data/start"
import { tasksDictionary } from "../i18n"
import { useTaskProjects } from "../links"
import { TASK_COLLECTION_KEYS, TASK_COLLECTION_STATUSES } from "../model"
import type { TasksStore } from "../store"
import { DialogCreateTask } from "./create-task-dialog"
import { TaskBoard } from "./task-board"
import { createTaskCommands } from "./task-commands"
import { TaskList } from "./task-list"
import { TasksHeader } from "./tasks-header"
import { TasksToolbar } from "./tasks-toolbar"

type TasksViewProps = {
  readonly store: TasksStore
  readonly projectId: () => string
  readonly onOpenTask: (taskId: string) => void
}

function createTaskRows(props: TasksViewProps) {
  const filter = createMemo<TaskListFilter | undefined>(() => {
    const projectId = props.projectId()
    if (!projectId) return undefined
    const state = props.store.state
    return {
      projectId,
      status: state.statusFilter,
      parent: state.showChildren ? "any" : "root",
      includeArchived: state.collection === "all",
    }
  })
  const tasks = useTaskList(filter)
  const visible = createMemo(() => props.store.visibleTasks(tasks.items()))
  const titleById = createMemo(() => new Map(visible().map((task) => [task.id, task.title])))
  return {
    tasks,
    visible,
    parentTitleOf: (task: TaskSummary) => (task.parentTaskId === null ? undefined : titleById().get(task.parentTaskId)),
    subtaskProgress: (taskId: string) => visible().find((task) => task.id === taskId)?.children,
  }
}

export function TasksView(props: TasksViewProps): JSX.Element {
  const t = useTranslator(tasksDictionary)
  const projects = useTaskProjects()
  const dialog = useDialog()
  const offers = useTaskStartOffers(props.store)
  const rows = createTaskRows(props)
  const commands = createTaskCommands(props.store, offers.busyWhile)
  const startOffer = (task: TaskSummary) =>
    offers.offerFor(task, { onOpen: task.links.count > 0 ? () => void offers.openLatestSession(task.id) : undefined })
  const openCreate = (status?: TaskCreateStatus) =>
    void dialog.show(() => (
      <DialogCreateTask
        projectId={props.projectId()}
        status={status}
        onClose={() => dialog.close()}
        onCreated={(taskId) => props.onOpenTask(taskId)}
      />
    ))
  const projectName = () => projects().find((entry) => entry.id === props.projectId())?.label ?? ""
  const shared = () => ({
    tasks: rows.visible(),
    projectName: projectName(),
    dateField: props.store.state.dateField,
    more: morePages(rows.tasks),
    subtaskProgress: rows.subtaskProgress,
    startOffer,
    busyTaskId: offers.busyTaskId(),
    onSelect: props.onOpenTask,
    onStatusChange: commands.setStatus,
  })
  return (
    <div class="tsk tsk-root" data-testid="tasks-view">
      <TasksHeader
        title={t("tasks.title")}
        count={rows.visible().length}
        action={
          <Button variant="contrast" size="small" data-testid="tasks-create" onClick={() => openCreate()}>
            {t("tasks.newTask")}
          </Button>
        }
      />
      <TasksToolbar store={props.store} projects={projects()} projectId={props.projectId()} />
      <Show when={rows.tasks.error()}>
        {(error) => (
          <p class="tsk-error tsk-inset" role="alert">
            {refusalOf(error()).message}
          </p>
        )}
      </Show>
      <Show
        when={props.store.state.view === "board"}
        fallback={
          <TaskList
            {...shared()}
            loading={rows.tasks.pending()}
            grouped={props.store.state.grouped}
            emptyLabel={t("tasks.list.nothingIn", {
              collection: t(TASK_COLLECTION_KEYS[props.store.state.collection]),
            })}
            parentTitleOf={rows.parentTitleOf}
            onCreate={() => openCreate()}
          />
        }
      >
        <TaskBoard
          {...shared()}
          statuses={TASK_COLLECTION_STATUSES[props.store.state.collection]}
          onCreate={openCreate}
        />
      </Show>
    </div>
  )
}
