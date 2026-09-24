import { createSignal, type Accessor, type Setter } from "solid-js"
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

type DraftState = {
  readonly marks: Accessor<ImageMark[]>
  readonly setMarks: Setter<ImageMark[]>
  readonly editing: Accessor<Editing | undefined>
  readonly setEditing: Setter<Editing | undefined>
  readonly comment: Accessor<string>
  readonly setComment: Setter<string>
}

function settle(state: DraftState): void {
  const current = state.editing()
  if (!current) return
  const text = state.comment().trim()
  if (text) state.setMarks((list) => list.map((mark, index) => (index === current.index ? { ...mark, comment: text } : mark)))
  else if (current.isNew || !state.marks()[current.index]?.comment) state.setMarks((list) => list.filter((_, index) => index !== current.index))
  state.setEditing(undefined)
}

function remove(state: DraftState, target: number): void {
  state.setMarks((list) => list.filter((_, index) => index !== target))
  state.setEditing(undefined)
}

function open(state: DraftState, index: number): void {
  if (state.editing()?.index === index) return
  settle(state)
  const mark = state.marks()[index]
  if (!mark) return
  state.setComment(mark.comment)
  state.setEditing({ index, isNew: false })
}

function cancel(state: DraftState): void {
  const current = state.editing()
  if (!current) return
  if (current.isNew) remove(state, current.index)
  else state.setEditing(undefined)
}

export function createMarkDraft(initial: readonly ImageMark[], focusIndex: number | undefined) {
  const [marks, setMarks] = createSignal(initial.map((mark) => ({ ...mark })))
  const focused = focusIndex === undefined ? undefined : marks()[focusIndex]
  const [editing, setEditing] = createSignal<Editing | undefined>(focused && focusIndex !== undefined ? { index: focusIndex, isNew: false } : undefined)
  const [comment, setComment] = createSignal(focused?.comment ?? "")
  const state: DraftState = { marks, setMarks, editing, setEditing, comment, setComment }
  return {
    marks,
    editing,
    comment,
    setComment,
    settle: () => settle(state),
    remove: (index: number) => remove(state, index),
    add: (mark: ImageMark) => {
      setMarks((list) => [...list, mark])
      setComment("")
      setEditing({ index: marks().length - 1, isNew: true })
    },
    open: (index: number) => open(state, index),
    cancel: () => cancel(state),
  }
}

export type MarkDraft = ReturnType<typeof createMarkDraft>
