import { For, Show, createEffect, createResource, onCleanup, type JSX } from "solid-js"
import type { TaskAttachment } from "@claxedo/tasks"

export type TaskAttachmentGalleryProps = {
  attachments: readonly TaskAttachment[]
  /** The bytes of one attachment, fetched under the same request the task read travelled by. */
  read: (attachmentId: string) => Promise<Blob>
}

/**
 * Fetched rather than linked: an `<img src>` to the attachment route would
 * carry none of the headers the signed reads need, so the bytes come through
 * the client and are shown from an object URL the image gives back on unmount.
 */
type Loaded = { status: "ready"; url: string } | { status: "failed" }

function AttachmentImage(props: { attachment: TaskAttachment; read: (attachmentId: string) => Promise<Blob> }) {
  let disposed = false
  let fetchGeneration = 0
  onCleanup(() => {
    disposed = true
  })
  const [image] = createResource(() => props.attachment.id, async (attachmentId): Promise<Loaded> => {
    const generation = ++fetchGeneration
    try {
      const blob = await props.read(attachmentId)
      const url = URL.createObjectURL(blob)
      // A result Solid drops still owns its URL: the component may be gone, or
      // a newer fetch may have superseded this one (only the latest resolution
      // lands in `latest`, so a discarded value's cleanup never runs).
      if (disposed || generation !== fetchGeneration) {
        URL.revokeObjectURL(url)
        return { status: "failed" }
      }
      return { status: "ready", url }
    } catch {
      return { status: "failed" }
    }
  })
  createEffect(() => {
    const current = image.latest
    onCleanup(() => {
      if (current?.status === "ready") URL.revokeObjectURL(current.url)
    })
  })
  const body = (): JSX.Element => {
    const current = image.latest
    if (!current) return <div class="tsk-gallery-loading" aria-busy="true" />
    switch (current.status) {
      case "ready":
        return <img src={current.url} alt={props.attachment.filename} />
      case "failed":
        return (
          <p class="tsk-error" role="alert">
            {props.attachment.filename} could not be loaded.
          </p>
        )
      default: {
        const exhaustive: never = current
        return exhaustive
      }
    }
  }
  return (
    <figure class="tsk-gallery-image" data-testid="task-attachment">
      {body()}
      <figcaption>{props.attachment.filename}</figcaption>
    </figure>
  )
}

export function TaskAttachmentGallery(props: TaskAttachmentGalleryProps) {
  return (
    <Show when={props.attachments.length > 0}>
      <section class="tsk-gallery" aria-label="Images" data-testid="task-attachments">
        <For each={props.attachments}>{(attachment) => <AttachmentImage attachment={attachment} read={props.read} />}</For>
      </section>
    </Show>
  )
}
