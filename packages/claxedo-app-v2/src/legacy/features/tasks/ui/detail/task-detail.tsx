import { For, Show, type JSX } from "solid-js"
import { Dynamic } from "solid-js/web"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tag } from "@opencode-ai/ui/tag"
import {
  type ConfigurationSlot,
  type SessionReference,
  type Task,
  type TaskSessionLinkView,
  type TaskStatus,
} from "@claxedo/tasks"
import type { ProseEditor } from "../../app-ports"
import { StatusControl } from "../shared/status-control"
import { TaskTitleField } from "../shared/title-field"
import { TaskStartControl, type TaskStartOffer } from "../shared/task-row-controls"
import {
  SLOT_LABELS,
  openableSlot,
  slotAttempt,
  taskKey,
  type TaskDetailView,
  type TaskLinkGroup,
} from "../../view-model"

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
  /** The host's markdown editor; a description is prose, not a text field. */
  proseEditor: ProseEditor
  onEditChange: (edit: TaskDetailEdit) => void
  onSave: () => void
  onDiscard: () => void
  onStatusChange: (input: { taskId: string; revision: number; status: TaskStatus }) => void
  onOpenSession: (sessionRef: SessionReference) => void
  /** The slot's own Start control, which is how a session is started from this page. */
  startOffer: (slot: ConfigurationSlot) => TaskStartOffer
  /**
   * Hands the attempt's first message over again. Offered only where the host
   * reports the message absent from a live session, because a resend on any
   * weaker evidence would give the session a second copy of it.
   */
  onSendTask: (link: TaskSessionLinkView) => void
  onArchive: () => void
  onRestore: () => void
  onBack: () => void
  /** Opens the task list filtered to this task's project. */
  onOpenProject: () => void
  /** Opens the task this one is a subtask of. */
  onOpenParent?: () => void
  /** The properties rail folded away, so the prose has the whole width. */
  railCollapsed?: boolean
  onToggleRail: () => void
  /**
   * The subtasks section, rendered by the caller so the detail owns no data
   * fetch. Absent on a subtask, which cannot have children of its own.
   */
  subtasks?: JSX.Element
  /** The task's images, rendered by the caller for the same reason. */
  attachments?: JSX.Element
}

