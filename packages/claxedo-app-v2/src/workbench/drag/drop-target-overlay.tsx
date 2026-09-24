import type { Edge } from "../types"

const zones: readonly Edge[] = ["top", "bottom", "left", "right"]

export function DropTargetOverlay(props: { edge: Edge }) {
  return (
    <div class="workbench-drop-overlay">
      {zones.map((edge) => (
        <div class="workbench-drop-zone" data-edge={edge} data-active={props.edge === edge ? "true" : undefined} />
      ))}
    </div>
  )
}
