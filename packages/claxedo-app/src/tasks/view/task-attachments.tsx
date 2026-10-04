import { For, Show, createEffect, createResource, onCleanup, type JSX } from "solid-js"
import type { TaskAttachment } from "@claxedo/tasks"
import { useTranslator } from "@/i18n"
import { tasksDictionary } from "../i18n"

type Loaded =
  { readonly status: "ready"; readonly url: string } | { readonly status: "failed"; readonly error?: unknown }

function createAttachmentImage(props: {
  readonly attachment: TaskAttachment
  readonly read: (id: string) => Promise<Blob>
}) {
  let disposed = false
  let generation = 0
  onCleanup(() => {
    disposed = true
  })
  const [image] = createResource(
    () => props.attachment.id,
    async (attachmentId): Promise<Loaded> => {
      const current = ++generation
      try {
        const url = URL.createObjectURL(await props.read(attachmentId))
        if (!disposed && current === generation) return { status: "ready", url }
        URL.revokeObjectURL(url)
        return { status: "failed" }
      } catch (error) {
        console.warn("A task attachment could not be read", error)
        return { status: "failed", error }
      }
    },
  )
  createEffect(() => {
    const current = image.latest
    onCleanup(() => {
      if (current?.status === "ready") URL.revokeObjectURL(current.url)
    })
  })
  return image
}

function AttachmentImage(props: {
  readonly attachment: TaskAttachment
  readonly read: (id: string) => Promise<Blob>
}): JSX.Element {
  const t = useTranslator(tasksDictionary)
  const image = createAttachmentImage(props)
  const body = (): JSX.Element => {
    const current = image.latest
    if (!current) return <div class="tsk-gallery-loading" aria-busy="true" />
    if (current.status === "ready") return <img src={current.url} alt={props.attachment.filename} />
    return (
      <p class="tsk-error" role="alert">
        {t("tasks.attachment.failed", { name: props.attachment.filename })}
      </p>
    )
  }
  return (
    <figure class="tsk-gallery-image" data-testid="task-attachment">
      {body()}
      <figcaption>{props.attachment.filename}</figcaption>
    </figure>
  )
}

export function TaskAttachmentGallery(props: {
  readonly attachments: readonly TaskAttachment[]
  readonly read: (attachmentId: string) => Promise<Blob>
}): JSX.Element {
  const t = useTranslator(tasksDictionary)
  return (
    <Show when={props.attachments.length > 0}>
      <section class="tsk-gallery" aria-label={t("tasks.attachment.images")} data-testid="task-attachments">
        <For each={props.attachments}>
          {(attachment) => <AttachmentImage attachment={attachment} read={props.read} />}
        </For>
      </section>
    </Show>
  )
}
