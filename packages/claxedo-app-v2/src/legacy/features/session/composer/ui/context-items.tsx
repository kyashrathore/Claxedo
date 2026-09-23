import { Component, For, Show } from "solid-js"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { ClaxedoIconButton as IconButton } from "@/ui/controls/claxedo-icon-button"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { getDirectory, getFilename, getFilenameTruncated } from "@opencode-ai/ui/utils/path"
import type { ContextItem } from "@/features/session/providers/prompt"
import type { NumberedImageMark } from "@/features/session/image-marks/marks"
import { ImageMarkBadge } from "@/features/session/image-marks/mark-badge"

type PromptContextItem = ContextItem & { key: string }

type ContextItemsProps = {
  items: PromptContextItem[]
  active: (item: PromptContextItem) => boolean
  openComment: (item: PromptContextItem) => void
  remove: (item: PromptContextItem) => void
  imageMarks: NumberedImageMark[]
  openImageMark: (entry: NumberedImageMark) => void
  removeImageMark: (entry: NumberedImageMark) => void
  t: (key: string) => string
}

export const PromptContextItems: Component<ContextItemsProps> = (props) => {
  return (
    <Show when={props.items.length > 0 || props.imageMarks.length > 0}>
      <div class="flex flex-nowrap items-start gap-2 p-2 overflow-x-auto no-scrollbar">
        <For each={props.items}>
          {(item) => {
            const directory = getDirectory(item.path)
            const filename = getFilename(item.path)
            const label = getFilenameTruncated(item.path, 14)
            const selected = props.active(item)

            return (
              <Tooltip
                value={
                  <span class="flex max-w-[300px]">
                    <span class="text-text-invert-base truncate-start [unicode-bidi:plaintext] min-w-0">
                      {directory}
                    </span>
                    <span class="shrink-0">{filename}</span>
                  </span>
                }
                placement="top"
                openDelay={2000}
              >
                <div
                  classList={{
                    "group shrink-0 flex flex-col rounded-md pl-2 pr-1 py-1 max-w-[200px] h-12 cursor-default transition-all transition-transform shadow-xs-border hover:shadow-xs-border-hover": true,
                    "hover:bg-surface-interactive-weak": !!item.commentID && !selected,
                    "bg-surface-interactive-hover hover:bg-surface-interactive-hover shadow-xs-border-hover": selected,
                    "bg-background-stronger": !selected,
                  }}
                  onClick={() => props.openComment(item)}
                >
                  <div class="flex items-center gap-1.5">
                    <FileIcon node={{ path: item.path, type: "file" }} class="shrink-0 size-3.5" />
                    <div class="flex items-center text-11-regular min-w-0 font-medium">
                      <span class="text-text-strong whitespace-nowrap">{label}</span>
                      <Show when={item.selection}>
                        {(sel) => (
                          <span class="text-text-weak whitespace-nowrap shrink-0">
                            {sel().startLine === sel().endLine
                              ? `:${sel().startLine}`
                              : `:${sel().startLine}-${sel().endLine}`}
                          </span>
                        )}
                      </Show>
                    </div>
                    <IconButton
                      type="button"
                      icon="close-small"
                      variant="ghost"
                      class="ml-auto size-3.5 text-text-weak hover:text-text-strong transition-all"
                      onClick={(e) => {
                        e.stopPropagation()
                        props.remove(item)
                      }}
                      aria-label={props.t("prompt.context.removeFile")}
                    />
                  </div>
                  <Show when={item.comment}>
                    {(comment) => <div class="text-12-regular text-text-strong ml-5 pr-1 truncate">{comment()}</div>}
                  </Show>
                </div>
              </Tooltip>
            )
          }}
        </For>
        <For each={props.imageMarks}>
          {(entry) => (
            <div
              data-slot="image-mark-chip"
              data-mark-number={entry.number}
              class="group shrink-0 flex flex-col rounded-md pl-2 pr-1 py-1 max-w-[200px] h-12 cursor-default transition-all shadow-xs-border hover:shadow-xs-border-hover bg-background-stronger hover:bg-surface-interactive-weak"
              onClick={() => props.openImageMark(entry)}
            >
              <div class="flex items-start gap-1.5 min-w-0">
                <ImageMarkBadge number={entry.number} />
                <span class="min-w-0 text-12-regular text-text-strong line-clamp-2 break-words">{entry.mark.comment}</span>
                <IconButton
                  type="button"
                  icon="close-small"
                  variant="ghost"
                  class="ml-auto shrink-0 size-3.5 text-text-weak hover:text-text-strong transition-all"
                  onClick={(e) => {
                    e.stopPropagation()
                    props.removeImageMark(entry)
                  }}
                  aria-label={props.t("prompt.imageMarks.remove")}
                />
              </div>
            </div>
          )}
        </For>
      </div>
    </Show>
  )
}
