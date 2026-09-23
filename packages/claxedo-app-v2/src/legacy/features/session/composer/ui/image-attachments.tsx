import { Component, For, Show, createSignal } from "solid-js"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import type { ImageAttachmentPart } from "@/features/session/providers/prompt"
import { ImageMarkLayer } from "@/features/session/image-marks/mark-layer"
import type { Size } from "@/features/session/image-marks/marks"

type PromptImageAttachmentsProps = {
  attachments: ImageAttachmentPart[]
  firstMarkNumber: (id: string) => number
  onOpen: (attachment: ImageAttachmentPart) => void
  onRemove: (id: string) => void
  removeLabel: string
  markLabel: string
}

const fallbackClass = "size-16 rounded-md bg-surface-base flex items-center justify-center border border-border-base"
const imageClass =
  "size-16 rounded-md object-cover border border-border-base hover:border-border-strong-base transition-colors"
const removeClass =
  "absolute -top-1.5 -right-1.5 size-5 rounded-full bg-surface-raised-stronger-non-alpha border border-border-base flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-surface-raised-base-hover"
const markClass =
  "absolute -top-1.5 -left-1.5 size-5 rounded-full bg-surface-raised-stronger-non-alpha border border-border-base flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-surface-raised-base-hover"
const nameClass = "absolute bottom-0 left-0 right-0 px-1 py-0.5 bg-black/50 rounded-b-md"

const ImageThumbnail: Component<{
  attachment: ImageAttachmentPart
  firstMarkNumber: number
  onOpen: () => void
  markLabel: string
}> = (props) => {
  const [size, setSize] = createSignal<Size>()
  return (
    <>
      <img
        src={props.attachment.dataUrl}
        alt={props.attachment.filename}
        class={imageClass}
        onLoad={(event) => setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
        onClick={() => props.onOpen()}
      />
      <Show when={props.attachment.marks?.length ? size() : undefined}>
        {(natural) => (
          <svg
            class="absolute inset-0 size-16 rounded-md pointer-events-none"
            viewBox={`0 0 ${natural().width} ${natural().height}`}
            preserveAspectRatio="xMidYMid slice"
          >
            <ImageMarkLayer size={natural()} marks={props.attachment.marks ?? []} firstNumber={props.firstMarkNumber} />
          </svg>
        )}
      </Show>
      <button type="button" onClick={() => props.onOpen()} class={markClass} aria-label={props.markLabel}>
        <Icon name="pencil-line" class="size-3 m-1 text-text-weak" />
      </button>
    </>
  )
}

export const PromptImageAttachments: Component<PromptImageAttachmentsProps> = (props) => {
  return (
    <Show when={props.attachments.length > 0}>
      <div class="flex flex-wrap gap-2 px-3 pt-3">
        <For each={props.attachments}>
          {(attachment) => (
            <Tooltip value={attachment.filename} placement="top" contentClass="break-all">
              <div class="relative group">
                <Show
                  when={attachment.mime.startsWith("image/")}
                  fallback={
                    <div class={fallbackClass}>
                      <Icon name="folder" class="size-6 -m-0.5 text-text-weak" />
                    </div>
                  }
                >
                  <ImageThumbnail
                    attachment={attachment}
                    firstMarkNumber={props.firstMarkNumber(attachment.id)}
                    onOpen={() => props.onOpen(attachment)}
                    markLabel={props.markLabel}
                  />
                </Show>
                <button
                  type="button"
                  onClick={() => props.onRemove(attachment.id)}
                  class={removeClass}
                  aria-label={props.removeLabel}
                >
                  <Icon name="close" class="size-3 m-1 text-text-weak" />
                </button>
                <div class={nameClass}>
                  <span class="text-10-regular text-text-invert-strong truncate block">{attachment.filename}</span>
                </div>
              </div>
            </Tooltip>
          )}
        </For>
      </div>
    </Show>
  )
}
