import { For, Show } from "solid-js"
import { Dynamic } from "solid-js/web"
import { TASKS_BOUNDS, type TaskDraft } from "../contracts"
import type { ProseEditor } from "./prose-editor"
import { TaskStatusDot } from "./status-menu"
import { TASK_STATUS_LABELS, type FieldErrors } from "./view-model"

export type ProjectOption = { id: string; label: string }

export type TaskCreateDialogProps = {
  draft: TaskDraft
  projects: readonly ProjectOption[]
  parentTitle?: string
  busy?: boolean
  error?: string
  fieldErrors?: FieldErrors
  /** The host's markdown editor, so a description written here is the prose it will be read as. */
  proseEditor: ProseEditor
  onDraftChange: (draft: TaskDraft) => void
  onSubmit: () => void
  onCancel: () => void
}

/**
 * The create form. The draft is the caller's, so a refused save re-renders the
 * same values the user typed instead of a fresh empty form.
 *
 * The properties row states what a new task will be rather than offering to
 * change it: `task.create` takes no status, so To do is a fact here, not a
 * control that would be refused.
 */
export function TaskCreateDialog(props: TaskCreateDialogProps) {
  const patch = (input: Partial<TaskDraft>) => props.onDraftChange({ ...props.draft, ...input })
  const fieldError = (path: string) => props.fieldErrors?.[path]
  const projectLabel = () => props.projects.find((project) => project.id === props.draft.projectId)?.label

  return (
    <form
      class="tsk tsk-stack tsk-create"
      data-testid="task-create-dialog"
      onSubmit={(event) => {
        event.preventDefault()
        props.onSubmit()
      }}
    >
      <nav class="tsk-crumbs" aria-label="Breadcrumb">
        <Show when={props.parentTitle} fallback={<span>{projectLabel() ?? "Project"}</span>}>
          {(title) => <span>{title()}</span>}
        </Show>
        <span class="tsk-crumb-sep" aria-hidden="true">
          ›
        </span>
        <span class="tsk-crumb-current">{props.parentTitle ? "New subtask" : "New task"}</span>
      </nav>

      <input
        class="tsk-bare-title"
        data-testid="task-create-title"
        aria-label="Task title"
        placeholder="Task title"
        maxLength={TASKS_BOUNDS.taskTitleMax}
        aria-invalid={fieldError("title") ? "true" : undefined}
        value={props.draft.title}
        onInput={(event) => patch({ title: event.currentTarget.value })}
      />
      <Show when={fieldError("title")}>{(message) => <span class="tsk-error">{message()}</span>}</Show>

      <div class="tsk-prose">
        <Dynamic
          component={props.proseEditor}
          value={props.draft.description}
          placeholder="Add a description…"
          ariaLabel="Task description"
          testId="task-create-description"
          onChange={(description) => patch({ description })}
        />
      </div>
      <Show when={fieldError("description")}>{(message) => <span class="tsk-error">{message()}</span>}</Show>

      <div class="tsk-chiprow">
        <span class="tsk-status">
          <TaskStatusDot status="todo" />
          {TASK_STATUS_LABELS.todo}
        </span>
        <Show when={!props.draft.parentTaskId}>
          <select
            class="tsk-chip-select"
            data-testid="task-create-project"
            aria-label="Project"
            value={props.draft.projectId}
            onChange={(event) => patch({ projectId: event.currentTarget.value })}
          >
            <For each={props.projects}>{(project) => <option value={project.id}>{project.label}</option>}</For>
          </select>
        </Show>
        <Show when={fieldError("projectId")}>{(message) => <span class="tsk-error">{message()}</span>}</Show>
      </div>

      <Show when={props.error}>
        {(message) => (
          <p class="tsk-error" role="alert">
            {message()}
          </p>
        )}
      </Show>

      <div class="tsk-dialog-actions">
        <button type="button" class="tsk-button" data-variant="quiet" onClick={() => props.onCancel()}>
          Cancel
        </button>
        <button
          type="submit"
          class="tsk-button"
          data-variant="primary"
          data-testid="task-create-submit"
          disabled={props.busy || props.draft.title.trim().length === 0 || props.draft.projectId.length === 0}
        >
          Create
        </button>
      </div>
    </form>
  )
}
