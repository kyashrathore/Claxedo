import { Show, createMemo, createSignal } from "solid-js"
import {
  CONFIGURATION_SLOTS,
  type ConfigurationSlot,
  type Task,
  type TaskSessionLinkView,
  type TaskStatus,
} from "@claxedo/tasks"
import { groupLinksBySlot, slotAttempt } from "../../view-model"
import { TaskAttachmentGallery } from "./task-attachments"
import { TaskDetail } from "./task-detail"
import { TaskSubtasks } from "./task-subtasks"
import { uuid } from "@/lib/uuid"
import { useTasksAppPorts } from "../../app-ports"
import { refusalOf } from "../../data/tasks-api"
import { followRetry, useTaskChildren, useTaskDetail, useTasksClient, useTasksInvalidation, type TasksScope } from "../../data/queries"
import { useTaskStartOffers } from "../../data/start-task"
import type { TasksStore } from "../../store/tasks-store"

export type TaskDetailPageProps = {
  store: TasksStore
  scope: () => TasksScope
  taskId: string
  onOpenTask: (taskId: string) => void
  onBack: () => void
  onOpenProject: (projectId: string) => void
}

/** `/tasks/<taskId>`: the task as its own page, and the reads behind it. */
export function TaskDetailPage(props: TaskDetailPageProps) {
  const ports = useTasksAppPorts()
  const projects = ports.useProjects()
  const openSession = ports.useOpenSession()
  const client = useTasksClient()
  const invalidate = useTasksInvalidation(props.scope)
  const detail = useTaskDetail(props.scope, () => props.taskId)
  const children = useTaskChildren(props.scope, () => props.taskId)
  // A subtask names its parent, which only the parent's own read can title.
  // Disabled for a top-level task, so a page that has no parent asks for none.
  const parent = useTaskDetail(props.scope, () => detail.data?.task.parentTaskId ?? undefined)
  const offers = useTaskStartOffers(props.scope, props.store)
  const [sendError, setSendError] = createSignal<string | undefined>()

  const task = () => detail.data?.task
  const groups = createMemo(() => groupLinksBySlot(detail.data?.links ?? []))
  const busy = () => offers.busyTaskId() === props.taskId

  /**
   * A slot's Start control. The word on it and whether a continue is offered
   * both come from what the slot's current link says, which is the same rule
   * the rows above it are drawn from.
   */
  const startOffer = (current: Task) => (slot: ConfigurationSlot) => {
    const next = slotAttempt(groups(), slot)
    return offers.offerFor(current, {
      slot,
      startLabel: next.again ? "Start again" : undefined,
      // A session the owner reports deleted carries nothing over, and the
      // service refuses to continue from one.
      continueWith: next.again && next.current?.liveness !== "deleted" ? next.current?.presetId : undefined,
    })
  }

  const mutate = (run: () => Promise<unknown>, taskId: string) =>
    offers.busyWhile(taskId, async () => {
      try {
        await run()
        await invalidate.afterCommand(taskId)
        props.store.taskSaved(taskId)
      } catch (error) {
        props.store.refuseTaskEdit(taskId, refusalOf(error))
      }
    })

  const setStatus = (input: { taskId: string; revision: number; status: TaskStatus }) =>
    void mutate(() => client().command({ clientRequestId: uuid(), command: { type: "task.set_status", input } }), input.taskId)

  /**
   * The attempt's first message, handed over again after a Start that linked
   * the session but never delivered it.
   *
   * The request names the attempt the slot already holds, which the server
   * answers from the stored link: it submits the text persisted at Start, so
   * none is sent here, and it creates nothing. The preview is taken only
   * because the route requires a digest — the recovery itself does not read it.
   *
   * The refusal stays in a signal of its own rather than the store's edit
   * channel: a Send neither saves nor rebases what the user has typed.
   */
  const sendTask = (current: Task, link: TaskSessionLinkView) =>
    offers.busyWhile(current.id, async () => {
      const request = {
        taskRevision: current.revision,
        presetId: link.presetId,
        presetRevision: link.presetRevision,
        slot: link.slot,
        attempt: link.attempt,
        continueFromPrevious: false,
      }
      setSendError(undefined)
      try {
        const previewed = await client().startPreview(current.id, request)
        await client().start(current.id, {
          ...request,
          clientRequestId: uuid(),
          previewDigest: previewed.preview.digest,
          handoffText: null,
        })
      } catch (error) {
        setSendError(refusalOf(error).message)
      } finally {
        await invalidate.afterCommand(current.id)
      }
    })

  return (
    <div class="tsk tsk-root" data-testid="task-detail-page">
      <Show when={task()} fallback={<p class="tsk-empty">Select a task.</p>}>
      {(current) => {
        const draft = () => props.store.editDraft(current())
        return (
          <TaskDetail
            view={{
              task: current(),
              ...(parent.data?.task ? { parent: { id: parent.data.task.id, title: parent.data.task.title } } : {}),
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
            error={sendError() ?? props.store.state.taskErrors[current().id]}
            conflict={props.store.state.taskConflicts[current().id]}
            proseEditor={ports.ProseEditor}
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
            startOffer={startOffer(current())}
            onSendTask={(link) => void sendTask(current(), link)}
            onBack={props.onBack}
            onOpenProject={() => props.onOpenProject(current().projectId)}
            onOpenParent={
              current().parentTaskId ? () => props.onOpenTask(current().parentTaskId!) : undefined
            }
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
            attachments={
              <TaskAttachmentGallery
                attachments={detail.data?.attachments ?? []}
                read={(attachmentId) => client().readAttachment(current().id, attachmentId)}
              />
            }
            // Absent on a subtask: subtasks are one level deep, so there is no
            // section to show rather than a section that explains itself away.
            subtasks={
              current().parentTaskId !== null ? undefined : (
              <TaskSubtasks
                items={children.items()}
                canAdd={current().status !== "done" && current().archivedAt === null}
                busy={busy()}
                error={props.store.state.taskErrors[current().id]}
                more={followRetry(children)}
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
              )
            }
          />
        )
      }}
      </Show>
    </div>
  )
}
