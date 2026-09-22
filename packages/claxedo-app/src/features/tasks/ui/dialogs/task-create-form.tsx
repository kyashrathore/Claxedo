import { For, Show, createSignal } from "solid-js"
import { Dynamic } from "solid-js/web"
import { Button } from "@opencode-ai/ui/button"
import { Select } from "@opencode-ai/ui/select"
import {
  TASKS_BOUNDS,
  TASK_ATTACHMENT_MIMES,
  TASK_CREATE_STATUSES,
  type TaskAttachmentDraft,
  type TaskCreateStatus,
  type TaskDraft,
} from "@claxedo/tasks"
import type { ProseEditor, TasksProjectOption } from "../../app-ports"
import { TaskStatusChip } from "../shared/status-control"
import { TaskTitleField } from "../shared/title-field"
import { TASK_STATUS_LABELS, type FieldErrors } from "../../view-model"
import { draftImageUrl, imageRefusalMessage, isImageRefusal, readImageDraft, type ImageShrink } from "./image-drafts"

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
  /** How an oversized image is brought under the cap; the canvas encoder unless a test supplies one. */
  shrinkImage?: ImageShrink
}

/** The image files among what was pasted or dropped; text and other files are left to their own handlers. */
function imageFiles(transfer: DataTransfer | null): File[] {
  if (!transfer) return []
  return [...transfer.files].filter((file) => file.type.startsWith("image/") || /\.(png|jpe?g|gif|webp)$/i.test(file.name))
}

/**
 * The create form. The draft is the caller's, so a refused save re-renders the
 * same values the user typed instead of a fresh empty form.
 *
 * The status offers the two a task may be created in and no more: the rest are
 * reached by working on it, and a create that named one would be refused.
 *
 * Images reach the draft three ways — pasted, dropped onto the form, or picked
 * — and land in it as base64, which is what the command carries; the preview
 * is rendered from that same string so the strip shows what will be sent.
 */
