import { For } from "solid-js"
import type { SurfaceNodeProps } from "../model"
import { createBoardInteraction } from "./board-interaction"
import { BoardLaneView } from "./board-lane"

export function BoardView(props: SurfaceNodeProps<"Board">) {
  const board = createBoardInteraction(props)
  return (
    <div data-slot="surface-board" data-layout={props.def.layout ?? "columns"}>
      <For each={props.def.columns}>{(column) => <BoardLaneView column={column} item={props.def.item} scope={props.scope} board={board} />}</For>
      <div data-slot="surface-board-status" role="status" aria-live="polite" class="sr-only">
        {board.announcement()}
      </div>
    </div>
  )
}
