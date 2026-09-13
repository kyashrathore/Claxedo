import { For, Show, type JSX } from "solid-js"
import {
  TASKS_BOUNDS,
  type ConfigurationSlot,
  type SessionReference,
  type TaskSessionLinkView,
  type TaskStatus,
} from "../contracts"
import { StatusMenu } from "./status-menu"
import { SLOT_LABELS, TASK_STATUS_LABELS, type TaskDetailView, type TaskLinkGroup } from "./view-model"

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
  /** Absent where the detail is not a page of its own. */
  onBack?: () => void
  /** Opens the task list filtered to this task's project. */
  onOpenProject?: () => void
  /** Opens the task this one is a subtask of. */
  onOpenParent?: () => void
  /**
   * The subtasks section, rendered by the caller so the detail owns no data
   * fetch. Absent on a subtask, which cannot have children of its own.
   */
  subtasks?: JSX.Element
}

export function TaskDetail(props: TaskDetailProps) {
  const task = () => props.view.task
  const patch = (input: Partial<TaskDetailEdit>) => props.onEditChange({ ...props.edit, ...input })

  return (
    <article class="tsk tsk-detail" data-testid="task-detail" aria-label={task().title}>
      <div class="tsk-detail-main">
        <nav class="tsk-crumbs" aria-label="Breadcrumb">
          <Show when={props.onBack} fallback={<span>Tasks</span>}>
            {(back) => (
              <button type="button" class="tsk-crumb-link" data-testid="task-detail-back" onClick={() => back()()}>
                Tasks
              </button>
            )}
          </Show>
          <span class="tsk-crumb-sep" aria-hidden="true">›</span>
          <Show when={props.onOpenProject} fallback={<span>{props.projectLabel}</span>}>
            {(open) => (
              <button
                type="button"
                class="tsk-crumb-link"
                data-testid="task-detail-project-crumb"
                onClick={() => open()()}
              >
                {props.projectLabel}
              </button>
            )}
          </Show>
          <Show when={props.view.parent}>
            {(parent) => (
              <>
                <span class="tsk-crumb-sep" aria-hidden="true">›</span>
                <Show when={props.onOpenParent} fallback={<span>{parent().title}</span>}>
                  {(open) => (
                    <button
                      type="button"
                      class="tsk-crumb-link"
                      data-testid="task-detail-parent-crumb"
                      onClick={() => open()()}
                    >
                      {parent().title}
                    </button>
                  )}
                </Show>
              </>
            )}
          </Show>
          <span class="tsk-crumb-sep" aria-hidden="true">›</span>
          <span class="tsk-crumb-current">{task().title}</span>
        </nav>

        <Show when={props.view.parent}>
          {(parent) => (
            <button
              type="button"
              class="tsk-parent-tag"
              data-testid="task-detail-parent-tag"
              disabled={!props.onOpenParent}
              onClick={() => props.onOpenParent?.()}
            >
              Subtask of <span class="tsk-truncate">{parent().title}</span>
            </button>
          )}
        </Show>

        <input
          class="tsk-bare-title"
          data-testid="task-detail-title"
          aria-label="Task title"
          placeholder="Untitled task"
          maxLength={TASKS_BOUNDS.taskTitleMax}
          value={props.edit.title}
          onInput={(event) => patch({ title: event.currentTarget.value })}
        />

        <textarea
          class="tsk-bare-text"
          data-testid="task-detail-description"
          aria-label="Task description"
          placeholder="Add a description…"
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
          <div class="tsk-savebar" data-testid="task-detail-save-row">
            <span class="tsk-hint tsk-spacer">Unsaved changes</span>
            <button type="button" class="tsk-button" data-testid="task-detail-discard" onClick={() => props.onDiscard()}>
              Discard
            </button>
            <button
              type="button"
              class="tsk-button"
              data-variant="primary"
              data-testid="task-detail-save"
              disabled={props.busy}
              onClick={() => props.onSave()}
            >
              Save
            </button>
          </div>
        </Show>

        <Show when={props.subtasks}>
          {(section) => (
            <>
              <div class="tsk-divider" />
              {section()}
            </>
          )}
        </Show>
      </div>

      <aside class="tsk-rail">
        <section class="tsk-stack" aria-label="Properties">
          <h3 class="tsk-section-title">Properties</h3>
          <dl class="tsk-props">
            <dt>Status</dt>
            <dd>
              <StatusMenu
                status={task().status}
                disabled={props.busy || task().archivedAt !== null}
                label="Task status"
                testId="task-detail-status"
                onChange={(status) => props.onStatusChange({ taskId: task().id, revision: task().revision, status })}
              />
            </dd>
            <dt>Project</dt>
            <dd>{props.projectLabel}</dd>
            <Show when={task().workspaceId}>
              {(workspaceId) => (
                <>
                  <dt>Workspace</dt>
                  <dd>{workspaceId()}</dd>
                </>
              )}
            </Show>
          </dl>
          <p class="tsk-hint">Status is manual: {TASK_STATUS_LABELS[task().status]} until you change it.</p>
        </section>

        <section class="tsk-stack" aria-label="Linked sessions">
          <h3 class="tsk-section-title">Sessions</h3>
          <Show
            when={props.view.configuredSlots.length > 0}
            fallback={<p class="tsk-hint">Choose a preset to see its configurations.</p>}
          >
            <For each={props.view.configuredSlots}>
              {(slot) => (
                <SlotCard
                  slot={slot}
                  group={props.view.groups.find((entry) => entry.slot === slot)}
                  archived={task().archivedAt !== null}
                  busy={props.busy}
                  onOpenSession={props.onOpenSession}
                  onStart={props.onStart}
                  onSendTask={props.onSendTask}
                />
              )}
            </For>
          </Show>
        </section>

        <Show
          when={task().archivedAt === null}
          fallback={
            <button type="button" class="tsk-button" data-testid="task-detail-restore" onClick={() => props.onRestore()}>
              Restore this task
            </button>
          }
        >
          <button
            type="button"
            class="tsk-button"
            data-variant="danger"
            data-testid="task-detail-archive"
            onClick={() => props.onArchive()}
          >
            Archive this task
          </button>
        </Show>
      </aside>
    </article>
  )
}

