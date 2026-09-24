import { createSignal } from "solid-js"
import type { ImageMark } from "../model"
import type { Size } from "./marks"

const COMMENT_BOX_WIDTH_PX = 300
const COMMENT_BOX_HEIGHT_PX = 150
const GAP_PX = 12

export function shownSize(natural: Size | undefined, width: number | null, height: number | null) {
  if (!natural || !width || !height) return { visibility: "hidden" as const }
  const scale = Math.min(width / natural.width, height / natural.height, 1)
  return { width: `${natural.width * scale}px`, height: `${natural.height * scale}px` }
}

export function commentBoxPosition(mark: ImageMark, natural: Size | undefined, stageWidth: number | null, stageHeight: number | null) {
  if (!natural || !stageWidth) return {}
  const scale = Math.min(stageWidth / natural.width, (stageHeight ?? 0) / natural.height, 1)
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

type Editing = { index: number; isNew: boolean }

export function createMarkDraft(initial: readonly ImageMark[], focusIndex: number | undefined) {
  const [marks, setMarks] = createSignal(initial.map((mark) => ({ ...mark })))
  const focused = focusIndex === undefined ? undefined : marks()[focusIndex]
  const [editing, setEditing] = createSignal<Editing | undefined>(
    focused && focusIndex !== undefined ? { index: focusIndex, isNew: false } : undefined,
  )
  const [comment, setComment] = createSignal(focused?.comment ?? "")

  const settle = () => {
    const current = editing()
    if (!current) return
    const text = comment().trim()
    if (text) setMarks((list) => list.map((mark, index) => (index === current.index ? { ...mark, comment: text } : mark)))
    else if (current.isNew || !marks()[current.index]?.comment) setMarks((list) => list.filter((_, index) => index !== current.index))
    setEditing(undefined)
  }

  const remove = (target: number) => {
    setMarks((list) => list.filter((_, index) => index !== target))
    setEditing(undefined)
  }

  return {
    marks,
    editing,
    comment,
    setComment,
    settle,
    remove,
    add(mark: ImageMark) {
      const index = marks().length
      setMarks((list) => [...list, mark])
      setComment("")
      setEditing({ index, isNew: true })
    },
    open(index: number) {
      if (editing()?.index === index) return
      settle()
      const mark = marks()[index]
      if (!mark) return
      setComment(mark.comment)
      setEditing({ index, isNew: false })
    },
    cancel() {
      const current = editing()
      if (!current) return
      if (current.isNew) remove(current.index)
      else setEditing(undefined)
    },
  }
}