export function TaskDetail(props: TaskDetailProps) {
  const task = () => props.view.task
  const patch = (input: Partial<TaskDetailEdit>) => props.onEditChange({ ...props.edit, ...input })
  // The preset the task is actually running under, named by the link the
  // service wrote at start rather than by whatever the catalog holds now.
  const presetName = () => openableSlot(props.view.groups)?.current.presetNameAtStart
  const key = () => taskKey(props.projectLabel, task())

  return (
    <article
      class="tsk tsk-detail"
      data-testid="task-detail"
      data-rail={props.railCollapsed ? "collapsed" : undefined}
      aria-label={task().title}
    >
      <div class="tsk-detail-main">
        <nav class="tsk-crumbs" aria-label="Breadcrumb">
          <button type="button" class="tsk-crumb-link" data-testid="task-detail-back" onClick={() => props.onBack()}>
            Tasks
          </button>
          <span class="tsk-crumb-sep" aria-hidden="true">›</span>
          <button
            type="button"
            class="tsk-crumb-link"
            data-testid="task-detail-project-crumb"
            onClick={() => props.onOpenProject()}
          >
            {props.projectLabel}
          </button>
          <Show when={props.view.parent}>
            {(parent) => (
              <>
                <span class="tsk-crumb-sep" aria-hidden="true">›</span>
                <Show
                  when={props.onOpenParent}
                  fallback={
                    <span class="tsk-key" title={parent().title}>
                      {taskKey(props.projectLabel, parent())}
                    </span>
                  }
                >
                  {(open) => (
                    <button
                      type="button"
                      class="tsk-crumb-link tsk-key"
                      data-testid="task-detail-parent-crumb"
                      title={parent().title}
                      onClick={() => open()()}
                    >
                      {taskKey(props.projectLabel, parent())}
                    </button>
                  )}
                </Show>
              </>
            )}
          </Show>
          <span class="tsk-crumb-sep" aria-hidden="true">›</span>
          <span class="tsk-crumb-current">
            <span class="tsk-key" data-testid="task-detail-key">{key()}</span>
            {task().title}
          </span>

          <Show when={props.dirty}>
            <span class="tsk-spacer" />
            <span class="tsk-page-actions" data-testid="task-detail-save-row">
              <span class="tsk-hint">Unsaved changes</span>
              <Button size="small" variant="ghost" data-testid="task-detail-discard" onClick={() => props.onDiscard()}>
                Discard
              </Button>
              <Button
                size="small"
                variant="primary"
                data-testid="task-detail-save"
                disabled={props.busy}
                onClick={() => props.onSave()}
              >
                Save
              </Button>
            </span>
          </Show>
          <Show when={!props.dirty}>
            <span class="tsk-spacer" />
          </Show>
          {/* The folded rail is inert, so its expand control must live out here. */}
          <Show when={props.railCollapsed}>
            <IconButton
              icon="chevron-double-left"
              size="small"
              variant="ghost"
              data-icon-interaction="subdued"
              data-testid="task-detail-rail-expand"
              aria-label="Show properties"
              aria-expanded={false}
              aria-controls="task-detail-rail"
              onClick={() => props.onToggleRail()}
            />
          </Show>
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
              Subtask of <span class="tsk-key">{taskKey(props.projectLabel, parent())}</span>
              <span class="tsk-truncate">{parent().title}</span>
            </button>
          )}
        </Show>

        <TaskTitleField
          testId="task-detail-title"
          ariaLabel="Task title"
          placeholder="Untitled task"
          value={props.edit.title}
          onInput={(title) => patch({ title })}
        />

        <div class="tsk-prose">
          <Dynamic
            component={props.proseEditor}
            value={props.edit.description}
            placeholder="Add a description…"
            ariaLabel="Task description"
            testId="task-detail-description"
            onChange={(description) => patch({ description })}
          />
        </div>

        <Show when={props.attachments}>{(section) => section()}</Show>

        <Show when={props.conflict}>
          {(message) => (
            <p class="tsk-error" role="alert" data-testid="task-detail-conflict">
              {message()}
            </p>
          )}
        </Show>
        <Show when={props.error}>{(message) => <p class="tsk-error" role="alert">{message()}</p>}</Show>

        <Show when={props.subtasks}>{(section) => section()}</Show>
      </div>

      <aside id="task-detail-rail" class="tsk-rail" data-testid="task-detail-rail" inert={props.railCollapsed === true}>
        <section class="tsk-rail-section" aria-label="Properties">
          <div class="tsk-rail-head">
            <h3 class="tsk-section-title tsk-rail-title">Properties</h3>
            <IconButton
              icon="chevron-double-right"
              size="small"
              variant="ghost"
              data-icon-interaction="subdued"
              data-testid="task-detail-rail-collapse"
              aria-label="Hide properties"
              aria-expanded={true}
              aria-controls="task-detail-rail"
              onClick={() => props.onToggleRail()}
            />
          </div>
          {/* Each row is its value: the status control is the status, and a
              property nothing can change is the glyph and the name alone. */}
          <div class="tsk-props-list">
            <StatusControl
              status={task().status}
              disabled={props.busy || task().archivedAt !== null}
              label="Status"
              testId="task-detail-status"
              onChange={(status) => props.onStatusChange({ taskId: task().id, revision: task().revision, status })}
            />
            <div class="tsk-prop" role="group" aria-label="Project">
              <Icon name="folder" size="small" />
              <span class="tsk-truncate">{props.projectLabel}</span>
            </div>
            <Show when={presetName()}>
              {(name) => (
                <div class="tsk-prop" role="group" aria-label="Preset">
                  <Icon name="sliders" size="small" />
                  <span class="tsk-truncate">{name()}</span>
                </div>
              )}
            </Show>
            <Show when={task().workspaceId}>
              {(workspaceId) => (
                <div class="tsk-prop" role="group" aria-label="Workspace">
                  <Icon name="server" size="small" />
                  <span class="tsk-truncate">{workspaceId()}</span>
                </div>
              )}
            </Show>
            <Show when={task().createdFrom}>
              {(session) => (
                <button
                  type="button"
                  class="tsk-prop tsk-prop-link"
                  data-testid="task-detail-created-from"
                  onClick={() => props.onOpenSession(session())}
                >
                  <Icon name="comment" size="small" />
                  <span class="tsk-truncate">Created from session</span>
                </button>
              )}
            </Show>
          </div>
        </section>

        <section class="tsk-rail-section" aria-label="Linked sessions">
          <h3 class="tsk-section-title tsk-rail-title">Sessions</h3>
          <Show
            when={props.view.configuredSlots.length > 0}
            fallback={<p class="tsk-hint">Choose a preset to see its configurations.</p>}
          >
            <div class="tsk-slots">
              <For each={props.view.configuredSlots}>
                {(slot) => (
                  <SlotRow
                    slot={slot}
                    task={task()}
                    group={props.view.groups.find((entry) => entry.slot === slot)}
                    offer={props.startOffer(slot)}
                    busy={props.busy}
                    onOpenSession={props.onOpenSession}
                    onSendTask={props.onSendTask}
                  />
                )}
              </For>
            </div>
          </Show>
        </section>

        <Show
          when={task().archivedAt === null}
          fallback={
            <Button size="small" variant="ghost" class="tsk-rail-action" data-testid="task-detail-restore" onClick={() => props.onRestore()}>
              Restore this task
            </Button>
          }
        >
          <Button
            size="small"
            variant="ghost"
            class="tsk-rail-action tsk-destructive"
            data-testid="task-detail-archive"
            onClick={() => props.onArchive()}
          >
            Archive this task
          </Button>
        </Show>
      </aside>
    </article>
  )
}

