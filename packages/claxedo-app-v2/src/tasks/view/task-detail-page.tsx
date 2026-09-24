import { Show, createMemo, type JSX } from "solid-js"
import { CONFIGURATION_SLOTS, type ConfigurationSlot, type Task } from "@claxedo/tasks"
import { useTranslator } from "@/i18n"
import { followRetry, useTaskChildren, useTaskDetail, useTasksApi } from "../data/queries"
import { useTaskStartOffers } from "../data/start"
import { dictionary } from "../i18n"
import { useOpenTaskSession, useTaskProjects } from "../links"
import { groupLinksBySlot, slotAttempt } from "../model"
import type { TasksStore } from "../store"
import { createSendTask, createTaskCommands } from "./task-commands"
import { TaskAttachmentGallery } from "./task-attachments"
import { TaskDetail } from "./task-detail"
import { TaskSubtasks } from "./task-subtasks"

type TaskDetailPageProps = {
  readonly store: TasksStore
  readonly taskId: string
  readonly onOpenTask: (taskId: string) => void
  readonly onBack: () => void
  readonly onOpenProject: (projectId: string) => void
}

function createDetailData(props: TaskDetailPageProps) {
  const t = useTranslator(dictionary)
  const detail = useTaskDetail(() => props.taskId)
  const children = useTaskChildren(() => props.taskId)
  const parent = useTaskDetail(() => detail.data?.task.parentTaskId ?? undefined)
  const offers = useTaskStartOffers(props.store)
  const groups = createMemo(() => groupLinksBySlot(detail.data?.links ?? []))
  const startOffer = (current: Task) => (slot: ConfigurationSlot) => {
    const next = slotAttempt(groups(), slot)
    const continueWith = next.again && next.current?.liveness !== "deleted" ? next.current?.presetId : undefined
    return offers.offerFor(current, { slot, startLabel: next.again ? t("tasks.start.again") : undefined, continueWith })
  }
  return { detail, children, parent, offers, groups, startOffer }
}

function DetailSubtasks(props: {
  readonly task: Task
  readonly data: ReturnType<typeof createDetailData>
  readonly page: TaskDetailPageProps
  readonly commands: ReturnType<typeof createTaskCommands>
}): JSX.Element {
  return (
    <TaskSubtasks
      items={props.data.children.items()}
      canAdd={props.task.status !== "done" && props.task.archivedAt === null}
      busy={props.data.offers.busyTaskId() === props.task.id}
      error={props.page.store.state.taskErrors[props.task.id]}
      more={followRetry(props.data.children)}
      onOpen={props.page.onOpenTask}
      onAdd={(title) => props.commands.addSubtask(props.task, title)}
      onStatusChange={props.commands.setStatus}
    />
  )
}

type Loaded = {
  readonly task: Task
  readonly page: TaskDetailPageProps
  readonly data: ReturnType<typeof createDetailData>
  readonly commands: ReturnType<typeof createTaskCommands>
  readonly sending: ReturnType<typeof createSendTask>
  readonly busy: boolean
}

function LoadedTask(props: Loaded): JSX.Element {
  const api = useTasksApi()
  const projects = useTaskProjects()
  const openSession = useOpenTaskSession()
  const store = () => props.page.store
  const task = () => props.task
  const draft = () => store().editDraft(task())
  const slots = () =>
    CONFIGURATION_SLOTS.filter((slot) => slot === "primary" || props.data.groups().some((group) => group.slot === slot))
  const parent = () => props.data.parent.data?.task
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "s" || !(event.metaKey || event.ctrlKey) || event.altKey) return
    if (!store().editDirty(task()) || props.busy) return
    event.preventDefault()
    props.commands.save(task())
  }
  return (
    <div class="contents" onKeyDown={onKeyDown}>
      <TaskDetail
        view={{
          task: task(),
          ...(parent() ? { parent: parent() } : {}),
          groups: props.data.groups(),
          configuredSlots: slots(),
        }}
        edit={{ title: draft().title, description: draft().description }}
        dirty={store().editDirty(task())}
        busy={props.busy}
        error={props.sending.error() ?? store().state.taskErrors[task().id]}
        conflict={store().state.taskConflicts[task().id]}
        projectLabel={projects().find((project) => project.id === task().projectId)?.label ?? task().projectId}
        onEditChange={(edit) => store().setEditDraft(task().id, { ...edit, revision: draft().revision })}
        onSave={() => props.commands.save(task())}
        onDiscard={() => store().discardEdit(task().id)}
        onStatusChange={props.commands.setStatus}
        onOpenSession={openSession}
        startOffer={props.data.startOffer(task())}
        onSendTask={(link) => void props.sending.send(task(), link)}
        onBack={props.page.onBack}
        onOpenProject={() => props.page.onOpenProject(task().projectId)}
        railCollapsed={store().state.railCollapsed}
        onToggleRail={() => store().toggleRail()}
        onOpenParent={task().parentTaskId ? () => props.page.onOpenTask(task().parentTaskId ?? "") : undefined}
        onArchive={() => props.commands.archive(task())}
        onRestore={() => props.commands.restore(task())}
        attachments={
          <TaskAttachmentGallery
            attachments={props.data.detail.data?.attachments ?? []}
            read={(id) => api.client.readAttachment(task().id, id)}
          />
        }
        subtasks={
          task().parentTaskId !== null ? undefined : (
            <DetailSubtasks task={task()} data={props.data} page={props.page} commands={props.commands} />
          )
        }
      />
    </div>
  )
}

export function TaskDetailPage(props: TaskDetailPageProps): JSX.Element {
  const t = useTranslator(dictionary)
  const data = createDetailData(props)
  const commands = createTaskCommands(props.store, data.offers.busyWhile)
  const sending = createSendTask(data.offers.busyWhile)
  const busy = () => data.offers.busyTaskId() === props.taskId
  return (
    <div class="tsk tsk-root" data-testid="task-detail-page">
      <Show when={data.detail.data?.task} fallback={<p class="tsk-empty">{t("tasks.detail.select")}</p>}>
        {(task) => (
          <LoadedTask task={task()} page={props} data={data} commands={commands} sending={sending} busy={busy()} />
        )}
      </Show>
    </div>
  )
}
