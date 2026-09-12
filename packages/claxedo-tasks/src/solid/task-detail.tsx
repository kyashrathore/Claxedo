import { For, Show, type JSX } from "solid-js"
import {
  TASKS_BOUNDS,
  type ConfigurationSlot,
  type SessionReference,
  type TaskSessionLinkView,
  type TaskStatus,
} from "../contracts"
import { StatusMenu } from "./status-menu"
import { SLOT_LABELS, TASK_STATUS_LABELS, type TaskDetailView } from "./view-model"

export type TaskDetailEdit = {
  title: string
  description: string
}

export type TaskDetailProps = {
  view: TaskDetailView
  edit: TaskDetailEdit
  dirty: boolean
  busy?: boolean
  error?: string
  /** Set when the server refused an edit against a stale revision. */
  conflict?: string
  projectLabel: string
  onEditChange: (edit: TaskDetailEdit) => void
  onSave: () => void
  onDiscard: () => void
  onStatusChange: (input: { taskId: string; revision: number; status: TaskStatus }) => void
  onOpenSession: (sessionRef: SessionReference) => void
  onStart: (input: { slot: ConfigurationSlot; attempt: number }) => void
  /**
   * Hands the attempt's first message over again. Offered only where the host
   * reports the message absent from a live session, because a resend on any
   * weaker evidence would give the session a second copy of it.
   */
  onSendTask: (link: TaskSessionLinkView) => void
  onArchive: () => void
  onRestore: () => void
  /** The subtasks section, rendered by the caller so the detail owns no data fetch. */
  subtasks: JSX.Element
}