function SlotRow(props: {
  slot: ConfigurationSlot
  task: Task
  group: TaskLinkGroup | undefined
  offer: TaskStartOffer
  busy?: boolean
  onOpenSession: (sessionRef: SessionReference) => void
  onSendTask: (link: TaskSessionLinkView) => void
}) {
  // The same rule a list row starts by: which attempt this slot will take and
  // whether its session is somewhere to navigate to.
  const next = () => slotAttempt(props.group ? [props.group] : [], props.slot)
  const current = () => next().current
  const live = () => next().open
  const unsent = () => {
    const link = live()
    return link?.handoff === "pending" ? link : undefined
  }
  const handoffNotice = () => {
    if (unsent()) return "Task not sent yet"
    return live()?.handoff === "unknown" ? "Delivery unknown" : undefined
  }
  const history = () => props.group?.attempts ?? []

  return (
    <div class="tsk-slot" data-testid={`task-slot-${props.slot}`}>
      <div class="tsk-slot-head">
        <Show when={current()} fallback={<span class="tsk-dot" data-liveness="none" aria-hidden="true" />}>
          {(link) => <span class="tsk-dot" data-liveness={link().liveness} aria-hidden="true" />}
        </Show>
        <span class="tsk-slot-name">{SLOT_LABELS[props.slot]}</span>
        <span class="tsk-spacer" />

        <Show
          when={current()?.liveness === "live"}
          fallback={<TaskStartControl task={props.task} offer={props.offer} testIdPrefix={`task-slot-${props.slot}`} />}
        >
          <Button
            size="small"
            variant="ghost"
            data-testid={`task-slot-open-${props.slot}`}
            onClick={() => {
              const link = current()
              if (link) props.onOpenSession(link.sessionRef)
            }}
          >
            Open session
          </Button>
        </Show>
      </div>

      <Show when={handoffNotice()}>
        {(notice) => (
          <p class="tsk-slot-notice" data-testid={`task-slot-handoff-${props.slot}`}>
            {notice()}
          </p>
        )}
      </Show>
      <Show when={unsent()}>
        {(link) => (
          <Button
            size="small"
            variant="ghost"
            class="tsk-slot-resend"
            data-testid={`task-slot-send-${props.slot}`}
            disabled={props.busy || props.task.archivedAt !== null}
            onClick={() => props.onSendTask(link())}
          >
            Send task
          </Button>
        )}
      </Show>

      <Show when={history().length > 0} fallback={<p class="tsk-hint">No session yet.</p>}>
        <ul class="tsk-attempts">
          <For each={history()}>
            {(link) => (
              <li class="tsk-attempt" data-testid={`task-slot-attempt-${props.slot}-${link.attempt}`}>
                <span class="tsk-attempt-no">#{link.attempt}</span>
                <span class="tsk-truncate">{link.presetNameAtStart}</span>
                <Show when={link.continuedFrom}>
                  <Tag>continued</Tag>
                </Show>
                <span class="tsk-spacer" />
                <span class="tsk-attempt-liveness" data-testid={`task-slot-liveness-${props.slot}-${link.attempt}`}>
                  {link.liveness}
                </span>
                <Show when={link.liveness !== "deleted"}>
                  <button
                    type="button"
                    class="tsk-attempt-open"
                    data-testid={`task-slot-open-attempt-${props.slot}-${link.attempt}`}
                    onClick={() => props.onOpenSession(link.sessionRef)}
                  >
                    Open
                  </button>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  )
}
