import { createSignal } from "solid-js"
import type { ImageMark } from "../model"

export type EditingMark = { index: number; isNew: boolean }

function createMarkList(initialMarks: readonly ImageMark[]) {
  const [marks, setMarks] = createSignal(initialMarks.map((mark) => ({ ...mark })))
  const add = (mark: ImageMark) => {
    const index = marks().length
    setMarks((list) => [...list, mark])
    return index
  }
  const remove = (target: number) => setMarks((list) => list.filter((_, index) => index !== target))
  const comment = (target: number, comment: string) =>
    setMarks((list) => list.map((mark, index) => (index === target ? { ...mark, comment } : mark)))
  return { marks, add, remove, comment }
}

export function createMarkEditing(initialMarks: readonly ImageMark[], focusIndex: number | undefined) {
  const list = createMarkList(initialMarks)
  const initial = focusIndex === undefined ? undefined : list.marks()[focusIndex]
  const [editing, setEditing] = createSignal<EditingMark | undefined>(
    initial && focusIndex !== undefined ? { index: focusIndex, isNew: false } : undefined,
  )
  const [draft, setDraft] = createSignal(initial?.comment ?? "")

  const open = (next: EditingMark, comment: string) => {
    setDraft(comment)
    setEditing(next)
  }

  const settle = () => {
    const current = editing()
    if (!current) return
    const comment = draft().trim()
    if (comment) list.comment(current.index, comment)
    else if (current.isNew || !list.marks()[current.index]?.comment) list.remove(current.index)
    setEditing(undefined)
  }

  const remove = (target: number) => {
    list.remove(target)
    setEditing(undefined)
  }

  const add = (mark: ImageMark) => open({ index: list.add(mark), isNew: true }, "")

  const openAt = (index: number) => {
    const mark = list.marks()[index]
    if (mark) open({ index, isNew: false }, mark.comment)
  }

  return { marks: list.marks, editing, draft, setDraft, settle, remove, add, openAt, close: () => setEditing(undefined) }
}