export function TaskCreateForm(props: TaskCreateFormProps) {
  const patch = (input: Partial<TaskDraft>) => props.onDraftChange({ ...props.draft, ...input })
  const fieldError = (path: string) => props.fieldErrors?.[path]
  const project = () => props.projects.find((entry) => entry.id === props.draft.projectId)
  const images = () => props.draft.attachments ?? []
  // The server names the image it refused (`attachments[2].data`); one line
  // under the strip is where every such path is shown.
  const imageFieldError = () => Object.entries(props.fieldErrors ?? {}).find(([path]) => path.startsWith("attachments"))?.[1]
  const [imageNotice, setImageNotice] = createSignal<string | undefined>()
  const [imagesReading, setImagesReading] = createSignal(0)
  // Adds queue on this chain — a paste landing while a drop still decodes runs
  // after it, and submit drains the chain so no in-flight read is lost.
  let imageReads: Promise<void> = Promise.resolve()
  let picker: HTMLInputElement | undefined

  const addImages = (files: readonly File[]) => {
    if (files.length === 0) return
    setImageNotice(undefined)
    setImagesReading((count) => count + 1)
    imageReads = imageReads.then(async () => {
      try {
        const room = TASKS_BOUNDS.taskAttachmentsMax - images().length
        const admitted: TaskAttachmentDraft[] = []
        let notice: string | undefined
        for (const file of files.slice(0, Math.max(0, room))) {
          const read = await readImageDraft(file, props.shrinkImage)
          if (isImageRefusal(read)) notice ??= imageRefusalMessage(read)
          else admitted.push(read)
        }
        if (files.length > room) notice ??= `A task holds up to ${TASKS_BOUNDS.taskAttachmentsMax} images.`
        // Read against the draft as it is now, not as it was when the reads
        // began: a paste that lands while a drop is still decoding must not be
        // dropped — but the cap is still the cap, so only the room left now is
        // admitted.
        if (admitted.length > 0) {
          const roomNow = Math.max(0, TASKS_BOUNDS.taskAttachmentsMax - images().length)
          if (admitted.length > roomNow) notice ??= `A task holds up to ${TASKS_BOUNDS.taskAttachmentsMax} images.`
          const keep = admitted.slice(0, roomNow)
          if (keep.length > 0) patch({ attachments: [...images(), ...keep] })
        }
        setImageNotice(notice)
      } finally {
        setImagesReading((count) => count - 1)
      }
      // A refused read is data, but a thrown one must not poison the queue —
      // every add chained on this promise would skip silently.
    }).catch(() => undefined)
  }

  const removeImage = (index: number) => {
    setImageNotice(undefined)
    patch({ attachments: images().filter((_, position) => position !== index) })
  }

  return (
    <form
      class="tsk tsk-create"
      data-testid="task-create-dialog"
      onSubmit={(event) => {
        event.preventDefault()
        // Reads still decoding belong to this task — wait them out rather than
        // silently create it without the images the user just dropped. A
        // second submit queued behind the same drain must not fire twice.
        if (imagesReading() > 0) {
          void imageReads.then(() => {
            if (!props.busy) props.onSubmit()
          })
          return
        }
        if (props.busy) return
        props.onSubmit()
      }}
      onPaste={(event) => {
        const files = imageFiles(event.clipboardData)
        if (files.length === 0) return
        event.preventDefault()
        addImages(files)
      }}
      onDragOver={(event) => {
        // `files` only materializes at drop time; all a dragover exposes is
        // `types`/`items`, and the drop handler filters non-images anyway.
        if (event.dataTransfer?.types.includes("Files")) event.preventDefault()
      }}
      onDrop={(event) => {
        const files = imageFiles(event.dataTransfer)
        if (files.length === 0) return
        event.preventDefault()
        addImages(files)
      }}
    >
      <nav class="tsk-crumbs" aria-label="Breadcrumb">
        <span>{project()?.label ?? "Project"}</span>
        <span class="tsk-crumb-sep" aria-hidden="true">
          ›
        </span>
        <span class="tsk-crumb-current">New task</span>
      </nav>

      <TaskTitleField
        testId="task-create-title"
        ariaLabel="Task title"
        placeholder="Task title"
        invalid={fieldError("title") !== undefined}
        value={props.draft.title}
        onInput={(title) => patch({ title })}
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

      <div class="tsk-images" data-testid="task-create-images">
        <For each={images()}>
          {(image, index) => (
            <figure class="tsk-image" data-testid="task-create-image">
              <img class="tsk-image-thumb" src={draftImageUrl(image)} alt={image.filename} />
              <figcaption class="tsk-image-name" title={image.filename}>
                {image.filename}
              </figcaption>
              <button
                type="button"
                class="tsk-image-remove"
                aria-label={`Remove ${image.filename}`}
                onClick={() => removeImage(index())}
              >
                ×
              </button>
            </figure>
          )}
        </For>
        <input
          ref={picker}
          type="file"
          accept={TASK_ATTACHMENT_MIMES.join(",")}
          multiple
          hidden
          data-testid="task-create-image-picker"
          onChange={(event) => {
            addImages([...(event.currentTarget.files ?? [])])
            event.currentTarget.value = ""
          }}
        />
        <Button
          size="small"
          variant="ghost"
          data-testid="task-create-add-image"
          disabled={images().length >= TASKS_BOUNDS.taskAttachmentsMax}
          onClick={() => picker?.click()}
        >
          Add image
        </Button>
      </div>
      <Show when={imageNotice()}>
        {(message) => (
          <p class="tsk-error" role="status" data-testid="task-create-image-notice">
            {message()}
          </p>
        )}
      </Show>
      <Show when={imageFieldError()}>{(message) => <span class="tsk-error">{message()}</span>}</Show>

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
          disabled={props.busy || imagesReading() > 0 || props.draft.title.trim().length === 0 || props.draft.projectId.length === 0}
        >
          Create
        </Button>
      </div>
    </form>
  )
}
