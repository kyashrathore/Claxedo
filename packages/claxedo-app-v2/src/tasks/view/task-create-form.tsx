import { For, Show, type JSX } from "solid-js"
import {
  TASKS_BOUNDS,
  TASK_ATTACHMENT_MIMES,
  TASK_CREATE_STATUSES,
  type TaskAttachmentDraft,
  type TaskCreateStatus,
  type TaskDraft,
} from "@claxedo/tasks"
import { useTranslator } from "@/i18n"
import { Button, Select } from "@/ui"
import { fieldReasonKey, type FieldReasons } from "../data/refusal"
import { dictionary } from "../i18n"
import type { TaskProject } from "../links"
import { TASK_STATUS_KEYS } from "../model"
import { draftImageUrl, type ImageShrink } from "./image-drafts"
import { createImageQueue } from "./image-queue"
import { ProseField } from "./prose-field"
import { TaskStatusChip } from "./status-control"
import { TaskTitleField } from "./title-field"

export type TaskCreateFormProps = {
  readonly draft: TaskDraft
  readonly projects: readonly TaskProject[]
  readonly busy?: boolean
  readonly error?: string
  readonly fieldErrors?: FieldReasons
  readonly onDraftChange: (draft: TaskDraft) => void
  readonly onSubmit: () => void
  readonly onCancel: () => void
  readonly shrinkImage?: ImageShrink
}

function imageFiles(transfer: DataTransfer | null): File[] {
  if (!transfer) return []
  return [...transfer.files].filter(
    (file) => file.type.startsWith("image/") || /\.(png|jpe?g|gif|webp)$/i.test(file.name),
  )
}

function ImageStrip(props: {
  readonly images: readonly TaskAttachmentDraft[]
  readonly queue: ReturnType<typeof createImageQueue>
}) {
  const t = useTranslator(dictionary)
  let picker: HTMLInputElement | undefined
  return (
    <div class="tsk-images" data-testid="task-create-images">
      <For each={props.images}>
        {(image, index) => (
          <figure class="tsk-image" data-testid="task-create-image">
            <img class="tsk-image-thumb" src={draftImageUrl(image)} alt={image.filename} />
            <figcaption class="tsk-image-name" title={image.filename}>
              {image.filename}
            </figcaption>
            <button
              type="button"
              class="tsk-image-remove"
              aria-label={t("tasks.create.removeImage", { name: image.filename })}
              onClick={() => props.queue.remove(index())}
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
          props.queue.add([...(event.currentTarget.files ?? [])])
          event.currentTarget.value = ""
        }}
      />
      <Button
        size="small"
        variant="ghost"
        data-testid="task-create-add-image"
        disabled={props.images.length >= TASKS_BOUNDS.taskAttachmentsMax}
        onClick={() => picker?.click()}
      >
        {t("tasks.create.addImage")}
      </Button>
    </div>
  )
}

function ChipRow(props: TaskCreateFormProps & { readonly patch: (input: Partial<TaskDraft>) => void }): JSX.Element {
  const t = useTranslator(dictionary)
  const project = () => props.projects.find((entry) => entry.id === props.draft.projectId)
  const projectError = () => props.fieldErrors?.projectId
  return (
    <div class="tsk-chiprow">
      <Select
        size="small"
        options={[...TASK_CREATE_STATUSES]}
        current={props.draft.status ?? "todo"}
        value={(status: TaskCreateStatus) => status}
        label={(status: TaskCreateStatus) => t(TASK_STATUS_KEYS[status])}
        renderValue={(status: TaskCreateStatus) => <TaskStatusChip status={status} />}
        triggerProps={{ "data-testid": "task-create-status", "aria-label": t("tasks.create.status") }}
        onSelect={(status) => {
          if (status) props.patch({ status })
        }}
      >
        {(status) => <Show when={status}>{(chosen) => <TaskStatusChip status={chosen()} />}</Show>}
      </Select>
      <Select
        size="small"
        options={[...props.projects]}
        current={project()}
        value={(entry: TaskProject) => entry.id}
        label={(entry: TaskProject) => entry.label}
        placeholder={t("tasks.create.project")}
        triggerProps={{ "data-testid": "task-create-project", "aria-label": t("tasks.create.project") }}
        onSelect={(entry) => {
          if (entry) props.patch({ projectId: entry.id })
        }}
      />
      <Show when={projectError()}>{(reason) => <span class="tsk-error">{t(fieldReasonKey(reason()))}</span>}</Show>
    </div>
  )
}

