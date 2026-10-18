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
import { Button, ClaxedoIconButton, Field, Select, Textarea, TextField } from "@/ui"
import { fieldReasonKey, type FieldReasons } from "../data/refusal"
import { tasksDictionary } from "../i18n"
import type { TaskProject } from "../links"
import { TASK_STATUS_KEYS } from "../model"
import { draftImageUrl } from "./image-drafts"
import { createImageQueue } from "./image-queue"
import { TaskStatusChip } from "./status-control"

export type ImageQueue = ReturnType<typeof createImageQueue>

export type TaskCreateFieldsProps = {
  readonly draft: TaskDraft
  readonly projects: readonly TaskProject[]
  readonly queue: ImageQueue
  readonly fieldErrors?: FieldReasons
  readonly onDraftChange: (draft: TaskDraft) => void
}

type Patch = (input: Partial<TaskDraft>) => void

function imageFiles(transfer: DataTransfer | null): File[] {
  if (!transfer) return []
  return [...transfer.files].filter(
    (file) => file.type.startsWith("image/") || /\.(png|jpe?g|gif|webp)$/i.test(file.name),
  )
}

function FieldReason(props: { readonly reason?: string }): JSX.Element {
  const t = useTranslator(tasksDictionary)
  return (
    <Show when={props.reason}>
      {(reason) => (
        <Field.Suffix>
          <span class="tsk-error">{t(fieldReasonKey(reason()))}</span>
        </Field.Suffix>
      )}
    </Show>
  )
}

function ImageRows(props: { readonly images: readonly TaskAttachmentDraft[]; readonly queue: ImageQueue }): JSX.Element {
  const t = useTranslator(tasksDictionary)
  return (
    <Show when={props.images.length > 0}>
      <ul class="tsk-create-images" aria-label={t("tasks.create.images")}>
        <For each={props.images}>
          {(image, index) => (
            <li class="tsk-create-image">
              <img class="tsk-create-image-thumb" src={draftImageUrl(image)} alt="" />
              <span class="tsk-create-image-name" title={image.filename}>
                {image.filename}
              </span>
              <ClaxedoIconButton
                type="button"
                icon="trash"
                size="small"
                variant="ghost"
                aria-label={t("tasks.create.removeImage", { name: image.filename })}
                onClick={() => props.queue.remove(index())}
              />
            </li>
          )}
        </For>
      </ul>
    </Show>
  )
}

function ImagesField(props: { readonly images: readonly TaskAttachmentDraft[]; readonly queue: ImageQueue; readonly reason?: string }): JSX.Element {
  const t = useTranslator(tasksDictionary)
  let picker: HTMLInputElement | undefined
  return (
    <Field role="group" aria-label={t("tasks.create.images")} invalid={props.reason !== undefined}>
      <Field.Label>{t("tasks.create.images")}</Field.Label>
      <Field.Prefix>{t("tasks.create.imagesHint", { max: TASKS_BOUNDS.taskAttachmentsMax })}</Field.Prefix>
      <ImageRows images={props.images} queue={props.queue} />
      <input
        ref={picker}
        type="file"
        accept={TASK_ATTACHMENT_MIMES.join(",")}
        multiple
        hidden
        onChange={(event) => {
          props.queue.add([...(event.currentTarget.files ?? [])])
          event.currentTarget.value = ""
        }}
      />
      <Button type="button" variant="neutral" disabled={props.images.length >= TASKS_BOUNDS.taskAttachmentsMax} onClick={() => picker?.click()}>
        {t("tasks.create.addImage")}
      </Button>
      <Show when={props.queue.reading() > 0}>
        <Field.Suffix role="status">{t("tasks.create.readingImages")}</Field.Suffix>
      </Show>
      <Show when={props.queue.notice()}>
        {(notice) => (
          <Field.Suffix role="status">
            <span class="tsk-error">{t(notice().key, notice().params)}</span>
          </Field.Suffix>
        )}
      </Show>
      <FieldReason reason={props.reason} />
    </Field>
  )
}