export function TaskDetail(props: TaskDetailProps) {
  const task = () => props.view.task
  const patch = (input: Partial<TaskDetailEdit>) => props.onEditChange({ ...props.edit, ...input })

  return (
    <article class="tsk tsk-stack" data-testid="task-detail" aria-label={task().title}>
      <input
        class="tsk-input tsk-title"
        data-testid="task-detail-title"
        aria-label="Task title"
        maxLength={TASKS_BOUNDS.taskTitleMax}
        value={props.edit.title}
        onInput={(event) => patch({ title: event.currentTarget.value })}
      />

      <textarea
        class="tsk-textarea"
        data-testid="task-detail-description"
        aria-label="Task description"
        placeholder="Add a description"
        value={props.edit.description}
        onInput={(event) => patch({ description: event.currentTarget.value })}
      />

      <Show when={props.conflict}>
        {(message) => (
          <p class="tsk-error" role="alert" data-testid="task-detail-conflict">
            {message()}
          </p>
        )}
      </Show>
      <Show when={props.error}>{(message) => <p class="tsk-error" role="alert">{message()}</p>}</Show>

      <Show when={props.dirty}>
        <div class="tsk-row" data-testid="task-detail-save-row">
          <button type="button" class="tsk-button" data-variant="primary" data-testid="task-detail-save" disabled={props.busy} onClick={() => props.onSave()}>
            Save
          </button>
          <button type="button" class="tsk-button" data-testid="task-detail-discard" onClick={() => props.onDiscard()}>
            Discard
          </button>
        </div>
      </Show>

      <section class="tsk-stack" aria-label="Properties">
        <h3 class="tsk-section-title">Properties</h3>
        <div class="tsk-toolbar">
          <StatusMenu
            status={task().status}
            disabled={props.busy || task().archivedAt !== null}
            label="Task status"
            testId="task-detail-status"
            onChange={(status) => props.onStatusChange({ taskId: task().id, revision: task().revision, status })}
          />
          <span class="tsk-muted">Project: {props.projectLabel}</span>
          <Show when={task().workspaceId}>{(workspaceId) => <span class="tsk-muted">Workspace: {workspaceId()}</span>}</Show>
          <Show
            when={task().archivedAt === null}
            fallback={
              <button type="button" class="tsk-button" data-testid="task-detail-restore" onClick={() => props.onRestore()}>
                Restore
              </button>
            }
          >
            <button type="button" class="tsk-button" data-testid="task-detail-archive" onClick={() => props.onArchive()}>
              Archive
            </button>
          </Show>
        </div>
      </section>

      {props.subtasks}

      <section class="tsk-stack" aria-label="Linked sessions">
        <h3 class="tsk-section-title">Linked sessions</h3>
        <Show
          when={props.view.configuredSlots.length > 0}
          fallback={<p class="tsk-muted">Choose a preset to see its configurations.</p>}
        >
          <For each={props.view.configuredSlots}>
            {(slot) => {
              const group = () => props.view.groups.find((entry) => entry.slot === slot)
              const current = () => group()?.current
              const live = () => {
                const link = current()
                return link?.liveness === "live" ? link : undefined
              }
              const unsent = () => {
                const link = live()
                return link?.handoff === "pending" ? link : undefined
              }
              const handoffNotice = () => {
                if (unsent()) return "Task not sent yet"
                return live()?.handoff === "unknown" ? "Delivery unknown" : undefined
              }
              return (
                <div class="tsk-surface tsk-stack tsk-panel" data-testid={`task-slot-${slot}`}>
                  <div class="tsk-row tsk-spread">
                    <strong>{SLOT_LABELS[slot]}</strong>
                    <div class="tsk-row">
                      <Show when={current()?.liveness === "live"}>
                        <button
                          type="button"
                          class="tsk-button"
                          data-variant="primary"
                          data-testid={`task-slot-open-${slot}`}
                          onClick={() => {
                            const link = current()
                            if (link) props.onOpenSession(link.sessionRef)
                          }}
                        >
                          Open
                        </button>
                      </Show>
                      <Show when={handoffNotice()}>
                        {(notice) => (
                          <span class="tsk-muted" data-testid={`task-slot-handoff-${slot}`}>
                            {notice()}
                          </span>
                        )}
                      </Show>
                      <Show when={unsent()}>
                        {(link) => (
                          <button
                            type="button"
                            class="tsk-button"
                            data-testid={`task-slot-send-${slot}`}
                            disabled={props.busy || task().archivedAt !== null}
                            onClick={() => props.onSendTask(link())}
                          >
                            Send task
                          </button>
                        )}
                      </Show>
                      <Show when={current() === undefined}>
                        <button
                          type="button"
                          class="tsk-button"
                          data-testid={`task-slot-start-${slot}`}
                          disabled={task().archivedAt !== null}
                          onClick={() => props.onStart({ slot, attempt: 1 })}
                        >
                          Start
                        </button>
                      </Show>
                      <Show when={current() && current()?.liveness !== "live"}>
                        <button
                          type="button"
                          class="tsk-button"
                          data-testid={`task-slot-start-again-${slot}`}
                          disabled={task().archivedAt !== null}
                          onClick={() => props.onStart({ slot, attempt: (current()?.attempt ?? 0) + 1 })}
                        >
                          Start again
                        </button>
                      </Show>
                    </div>
                  </div>
                  <For each={group()?.attempts ?? []} fallback={<p class="tsk-muted">No session yet.</p>}>
                    {(link) => (
                      <div class="tsk-attempt" data-testid={`task-slot-attempt-${slot}-${link.attempt}`}>
                        <span class="tsk-item-title">
                          Attempt {link.attempt} — {link.presetNameAtStart}
                        </span>
                        <span class="tsk-muted" data-testid={`task-slot-liveness-${slot}-${link.attempt}`}>
                          {link.liveness}
                        </span>
                        <Show when={link.continuedFrom}>
                          <span class="tsk-muted">continued</span>
                        </Show>
                        <Show when={link.liveness !== "deleted"}>
                          <button
                            type="button"
                            class="tsk-button"
                            data-testid={`task-slot-open-attempt-${slot}-${link.attempt}`}
                            onClick={() => props.onOpenSession(link.sessionRef)}
                          >
                            Open
                          </button>
                        </Show>
                      </div>
                    )}
                  </For>
                </div>
              )
            }}
          </For>
        </Show>
      </section>

      <p class="tsk-muted">Status is manual: {TASK_STATUS_LABELS[task().status]} until you change it.</p>
    </article>
  )
}
