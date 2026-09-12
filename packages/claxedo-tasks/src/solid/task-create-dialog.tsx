import { For, Show } from "solid-js"
import { TASKS_BOUNDS, type TaskDraft } from "../contracts"
import type { FieldErrors } from "./view-model"

export type ProjectOption = { id: string; label: string }

export type TaskCreateDialogProps = {
  draft: TaskDraft
  projects: readonly ProjectOption[]
  parentTitle?: string
  busy?: boolean
  error?: string
  fieldErrors?: FieldErrors
  onDraftChange: (draft: TaskDraft) => void
  onSubmit: () => void
  onCancel: () => void
}

/**
 * The create form. The draft is the caller's, so a refused save re-renders the
 * same values the user typed instead of a fresh empty form.
 */
export function TaskCreateDialog(props: TaskCreateDialogProps) {
  const patch = (input: Partial<TaskDraft>) => props.onDraftChange({ ...props.draft, ...input })
  const fieldError = (path: string) => props.fieldErrors?.[path]

  return (
    <form
      class="tsk tsk-stack"
      data-testid="task-create-dialog"
      onSubmit={(event) => {
        event.preventDefault()
        props.onSubmit()
      }}
    >
      <h2 class="tsk-title">{props.parentTitle ? `New subtask of ${props.parentTitle}` : "New task"}</h2>

      <label class="tsk-field">
        <span class="tsk-label">Title</span>
        <input
          class="tsk-input"
          data-testid="task-create-title"
          maxLength={TASKS_BOUNDS.taskTitleMax}
          aria-invalid={fieldError("title") ? "true" : undefined}
          value={props.draft.title}
          onInput={(event) => patch({ title: event.currentTarget.value })}
        />
        <Show when={fieldError("title")}>{(message) => <span class="tsk-error">{message()}</span>}</Show>
      </label>

      <label class="tsk-field">
        <span class="tsk-label">Description</span>
        <textarea
          class="tsk-textarea"
          data-testid="task-create-description"
          aria-invalid={fieldError("description") ? "true" : undefined}
          value={props.draft.description}
          onInput={(event) => patch({ description: event.currentTarget.value })}
        />
        <Show when={fieldError("description")}>{(message) => <span class="tsk-error">{message()}</span>}</Show>
      </label>

      <Show when={!props.draft.parentTaskId}>
        <label class="tsk-field">
          <span class="tsk-label">Project</span>
          <select
            class="tsk-select"
            data-testid="task-create-project"
            value={props.draft.projectId}
            onChange={(event) => patch({ projectId: event.currentTarget.value })}
          >
            <For each={props.projects}>{(project) => <option value={project.id}>{project.label}</option>}</For>
          </select>
          <Show when={fieldError("projectId")}>{(message) => <span class="tsk-error">{message()}</span>}</Show>
        </label>
      </Show>

      <Show when={props.error}>{(message) => <p class="tsk-error" role="alert">{message()}</p>}</Show>

      <div class="tsk-row tsk-spread">
        <button type="button" class="tsk-button" onClick={() => props.onCancel()}>
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