function ProjectField(props: TaskCreateFieldsProps & { readonly patch: Patch }): JSX.Element {
  const t = useTranslator(tasksDictionary)
  const reason = () => props.fieldErrors?.projectId
  return (
    <Field invalid={reason() !== undefined}>
      <Field.Label>{t("tasks.create.project")}</Field.Label>
      <Select
        options={[...props.projects]}
        current={props.projects.find((entry) => entry.id === props.draft.projectId)}
        value={(entry: TaskProject) => entry.id}
        label={(entry: TaskProject) => entry.label}
        placeholder={t("tasks.create.project")}
        invalid={reason() !== undefined}
        triggerProps={{ "aria-label": t("tasks.create.project") }}
        onSelect={(entry) => {
          if (entry) props.patch({ projectId: entry.id })
        }}
      />
      <FieldReason reason={reason()} />
    </Field>
  )
}

function StatusField(props: { readonly status: TaskCreateStatus; readonly patch: Patch }): JSX.Element {
  const t = useTranslator(tasksDictionary)
  return (
    <Field>
      <Field.Label>{t("tasks.create.status")}</Field.Label>
      <Select
        options={[...TASK_CREATE_STATUSES]}
        current={props.status}
        value={(status: TaskCreateStatus) => status}
        label={(status: TaskCreateStatus) => t(TASK_STATUS_KEYS[status])}
        triggerProps={{ "aria-label": t("tasks.create.status") }}
        onSelect={(status) => {
          if (status) props.patch({ status })
        }}
      >
        {(status) => <TaskStatusChip status={status} />}
      </Select>
    </Field>
  )
}

function DescriptionField(props: { readonly value: string; readonly reason?: string; readonly patch: Patch }): JSX.Element {
  const t = useTranslator(tasksDictionary)
  return (
    <Field invalid={props.reason !== undefined}>
      <Field.Label>{t("tasks.create.description")}</Field.Label>
      <Textarea
        class="textarea-v2--full-width"
        rows={5}
        value={props.value}
        invalid={props.reason !== undefined}
        onInput={(event) => props.patch({ description: event.currentTarget.value })}
      />
      <FieldReason reason={props.reason} />
    </Field>
  )
}

export function TaskCreateFields(props: TaskCreateFieldsProps): JSX.Element {
  const t = useTranslator(tasksDictionary)
  const patch: Patch = (input) => props.onDraftChange({ ...props.draft, ...input })
  const titleError = () => {
    const reason = props.fieldErrors?.title
    return reason === undefined ? undefined : t(fieldReasonKey(reason))
  }
  const imageReason = () => Object.entries(props.fieldErrors ?? {}).find(([path]) => path.startsWith("attachments"))?.[1]
  const dropped = (event: ClipboardEvent | DragEvent, transfer: DataTransfer | null) => {
    const files = imageFiles(transfer)
    if (files.length === 0) return
    event.preventDefault()
    props.queue.add(files)
  }
  return (
    <div
      class="tsk-create"
      onPaste={(event) => dropped(event, event.clipboardData)}
      onDragOver={(event) => {
        if (event.dataTransfer?.types.includes("Files")) event.preventDefault()
      }}
      onDrop={(event) => dropped(event, event.dataTransfer)}
    >
      <TextField
        label={t("tasks.create.title")}
        value={props.draft.title}
        maxLength={TASKS_BOUNDS.taskTitleMax}
        invalid={titleError() !== undefined}
        error={titleError()}
        autofocus
        onChange={(title) => patch({ title })}
      />
      <DescriptionField value={props.draft.description} reason={props.fieldErrors?.description} patch={patch} />
      <ProjectField {...props} patch={patch} />
      <StatusField status={props.draft.status ?? "todo"} patch={patch} />
      <ImagesField images={props.draft.attachments ?? []} queue={props.queue} reason={imageReason()} />
    </div>
  )
}
