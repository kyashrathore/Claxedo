import { For, Show } from "solid-js"
import type { SurfaceBoardColumn } from "@claxedo/plugin-api/surface"
import { useTranslator } from "@/i18n"
import { surfaceDictionary } from "../i18n"
import type { DataPath } from "../model"
import type { BoardInteraction } from "./board-interaction"
import { RepeatedProvider } from "./row-actions"
import { SurfaceGroup } from "./surface-children"
import { SurfaceNode } from "./surface-node"
import { useSurfaceReader } from "./surface-runtime"

type BoardItemProps = { readonly id: string; readonly item: string; readonly board: BoardInteraction }

function BoardItem(props: BoardItemProps) {
  const t = useTranslator(surfaceDictionary)
  const entry = () => props.board.entry(props.id)
  const movable = () => {
    const current = entry()
    return current !== undefined && props.board.isMovable(current)
  }
  const grabbed = () => {
    const state = props.board.grab()
    return state.kind === "grabbed" && state.itemId === props.id
  }
  return (
    <Show when={entry()}>
      {(current) => (
        <div
          ref={(element) => props.board.register(props.id, element)}
          data-slot="surface-board-item"
          data-movable={movable() ? "true" : "false"}
          data-grabbed={grabbed() ? "true" : "false"}
          tabIndex={movable() ? 0 : undefined}
          aria-roledescription={movable() ? t("surface.board.movable") : undefined}
          aria-pressed={movable() ? grabbed() : undefined}
          draggable={movable()}
          onKeyDown={(event) => props.board.keyDown(event, current())}
          onDragStart={(event) => {
            event.dataTransfer?.setData("text/plain", props.id)
            props.board.dragStart(current())
          }}
          onDragEnd={() => props.board.dragEnd()}
        >
          <SurfaceNode id={props.item} scope={current().path} />
        </div>
      )}
    </Show>
  )
}

export type BoardLaneProps = {
  readonly column: SurfaceBoardColumn
  readonly item: string
  readonly scope: DataPath
  readonly board: BoardInteraction
}

export function BoardLaneView(props: BoardLaneProps) {
  const read = useSurfaceReader()
  const title = () => read.text(props.column.title, props.scope)
  const ids = () => props.board.lane(props.column.key)?.entries.map((entry) => entry.id) ?? []
  return (
    <section data-slot="surface-board-lane" data-drop-target={props.board.dropTarget() === props.column.key ? "true" : "false"} aria-label={title()}>
      <header data-slot="surface-board-lane-header">
        <h3 data-slot="surface-board-lane-title">{title()}</h3>
        <span data-slot="surface-board-lane-count">{ids().length}</span>
        <SurfaceGroup ids={props.column.headerActions} scope={props.scope} slot="surface-actions" />
      </header>
      <div
        data-slot="surface-board-items"
        onDragOver={(event) => props.board.dragOver(event, props.column.key)}
        onDrop={(event) => props.board.drop(event, props.column.key)}
      >
        <RepeatedProvider value={true}>
          <For each={ids()}>{(id) => <BoardItem id={id} item={props.item} board={props.board} />}</For>
        </RepeatedProvider>
      </div>
      <Show when={props.column.footer}>{(footer) => <SurfaceNode id={footer()} scope={props.scope} />}</Show>
    </section>
  )
}
