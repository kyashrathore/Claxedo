import { For, Show, onCleanup, type JSX } from "solid-js"
import { Dynamic } from "solid-js/web"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { Tag } from "@opencode-ai/ui/tag"
import {
  TASKS_BOUNDS,
  type ConfigurationSlot,
  type SessionReference,
  type TaskSessionLinkView,
  type TaskStatus,
} from "@claxedo/tasks"
import type { ProseEditor } from "../../app-ports"
import { StatusControl } from "../shared/status-control"
import {
  SLOT_LABELS,
  TASK_STATUS_LABELS,
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
  // The preset the task is actually running under, named by the link the
  // service wrote at start rather than by whatever the catalog holds now.
  const presetName = () => openableSlot(props.view.groups)?.current.presetNameAtStart
  const key = () => taskKey(props.projectLabel, task().number)

  // Cmd/Ctrl+S saves from wherever the caret is — the editor holds focus while
  // you type, so a handler on this subtree alone would miss the rail. Bound
  // only while there is something to save, and it stops the browser's own save.
  const save = (event: KeyboardEvent) => {
    if (event.key !== "s" || !(event.metaKey || event.ctrlKey) || event.altKey) return
    if (!props.dirty || props.busy) return
    event.preventDefault()
    props.onSave()
  }
  window.addEventListener("keydown", save)
  onCleanup(() => window.removeEventListener("keydown", save))

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
          <span class="tsk-crumb-current">
            <span class="tsk-key">{key()}</span>
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

        <div class="tsk-title-row">
          <span class="tsk-key tsk-title-key" data-testid="task-detail-key">
            {key()}
          </span>
          <input
            class="tsk-bare-title"
            data-testid="task-detail-title"
            aria-label="Task title"
            placeholder="Untitled task"
            maxLength={TASKS_BOUNDS.taskTitleMax}
            value={props.edit.title}
            onInput={(event) => patch({ title: event.currentTarget.value })}
          />
        </div>

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

      <aside class="tsk-rail">
        <section class="tsk-rail-section" aria-label="Properties">
          <h3 class="tsk-rail-title">Properties</h3>
          <dl class="tsk-props-list">
            <div class="tsk-prop">
              <dt>
                <Icon name="status" size="small" />
                Status
              </dt>
              <dd>
                <StatusControl
                  status={task().status}
                  disabled={props.busy || task().archivedAt !== null}
                  label="Task status"
                  testId="task-detail-status"
                  onChange={(status) => props.onStatusChange({ taskId: task().id, revision: task().revision, status })}
                />
              </dd>
            </div>
            <div class="tsk-prop">
              <dt>
                <Icon name="folder" size="small" />
                Project
              </dt>
              <dd>{props.projectLabel}</dd>
            </div>
            <Show when={presetName()}>
              {(name) => (
                <div class="tsk-prop">
                  <dt>
                    <Icon name="sliders" size="small" />
                    Preset
                  </dt>
                  <dd class="tsk-truncate">{name()}</dd>
                </div>
              )}
            </Show>
            <Show when={task().workspaceId}>
              {(workspaceId) => (
                <div class="tsk-prop">
                  <dt>
                    <Icon name="server" size="small" />
                    Workspace
                  </dt>
                  <dd class="tsk-truncate">{workspaceId()}</dd>
                </div>
              )}
            </Show>
          </dl>
          <p class="tsk-hint">Status is manual: {TASK_STATUS_LABELS[task().status]} until you change it.</p>
        </section>

        <section class="tsk-rail-section" aria-label="Linked sessions">
          <h3 class="tsk-rail-title">Sessions</h3>
          <Show
            when={props.view.configuredSlots.length > 0}
            fallback={<p class="tsk-hint">Choose a preset to see its configurations.</p>}
          >
            <div class="tsk-slots">
              <For each={props.view.configuredSlots}>
                {(slot) => (
                  <SlotRow
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
  group: TaskLinkGroup | undefined
  archived: boolean
  busy?: boolean
  onOpenSession: (sessionRef: SessionReference) => void
  onStart: (input: { slot: ConfigurationSlot; attempt: number }) => void
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

        <Show when={current()?.liveness === "live"}>
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
        <Show when={current() === undefined}>
          <Button
            size="small"
            variant="ghost"
            data-testid={`task-slot-start-${props.slot}`}
            disabled={props.archived}
            onClick={() => props.onStart({ slot: props.slot, attempt: next().attempt })}
          >
            Start
          </Button>
        </Show>
        <Show when={next().again}>
          <Button
            size="small"
            variant="ghost"
            data-testid={`task-slot-start-again-${props.slot}`}
            disabled={props.archived}
            onClick={() => props.onStart({ slot: props.slot, attempt: next().attempt })}
          >
            Start again
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
            disabled={props.busy || props.archived}
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
