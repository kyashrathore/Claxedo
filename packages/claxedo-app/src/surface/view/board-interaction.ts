import { createMemo, createSignal, onCleanup, untrack, type Accessor } from "solid-js"
import { useTranslator } from "@/i18n"
import { machine } from "@/lib/machine"
import { boardGrabTransition, grabbedMove, isMoveToElsewhere, type BoardGrab, type BoardGrabEvent } from "../board-moves"
import { arrangeBoard, patchSettlesMove, type BoardEntry, type BoardLane, type BoardLaneSource, type BoardMove } from "../board-pending"
import { resolvePath } from "../data-path"
import { surfaceDictionary } from "../i18n"
import type { SurfaceNodeProps } from "../model"
import { createBoardKeyboard, createBoardPointer, type BoardControls } from "./board-input"
import { useSurfaceReader, useSurfaceRuntime } from "./surface-runtime"

export type BoardInteraction = BoardControls & {
  readonly lane: (key: string) => BoardLane | undefined
  readonly entry: (id: string) => BoardEntry | undefined
  readonly grab: Accessor<BoardGrab>
  readonly announcement: Accessor<string>
  readonly isMovable: (entry: BoardEntry) => boolean
  readonly register: (id: string, element: HTMLElement) => void
}

function createLaneSources(props: SurfaceNodeProps<"Board">): Accessor<readonly BoardLaneSource[]> {
  const runtime = useSurfaceRuntime()
  return createMemo(() =>
    props.def.columns.map((column) => {
      const path = resolvePath(column.items, props.scope)
      const items = runtime.state.data.read(path)
      return { key: column.key, path, items: Array.isArray(items) ? items : [] }
    }),
  )
}

function createPendingMove(sources: Accessor<readonly BoardLaneSource[]>) {
  const runtime = useSurfaceRuntime()
  const [pending, setPending] = createSignal<BoardMove>()
  onCleanup(
    runtime.state.watchPatches((path) => {
      const move = pending()
      if (move && patchSettlesMove(path, move, untrack(sources))) setPending(undefined)
    }),
  )
  return { pending, setPending }
}

function createAnnouncer(props: SurfaceNodeProps<"Board">) {
  const read = useSurfaceReader()
  const t = useTranslator(surfaceDictionary)
  const [announcement, setAnnouncement] = createSignal("")
  const columnTitle = (key: string) => {
    const column = props.def.columns.find((candidate) => candidate.key === key)
    return column ? read.text(column.title, props.scope) : key
  }
  return {
    announcement,
    picked: () => setAnnouncement(t("surface.board.grabbed")),
    cancelled: () => setAnnouncement(t("surface.board.cancelled")),
    at: (key: "surface.board.moved" | "surface.board.dropped", column: string, index: number) =>
      setAnnouncement(t(key, { column: columnTitle(column), position: index + 1 })),
  }
}

function createElementRegistry() {
  const elements = new Map<string, HTMLElement>()
  return {
    element: (id: string) => elements.get(id),
    register: (id: string, element: HTMLElement) => {
      elements.set(id, element)
      onCleanup(() => {
        if (elements.get(id) === element) elements.delete(id)
      })
    },
  }
}

export function createBoardInteraction(props: SurfaceNodeProps<"Board">): BoardInteraction {
  const runtime = useSurfaceRuntime()
  const sources = createLaneSources(props)
  const { pending, setPending } = createPendingMove(sources)
  const grab = machine<BoardGrab, BoardGrabEvent>({ kind: "idle" }, boardGrabTransition)
  const lanes = createMemo(() => arrangeBoard(sources(), props.def.itemKey, grabbedMove(grab.state()) ?? pending()))
  const byId = createMemo(() => new Map(lanes().flatMap((lane) => lane.entries.map((entry) => [entry.id, entry] as const))))
  const sortable = () => props.def.move !== undefined && runtime.source.kind !== "agent" && !runtime.actionsDisabled()
  const isMovable = (entry: BoardEntry) =>
    sortable() && entry.keyed && (props.def.movable === undefined || runtime.state.data.read([...entry.path, props.def.movable]) === true)
  const commit = (move: BoardMove) => {
    if (!isMoveToElsewhere(move)) return
    setPending(move)
    runtime.fire(props.def.move, props.def.id, props.scope, { ...move })
  }
  const announcer = createAnnouncer(props)
  const registry = createElementRegistry()
  const board = { lanes, grab, announcer, element: registry.element, canStart: (entry: BoardEntry) => isMovable(entry) && pending() === undefined, commit }
  return {
    ...createBoardKeyboard(board),
    ...createBoardPointer(board),
    lane: (key) => lanes().find((lane) => lane.key === key),
    entry: (id) => byId().get(id),
    grab: grab.state,
    announcement: announcer.announcement,
    isMovable,
    register: registry.register,
  }
}