function FieldError(props: { readonly reason?: string }): JSX.Element {
  const t = useTranslator(dictionary)
  return <Show when={props.reason}>{(reason) => <span class="tsk-error">{t(fieldReasonKey(reason()))}</span>}</Show>
}

export function TaskCreateForm(props: TaskCreateFormProps): JSX.Element {
  const t = useTranslator(dictionary)
  const patch = (input: Partial<TaskDraft>) => props.onDraftChange({ ...props.draft, ...input })
  const images = () => props.draft.attachments ?? []
  const queue = createImageQueue({
    images,
    setImages: (attachments) => patch({ attachments: [...attachments] }),
    shrink: props.shrinkImage,
  })
  const imageFieldError = () =>
    Object.entries(props.fieldErrors ?? {}).find(([path]) => path.startsWith("attachments"))?.[1]
  const project = () => props.projects.find((entry) => entry.id === props.draft.projectId)
  const submit = () => {
    if (queue.reading() > 0) return void queue.drained().then(() => !props.busy && props.onSubmit())
    if (!props.busy) props.onSubmit()
  }
  return (
    <form
      class="tsk tsk-create"
      data-testid="task-create-dialog"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
      onPaste={(event) => {
        const files = imageFiles(event.clipboardData)
        if (files.length === 0) return
        event.preventDefault()
        queue.add(files)
      }}
      onDragOver={(event) => {
        if (event.dataTransfer?.types.includes("Files")) event.preventDefault()
      }}
      onDrop={(event) => {
        const files = imageFiles(event.dataTransfer)
        if (files.length === 0) return
        event.preventDefault()
        queue.add(files)
      }}
    >
      <nav class="tsk-crumbs" aria-label={t("tasks.detail.breadcrumb")}>
        <span>{project()?.label ?? t("tasks.create.project")}</span>
        <span class="tsk-crumb-sep" aria-hidden="true">
          ›
        </span>
        <span class="tsk-crumb-current">{t("tasks.newTask")}</span>
      </nav>
      <TaskTitleField
        testId="task-create-title"
        ariaLabel={t("tasks.detail.titleLabel")}
        placeholder={t("tasks.create.titlePlaceholder")}
        invalid={props.fieldErrors?.title !== undefined}
        value={props.draft.title}
        onInput={(title) => patch({ title })}
      />
      <FieldError reason={props.fieldErrors?.title} />
      <div class="tsk-prose">
        <ProseField
          value={props.draft.description}
          placeholder={t("tasks.detail.descriptionPlaceholder")}
          ariaLabel={t("tasks.detail.descriptionLabel")}
          testId="task-create-description"
          onChange={(description) => patch({ description })}
        />
      </div>
      <FieldError reason={props.fieldErrors?.description} />
      <ImageStrip images={images()} queue={queue} />
      <Show when={queue.notice()}>
        {(notice) => (
          <p class="tsk-error" role="status" data-testid="task-create-image-notice">
            {t(notice().key, notice().params)}
          </p>
        )}
      </Show>
      <FieldError reason={imageFieldError()} />
      <ChipRow {...props} patch={patch} />
      <Show when={props.error}>
        {(message) => (
          <p class="tsk-error" role="alert">
            {message()}
          </p>
        )}
      </Show>
      <div class="tsk-dialog-actions">
        <Button size="small" variant="ghost" onClick={() => props.onCancel()}>
          {t("tasks.cancel")}
        </Button>
        <Button
          type="submit"
          size="small"
          variant="primary"
          data-testid="task-create-submit"
          disabled={
            props.busy ||
            queue.reading() > 0 ||
            props.draft.title.trim().length === 0 ||
            props.draft.projectId.length === 0
          }
        >
          {t("tasks.create.create")}
        </Button>
      </div>
    </form>
  )
}
