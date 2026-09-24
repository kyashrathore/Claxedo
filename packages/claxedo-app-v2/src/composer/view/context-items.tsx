import { For, Show } from "solid-js"
import { FileIcon, IconButton, Tooltip } from "@/ui"
import { ImageMarkBadge } from "@/lib/image-mark-badge"
import type { ContextItem, FileContextItem } from "../model"
import type { NumberedImageMark } from "../marks/marks"

function fileLabel(path: string) {
  const index = path.lastIndexOf("/")
  const name = index >= 0 ? path.slice(index + 1) : path
  return name.length > 18 ? `…${name.slice(-16)}` : name
}

function lines(item: FileContextItem) {
  const selection = item.selection
  if (!selection) return ""
  return selection.startLine === selection.endLine ? `:${selection.startLine}` : `:${selection.startLine}-${selection.endLine}`
}

export function ContextItems(props: {
  items: readonly ContextItem[]
  imageMarks: readonly NumberedImageMark[]
  removeLabel: string
  removeMarkLabel: string
  onRemove: (item: ContextItem) => void
  onOpenMark: (mark: NumberedImageMark) => void
  onRemoveMark: (mark: NumberedImageMark) => void
}) {
  return (
    <Show when={props.items.length > 0 || props.imageMarks.length > 0}>
      <div data-slot="composer-context">
        <For each={props.items}>
          {(item) => (
            <Tooltip value={item.type === "file" ? item.path : item.label} placement="top" openDelay={1200}>
              <div data-slot="composer-chip" data-kind={item.type}>
                <div data-slot="composer-chip-row">
                  <Show when={item.type === "file" && item} fallback={<span data-slot="composer-chip-label">{item.type === "text" ? item.label : ""}</span>}>
                    {(file) => (
                      <>
                        <FileIcon node={{ path: file().path, type: "file" }} class="shrink-0" />
                        <span data-slot="composer-chip-label">
                          {fileLabel(file().path)}
                          <span data-slot="composer-chip-muted">{lines(file())}</span>
                        </span>
                      </>
                    )}
                  </Show>
                  <IconButton
                    type="button"
                    icon="close-small"
                    size="small"
                    variant="ghost"
                    aria-label={props.removeLabel}
                    onClick={(event: MouseEvent) => {
                      event.stopPropagation()
                      props.onRemove(item)
                    }}
                  />
                </div>
                <Show when={item.type === "file" && item.comment}>
                  {(comment) => <div data-slot="composer-chip-comment">{comment()}</div>}
                </Show>
              </div>
            </Tooltip>
          )}
        </For>
        <For each={props.imageMarks}>
          {(entry) => (
            <div data-slot="composer-chip" data-kind="mark" data-mark-number={entry.number} onClick={() => props.onOpenMark(entry)}>
              <div data-slot="composer-chip-row">
                <ImageMarkBadge number={entry.number} />
                <span data-slot="composer-chip-comment">{entry.mark.comment}</span>
                <IconButton
                  type="button"
                  icon="close-small"
                  size="small"
                  variant="ghost"
                  aria-label={props.removeMarkLabel}
                  onClick={(event: MouseEvent) => {
                    event.stopPropagation()
                    props.onRemoveMark(entry)
                  }}
                />
              </div>
            </div>
          )}
        </For>
      </div>
    </Show>
  )
}