function SlotCard(props: {
  slot: ConfigurationSlot
  group: TaskLinkGroup | undefined
  archived: boolean
  busy?: boolean
  onOpenSession: (sessionRef: SessionReference) => void
  onStart: (input: { slot: ConfigurationSlot; attempt: number }) => void
  onSendTask: (link: TaskSessionLinkView) => void
}) {
  const current = () => props.group?.current
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
    <div class="tsk-slot" data-testid={`task-slot-${props.slot}`}>
      <div class="tsk-row tsk-spread">
        <strong class="tsk-label">{SLOT_LABELS[props.slot]}</strong>
        <Show when={current()}>
          {(link) => <span class="tsk-dot" data-liveness={link().liveness} aria-hidden="true" />}
        </Show>
      </div>

      <For each={props.group?.attempts ?? []} fallback={<p class="tsk-hint">No session yet.</p>}>
        {(link) => (
          <div class="tsk-attempt" data-testid={`task-slot-attempt-${props.slot}-${link.attempt}`}>
            <span class="tsk-attempt-no">#{link.attempt}</span>
            <span class="tsk-truncate">{link.presetNameAtStart}</span>
            <span data-testid={`task-slot-liveness-${props.slot}-${link.attempt}`}>
              {link.liveness}
            </span>
            <Show when={link.continuedFrom}>
              <span>continued</span>
            </Show>
            <Show when={link.liveness !== "deleted"}>
              <button
                type="button"
                class="tsk-button"
                data-variant="quiet"
                data-testid={`task-slot-open-attempt-${props.slot}-${link.attempt}`}
                onClick={() => props.onOpenSession(link.sessionRef)}
              >
                Open
              </button>
            </Show>
          </div>
        )}
      </For>

      <Show when={handoffNotice()}>
        {(notice) => (
          <span class="tsk-notice" data-testid={`task-slot-handoff-${props.slot}`}>
            {notice()}
          </span>
        )}
      </Show>

      <Show when={current()?.liveness === "live"}>
        <button
          type="button"
          class="tsk-button"
          data-variant="primary"
          data-testid={`task-slot-open-${props.slot}`}
          onClick={() => {
            const link = current()
            if (link) props.onOpenSession(link.sessionRef)
          }}
        >
          Open session
        </button>
      </Show>
      <Show when={unsent()}>
        {(link) => (
          <button
            type="button"
            class="tsk-button"
            data-variant="outline"
            data-testid={`task-slot-send-${props.slot}`}
            disabled={props.busy || props.archived}
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
          data-variant="primary"
          data-testid={`task-slot-start-${props.slot}`}
          disabled={props.archived}
          onClick={() => props.onStart({ slot: props.slot, attempt: 1 })}
        >
          Start
        </button>
      </Show>
      <Show when={current() && current()?.liveness !== "live"}>
        <button
          type="button"
          class="tsk-button"
          data-variant="primary"
          data-testid={`task-slot-start-again-${props.slot}`}
          disabled={props.archived}
          onClick={() => props.onStart({ slot: props.slot, attempt: (current()?.attempt ?? 0) + 1 })}
        >
          Start again
        </button>
      </Show>
    </div>
  )
}
