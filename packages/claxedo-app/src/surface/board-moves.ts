import { unreachable } from "@/lib/machine"
import type { BoardMove } from "./board-pending"

export type BoardSlot = { readonly column: string; readonly index: number }

export type BoardLayout = readonly { readonly key: string; readonly ids: readonly string[] }[]

export type BoardStep = "up" | "down" | "left" | "right"

export type BoardGrab = { readonly kind: "idle" } | { readonly kind: "grabbed"; readonly itemId: string; readonly from: BoardSlot; readonly at: BoardSlot }

export type BoardGrabEvent =
  | { readonly type: "grabbed"; readonly itemId: string; readonly from: BoardSlot }
  | { readonly type: "stepped"; readonly step: BoardStep; readonly layout: BoardLayout }
  | { readonly type: "dropped" }
  | { readonly type: "cancelled" }

function roomIn(layout: BoardLayout, column: number, itemId: string): number {
  return layout[column]?.ids.filter((id) => id !== itemId).length ?? 0
}

function stepped(state: Extract<BoardGrab, { kind: "grabbed" }>, step: BoardStep, layout: BoardLayout): BoardGrab {
  const column = layout.findIndex((lane) => lane.key === state.at.column)
  if (column === -1) return state
  if (step === "up" || step === "down") {
    const index = Math.min(Math.max(state.at.index + (step === "up" ? -1 : 1), 0), roomIn(layout, column, state.itemId))
    return index === state.at.index ? state : { ...state, at: { column: state.at.column, index } }
  }
  const target = column + (step === "left" ? -1 : 1)
  const lane = layout[target]
  if (!lane) return state
  return { ...state, at: { column: lane.key, index: Math.min(state.at.index, roomIn(layout, target, state.itemId)) } }
}

export function boardGrabTransition(state: BoardGrab, event: BoardGrabEvent): BoardGrab {
  switch (event.type) {
    case "grabbed":
      return state.kind === "idle" ? { kind: "grabbed", itemId: event.itemId, from: event.from, at: event.from } : state
    case "stepped":
      return state.kind === "grabbed" ? stepped(state, event.step, event.layout) : state
    case "dropped":
    case "cancelled":
      return { kind: "idle" }
    default:
      return unreachable(event)
  }
}

export function grabbedMove(state: BoardGrab): BoardMove | undefined {
  if (state.kind !== "grabbed") return undefined
  return { itemId: state.itemId, fromColumn: state.from.column, fromIndex: state.from.index, toColumn: state.at.column, toIndex: state.at.index }
}

export function isMoveToElsewhere(move: BoardMove): boolean {
  return move.fromColumn !== move.toColumn || move.fromIndex !== move.toIndex
}

const STEP_KEYS: Readonly<Record<string, BoardStep>> = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" }

export type BoardKeyAction = { readonly kind: "toggle" } | { readonly kind: "step"; readonly step: BoardStep } | { readonly kind: "cancel" } | { readonly kind: "none" }

export function boardKeyAction(key: string, grabbed: boolean): BoardKeyAction {
  if (key === " " || key === "Enter") return { kind: "toggle" }
  if (!grabbed) return { kind: "none" }
  if (key === "Escape") return { kind: "cancel" }
  const step = STEP_KEYS[key]
  return step ? { kind: "step", step } : { kind: "none" }
}

export function pointerDropIndex(midpoints: readonly number[], pointerY: number): number {
  return midpoints.filter((midpoint) => midpoint < pointerY).length
}
