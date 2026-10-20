import { createSignal, type Accessor } from "solid-js"
import type { Machine } from "@/lib/machine"
import { boardKeyAction, grabbedMove, pointerDropIndex, type BoardGrab, type BoardGrabEvent, type BoardLayout } from "../board-moves"
import type { BoardEntry, BoardLane, BoardMove } from "../board-pending"

export type BoardControls = {
  readonly dropTarget: Accessor<string | undefined>
  readonly keyDown: (event: KeyboardEvent, entry: BoardEntry) => void
  readonly dragStart: (entry: BoardEntry) => void
  readonly dragEnd: () => void
  readonly dragOver: (event: DragEvent, column: string) => void
  readonly drop: (event: DragEvent, column: string) => void
}

type Announcer = {
  readonly picked: () => void
  readonly cancelled: () => void
  readonly at: (key: "surface.board.moved" | "surface.board.dropped", column: string, index: number) => void
}

export type BoardMoveSource = {
  readonly lanes: Accessor<readonly BoardLane[]>
  readonly grab: Machine<BoardGrab, BoardGrabEvent>
  readonly announcer: Announcer
  readonly element: (id: string) => HTMLElement | undefined
  readonly canStart: (entry: BoardEntry) => boolean
  readonly commit: (move: BoardMove) => void
}

function slotOf(lanes: readonly BoardLane[], id: string) {
  for (const lane of lanes) {
    const index = lane.entries.findIndex((entry) => entry.id === id)
    if (index !== -1) return { column: lane.key, index }
  }
  return undefined
}

function layoutOf(lanes: readonly BoardLane[]): BoardLayout {
  return lanes.map((lane) => ({ key: lane.key, ids: lane.entries.map((entry) => entry.id) }))
}

function toggleGrab(board: BoardMoveSource, entry: BoardEntry) {
  const state = board.grab.state()
  if (state.kind === "grabbed") {
    board.grab.send({ type: "dropped" })
    board.announcer.at("surface.board.dropped", state.at.column, state.at.index)
    const move = grabbedMove(state)
    if (move) board.commit(move)
    return state.itemId
  }
  const from = slotOf(board.lanes(), entry.id)
  if (!from || !board.canStart(entry)) return undefined
  board.grab.send({ type: "grabbed", itemId: entry.id, from })
  board.announcer.picked()
  return undefined
}

export function createBoardKeyboard(board: BoardMoveSource): Pick<BoardControls, "keyDown"> {
  const refocus = (id: string) => queueMicrotask(() => board.element(id)?.focus())
  return {
    keyDown: (event, entry) => {
      if (event.target !== event.currentTarget) return
      const action = boardKeyAction(event.key, board.grab.state().kind === "grabbed")
      if (action.kind === "none") return
      event.preventDefault()
      if (action.kind === "toggle") {
        const dropped = toggleGrab(board, entry)
        if (dropped) refocus(dropped)
        return
      }
      if (action.kind === "cancel") {
        board.grab.send({ type: "cancelled" })
        board.announcer.cancelled()
        return refocus(entry.id)
      }
      board.grab.send({ type: "stepped", step: action.step, layout: layoutOf(board.lanes()) })
      const state = board.grab.state()
      if (state.kind === "grabbed") board.announcer.at("surface.board.moved", state.at.column, state.at.index)
      refocus(entry.id)
    },
  }
}

type Drag = { readonly itemId: string; readonly fromColumn: string; readonly fromIndex: number }

function dropIndex(board: BoardMoveSource, event: DragEvent, column: string, itemId: string) {
  const ids = board.lanes().find((lane) => lane.key === column)?.entries.map((entry) => entry.id) ?? []
  const midpoints = ids.filter((id) => id !== itemId).flatMap((id) => {
    const box = board.element(id)?.getBoundingClientRect()
    return box ? [box.top + box.height / 2] : []
  })
  return pointerDropIndex(midpoints, event.clientY)
}

export function createBoardPointer(board: BoardMoveSource): Omit<BoardControls, "keyDown"> {
  const [drag, setDrag] = createSignal<Drag>()
  const [dropTarget, setDropTarget] = createSignal<string>()
  const end = () => {
    setDrag(undefined)
    setDropTarget(undefined)
  }
  return {
    dropTarget,
    dragStart: (entry) => {
      const from = slotOf(board.lanes(), entry.id)
      if (from && board.canStart(entry)) setDrag({ itemId: entry.id, fromColumn: from.column, fromIndex: from.index })
    },
    dragEnd: end,
    dragOver: (event, column) => {
      if (!drag()) return
      event.preventDefault()
      setDropTarget(column)
    },
    drop: (event, column) => {
      const current = drag()
      if (!current) return
      event.preventDefault()
      const toIndex = dropIndex(board, event, column, current.itemId)
      end()
      board.commit({ ...current, toColumn: column, toIndex })
    },
  }
}
