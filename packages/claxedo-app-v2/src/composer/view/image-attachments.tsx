import { For, Show, createSignal } from "solid-js"
import { Icon, IconButton, Tooltip } from "@/ui"
import type { ImagePart } from "../model"
import { ImageMarkLayer } from "../marks/layer"
import type { Size } from "../marks/marks"

function Thumbnail(props: { attachment: ImagePart; firstMarkNumber: number; markLabel: string; onOpen: () => void }) {
  const [size, setSize] = createSignal<Size>()
  return (
    <>
      <img
        src={props.attachment.dataUrl}
        alt={props.attachment.filename}
        data-slot="composer-thumbnail"
        onLoad={(event) => setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
        onClick={props.onOpen}
      />
      <Show when={props.attachment.marks?.length ? size() : undefined}>
        {(natural) => (
          <svg data-slot="composer-thumbnail-marks" viewBox={`0 0 ${natural().width} ${natural().height}`} preserveAspectRatio="xMidYMid slice">
            <ImageMarkLayer size={natural()} marks={props.attachment.marks ?? []} firstNumber={props.firstMarkNumber} />
          </svg>
        )}
      </Show>
      <IconButton
        type="button"
        icon="pencil-line"
        size="small"
        variant="neutral"
        data-slot="composer-thumbnail-mark"
        aria-label={props.markLabel}
        onClick={props.onOpen}
      />
    </>
  )
}

export function ImageAttachments(props: {
  attachments: readonly ImagePart[]
  firstMarkNumber: (id: string) => number
  removeLabel: string
  markLabel: string
  onOpen: (attachment: ImagePart) => void
  onRemove: (id: string) => void
}) {
  return (
    <Show when={props.attachments.length > 0}>
      <div data-slot="composer-attachments">
        <For each={props.attachments}>
          {(attachment) => (
            <Tooltip value={attachment.filename} placement="top">
              <div data-slot="composer-attachment" data-attachment={attachment.id}>
                <Show
                  when={attachment.mime.startsWith("image/")}
                  fallback={
                    <div data-slot="composer-thumbnail" data-kind="file">
                      <Icon name="file" size="large" />
                    </div>
                  }
                >
                  <Thumbnail
                    attachment={attachment}
                    firstMarkNumber={props.firstMarkNumber(attachment.id)}
                    markLabel={props.markLabel}
                    onOpen={() => props.onOpen(attachment)}
                  />
                </Show>
                <IconButton
                  type="button"
                  icon="close-small"
                  size="small"
                  variant="neutral"
                  data-slot="composer-thumbnail-remove"
                  aria-label={props.removeLabel}
                  onClick={() => props.onRemove(attachment.id)}
                />
                <div data-slot="composer-thumbnail-name">{attachment.filename}</div>
              </div>
            </Tooltip>
          )}
        </For>
      </div>
    </Show>
  )
}
