import { Show } from "solid-js"
import { Dynamic } from "solid-js/web"
import { Button } from "@opencode-ai/ui/button"
import { Select } from "@opencode-ai/ui/select"
import { TASKS_BOUNDS, TASK_CREATE_STATUSES, type TaskCreateStatus, type TaskDraft } from "@claxedo/tasks"
import type { ProseEditor, TasksProjectOption } from "../../app-ports"
import { TaskStatusChip } from "../shared/status-control"
import { TASK_STATUS_LABELS, type FieldErrors } from "../../view-model"

export type TaskCreateFormProps = {
  draft: TaskDraft
  projects: readonly TasksProjectOption[]
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
 * The status offers the two a task may be created in and no more: the rest are
 * reached by working on it, and a create that named one would be refused.
 */
export function TaskCreateForm(props: TaskCreateFormProps) {
  const patch = (input: Partial<TaskDraft>) => props.onDraftChange({ ...props.draft, ...input })
  const fieldError = (path: string) => props.fieldErrors?.[path]
  const project = () => props.projects.find((entry) => entry.id === props.draft.projectId)

  return (
    <form
      class="tsk tsk-create"
      data-testid="task-create-dialog"
      onSubmit={(event) => {
        event.preventDefault()
        props.onSubmit()
      }}
    >
      <nav class="tsk-crumbs" aria-label="Breadcrumb">
        <span>{project()?.label ?? "Project"}</span>
        <span class="tsk-crumb-sep" aria-hidden="true">
          ›
        </span>
        <span class="tsk-crumb-current">New task</span>
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
        <Select
          size="small"
          options={[...TASK_CREATE_STATUSES]}
          current={props.draft.status ?? "todo"}
          value={(status: TaskCreateStatus) => status}
          label={(status: TaskCreateStatus) => TASK_STATUS_LABELS[status]}
          renderValue={(status: TaskCreateStatus) => <TaskStatusChip status={status} />}
          triggerProps={{ "data-testid": "task-create-status", "aria-label": "Status" }}
          onSelect={(status) => {
            if (status) patch({ status })
          }}
        >
          {(status) => <Show when={status}>{(chosen) => <TaskStatusChip status={chosen()} />}</Show>}
        </Select>
        <Select
          size="small"
          options={[...props.projects]}
          current={project()}
          value={(entry: TasksProjectOption) => entry.id}
          label={(entry: TasksProjectOption) => entry.label}
          placeholder="Project"
          triggerProps={{ "data-testid": "task-create-project", "aria-label": "Project" }}
          onSelect={(entry) => {
            if (entry) patch({ projectId: entry.id })
          }}
        />
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
        <Button size="small" variant="ghost" onClick={() => props.onCancel()}>
          Cancel
        </Button>
        <Button
          type="submit"
          size="small"
          variant="primary"
          data-testid="task-create-submit"
          disabled={props.busy || props.draft.title.trim().length === 0 || props.draft.projectId.length === 0}
        >
          Create
        </Button>
      </div>
    </form>
  )
}
