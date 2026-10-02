import { Show, onMount, type JSX } from "solid-js"
import type { NullableSize } from "@solid-primitives/resize-observer"
import { Button } from "@/ui"
import { LineCommentEditor } from "@/transcript"
import type { ImageMark } from "../model"
import { useComposerText } from "../text"
import type { Size } from "./marks"

const COMMENT_BOX_WIDTH_PX = 300
const COMMENT_BOX_HEIGHT_PX = 150
const GAP_PX = 12

export function commentBoxPosition(mark: ImageMark, natural: Size | undefined, stage: Readonly<NullableSize>): JSX.CSSProperties {
  const stageWidth = stage.width
  if (!natural || !stageWidth) return {}
  const scale = Math.min(stageWidth / natural.width, (stage.height ?? 0) / natural.height, 1)
  const shownWidth = natural.width * scale
  const shownHeight = natural.height * scale
  const margin = (stageWidth - shownWidth) / 2
  const left = mark.x * scale
  const right = (mark.x + mark.width) * scale
  const top = Math.max(0, Math.min(mark.y * scale, shownHeight - COMMENT_BOX_HEIGHT_PX))
  if (shownWidth - right + margin >= COMMENT_BOX_WIDTH_PX + GAP_PX) return { left: `${right + GAP_PX}px`, top: `${top}px` }
  if (left + margin >= COMMENT_BOX_WIDTH_PX + GAP_PX) return { left: `${left - GAP_PX - COMMENT_BOX_WIDTH_PX}px`, top: `${top}px` }
  const below = (mark.y + mark.height) * scale + GAP_PX
  const x = Math.max(-margin, Math.min(left - 12, shownWidth + margin - COMMENT_BOX_WIDTH_PX))
  if (below + COMMENT_BOX_HEIGHT_PX <= shownHeight) return { left: `${x}px`, top: `${below}px` }
  return { left: `${x}px`, bottom: `${shownHeight - mark.y * scale + GAP_PX}px` }
}

export function MarkCommentBox(props: {
  isNew: boolean
  value: string
  position: JSX.CSSProperties
  onInput: (value: string) => void
  onDelete: () => void
  onCancel: () => void
  onSubmit: (comment: string) => void
}) {
  const t = useComposerText()
  return (
    <div
      ref={(el) => onMount(() => el.querySelector("textarea")?.focus())}
      data-owns-escape
      class="absolute z-10 flex flex-col items-end gap-1"
      style={{ width: `${COMMENT_BOX_WIDTH_PX}px`, ...props.position }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <Show when={!props.isNew}>
        <Button size="small" variant="ghost" onClick={() => props.onDelete()}>
          {t("prompt.imageMarks.delete")}
        </Button>
      </Show>
      <LineCommentEditor
        inline
        class="w-full"
        value={props.value}
        onInput={props.onInput}
        onCancel={() => props.onCancel()}
        onSubmit={props.onSubmit}
      />
    </div>
  )
}
