import { Component, For, Show } from "solid-js"
import type { ComposerTextKey } from "../i18n"
import { ClaxedoIconButton as IconButton, FileIcon, Tooltip, getDirectory, getFilename, getFilenameTruncated } from "@/ui"
import { ImageMarkBadge } from "@/lib/image-mark-badge"
import type { FileContextItem } from "../model"
import type { NumberedImageMark } from "../marks/marks"

type PromptContextItem = FileContextItem

type ContextText = (key: ComposerTextKey) => string

type ContextItemsProps = {
  items: PromptContextItem[]
  active: (item: PromptContextItem) => boolean
  openComment: (item: PromptContextItem) => void
  remove: (item: PromptContextItem) => void
  imageMarks: NumberedImageMark[]
  openImageMark: (entry: NumberedImageMark) => void
  removeImageMark: (entry: NumberedImageMark) => void
  t: ContextText
}

export const PromptContextItems: Component<ContextItemsProps> = (props) => {
  return (
    <Show when={props.items.length > 0 || props.imageMarks.length > 0}>
      <div class="flex flex-nowrap items-start gap-2 p-2 overflow-x-auto no-scrollbar">
        <For each={props.items}>
          {(item) => (
            <FileContextChip
              item={item}
              selected={props.active(item)}
              openComment={props.openComment}
              remove={props.remove}
              t={props.t}
            />
          )}
        </For>
        <For each={props.imageMarks}>
          {(entry) => (
            <ImageMarkChip entry={entry} open={props.openImageMark} remove={props.removeImageMark} t={props.t} />
          )}
        </For>
      </div>
    </Show>
  )
}

function FileContextChip(props: {
  item: PromptContextItem
  selected: boolean
  openComment: (item: PromptContextItem) => void
  remove: (item: PromptContextItem) => void
  t: ContextText
}) {
  const directory = getDirectory(props.item.path)
  const filename = getFilename(props.item.path)
  const label = getFilenameTruncated(props.item.path, 14)

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
          "hover:bg-surface-interactive-weak": !!props.item.commentId && !props.selected,
          "bg-surface-interactive-hover hover:bg-surface-interactive-hover shadow-xs-border-hover": props.selected,
          "bg-background-stronger": !props.selected,
        }}
        onClick={() => props.openComment(props.item)}
      >
        <div class="flex items-center gap-1.5">
          <FileIcon node={{ path: props.item.path, type: "file" }} class="shrink-0 size-3.5" />
          <div class="flex items-center text-11-regular min-w-0 font-medium">
            <span class="text-text-strong whitespace-nowrap">{label}</span>
            <Show when={props.item.selection}>
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
              props.remove(props.item)
            }}
            aria-label={props.t("prompt.context.removeFile")}
          />
        </div>
        <Show when={props.item.comment}>
          {(comment) => <div class="text-12-regular text-text-strong ml-5 pr-1 truncate">{comment()}</div>}
        </Show>
      </div>
    </Tooltip>
  )
}

function ImageMarkChip(props: {
  entry: NumberedImageMark
  open: (entry: NumberedImageMark) => void
  remove: (entry: NumberedImageMark) => void
  t: ContextText
}) {
  return (
    <div
      data-mark-number={props.entry.number}
      class="group shrink-0 flex flex-col rounded-md pl-2 pr-1 py-1 max-w-[200px] h-12 cursor-default transition-all shadow-xs-border hover:shadow-xs-border-hover bg-background-stronger hover:bg-surface-interactive-weak"
      onClick={() => props.open(props.entry)}
    >
      <div class="flex items-start gap-1.5 min-w-0">
        <ImageMarkBadge number={props.entry.number} />
        <span class="min-w-0 text-12-regular text-text-strong line-clamp-2 break-words">{props.entry.mark.comment}</span>
        <IconButton
          type="button"
          icon="close-small"
          variant="ghost"
          class="ml-auto shrink-0 size-3.5 text-text-weak hover:text-text-strong transition-all"
          onClick={(e) => {
            e.stopPropagation()
            props.remove(props.entry)
          }}
          aria-label={props.t("prompt.imageMarks.remove")}
        />
      </div>
    </div>
  )
}
