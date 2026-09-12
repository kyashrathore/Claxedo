import { Show, createMemo, createSignal } from "solid-js"
import { CONFIGURATION_SLOTS, type ConfigurationSlot, type Task, type TaskStatus } from "@claxedo/tasks"
import { TaskDetail, TaskSubtasks, groupLinksBySlot } from "@claxedo/tasks/solid"
import { uuid } from "@/lib/uuid"
import { useTasksAppPorts } from "../app-ports"
import { refusalOf } from "../data/tasks-api"
import { useTaskChildren, useTaskDetail, useTasksClient, useTasksInvalidation, type TasksScope } from "../data/queries"
import type { TasksStore } from "../store/tasks-store"

export type TaskDetailPanelProps = {
  store: TasksStore
  scope: () => TasksScope
  taskId: string
  onStart: (input: { task: Task; slot: ConfigurationSlot; attempt: number }) => void
  onOpenTask: (taskId: string) => void
}

export function TaskDetailPanel(props: TaskDetailPanelProps) {
  const ports = useTasksAppPorts()
  const projects = ports.useProjects()
  const openSession = ports.useOpenSession()
  const client = useTasksClient()
  const invalidate = useTasksInvalidation(props.scope)
  const detail = useTaskDetail(props.scope, () => props.taskId)
  const children = useTaskChildren(props.scope, () => props.taskId)
  const [busy, setBusy] = createSignal(false)

  const task = () => detail.data?.task
  const groups = createMemo(() => groupLinksBySlot(detail.data?.links ?? []))

  const mutate = async (run: () => Promise<unknown>, taskId: string) => {
    setBusy(true)
    try {
      await run()
      await invalidate.everything()
      invalidate.task(taskId)
      props.store.taskSaved(taskId)
    } catch (error) {
      props.store.refuseTaskEdit(taskId, refusalOf(error))
    } finally {
      setBusy(false)
    }
  }

  const setStatus = (input: { taskId: string; revision: number; status: TaskStatus }) =>
    void mutate(() => client().command({ clientRequestId: uuid(), command: { type: "task.set_status", input } }), input.taskId)

  return (
    <Show when={task()} fallback={<p class="tsk-empty">Select a task.</p>}>
      {(current) => {
        const draft = () => props.store.editDraft(current())
        return (
          <TaskDetail
            view={{
              task: current(),
              children: children.items(),
              groups: groups(),
              // Every slot the host has ever linked, plus Primary, which is
              // always offerable. Slots a preset does not configure are refused
              // at preview rather than hidden from a task that already used one.
              configuredSlots: CONFIGURATION_SLOTS.filter(
                (slot) => slot === "primary" || groups().some((group) => group.slot === slot),
              ),
            }}
            edit={{ title: draft().title, description: draft().description }}
            dirty={props.store.editDirty(current())}
            busy={busy()}
            error={props.store.state.taskErrors[current().id]}
            conflict={props.store.state.taskConflicts[current().id]}
            projectLabel={projects().find((project) => project.id === current().projectId)?.label ?? current().projectId}
            onEditChange={(edit) =>
              props.store.setEditDraft(current().id, { title: edit.title, description: edit.description, revision: draft().revision })
            }
            onSave={() =>
              void mutate(
                () =>
                  client().command({
                    clientRequestId: uuid(),
                    command: {
                      type: "task.edit",
                      input: {
                        taskId: current().id,
                        revision: draft().revision,
                        title: draft().title,
                        description: draft().description,
                        workspaceId: current().workspaceId,
                      },
                    },
                  }),
                current().id,
              )
            }
            onDiscard={() => props.store.discardEdit(current().id)}
            onStatusChange={setStatus}
            onOpenSession={(session) => openSession(session)}
            onStart={(input) => props.onStart({ task: current(), slot: input.slot, attempt: input.attempt })}
            onArchive={() =>
              void mutate(
                () =>
                  client().command({
                    clientRequestId: uuid(),
                    command: { type: "task.archive", input: { taskId: current().id, revision: draft().revision } },
                  }),
                current().id,
              )
            }
            onRestore={() =>
              void mutate(
                () =>
                  client().command({
                    clientRequestId: uuid(),
                    command: { type: "task.restore", input: { taskId: current().id, revision: draft().revision } },
                  }),
                current().id,
              )
            }
            subtasks={
              <TaskSubtasks
                items={children.items()}
                canAdd={current().parentTaskId === null && current().status !== "done" && current().archivedAt === null}
                addDisabledReason={
                  current().parentTaskId === null
                    ? "Reopen this task to add a subtask."
                    : "Subtasks are one level deep."
                }
                busy={busy()}
                error={props.store.state.taskErrors[current().id]}
                onOpen={(taskId) => props.onOpenTask(taskId)}
                onAdd={(title) =>
                  void mutate(
                    () =>
                      client().command({
                        clientRequestId: uuid(),
                        command: {
                          type: "task.create",
                          input: {
                            projectId: current().projectId,
                            title,
                            description: "",
                            workspaceId: current().workspaceId,
                            parentTaskId: current().id,
                          },
                        },
                      }),
                    current().id,
                  )
                }
                onStatusChange={setStatus}
              />
            }
          />
        )
      }}
    </Show>
  )
}
