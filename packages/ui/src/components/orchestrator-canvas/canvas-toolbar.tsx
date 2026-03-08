// ---------------------------------------------------------------------------
// Floating toolbar — zoom +/-, fit, pause/resume, add node, close
// Review phase: approve/discard instead of pause/resume
// ---------------------------------------------------------------------------

import { Show } from "solid-js"
import type { CanvasState } from "./types"
import type { OrchestratorPhase } from "./types"
import type { CanvasActions } from "./canvas-store"

interface CanvasToolbarProps {
  store: CanvasState
  actions: CanvasActions
  contentWidth: number
  contentHeight: number
  viewportWidth: number
  viewportHeight: number
  onClose: () => void
  onAddNode: () => void
  running: boolean
  phase?: OrchestratorPhase
  onSendCommand?: (command: string, payload?: any) => void
  isPaused?: boolean
}

export function CanvasToolbar(props: CanvasToolbarProps) {
  const zoomPercent = () => Math.round(props.store.zoom * 100)
  const isReview = () => props.phase === "review"
  const isExecuting = () => props.phase === "executing" || props.phase === "paused"

  return (
    <div data-component="oc-canvas-toolbar">
      {/* Zoom out */}
      <button
        data-slot="oc-toolbar-btn"
        onClick={() => props.actions.zoomOut()}
        title="Zoom out"
      >
        −
      </button>

      <span data-slot="oc-toolbar-zoom">{zoomPercent()}%</span>

      {/* Zoom in */}
      <button
        data-slot="oc-toolbar-btn"
        onClick={() => props.actions.zoomIn()}
        title="Zoom in"
      >
        +
      </button>

      <div data-slot="oc-toolbar-separator" />

      {/* Fit to view */}
      <button
        data-slot="oc-toolbar-btn"
        onClick={() =>
          props.actions.fitToView(
            props.contentWidth,
            props.contentHeight,
            props.viewportWidth,
            props.viewportHeight,
          )
        }
        title="Fit to view (F)"
      >
        {"\u229E"}
      </button>

      {/* Auto-arrange: reset manual overrides + re-fit */}
      <button
        data-slot="oc-toolbar-btn"
        onClick={() => {
          props.actions.resetLayout()
          // Defer fit-to-view so the layout memo recomputes first
          setTimeout(() => {
            props.actions.fitToView(
              props.contentWidth,
              props.contentHeight,
              props.viewportWidth,
              props.viewportHeight,
            )
          }, 50)
        }}
        title="Auto-arrange (A)"
      >
        {"\u21BB"}
      </button>

      <div data-slot="oc-toolbar-separator" />

      {/* Review phase: Approve / Discard */}
      <Show when={isReview() && props.onSendCommand}>
        <button
          data-slot="oc-toolbar-btn"
          data-variant="approve"
          onClick={() => props.onSendCommand!("approve")}
          title="Start Execution"
        >
          {"\u25B6"}
        </button>
        <button
          data-slot="oc-toolbar-btn"
          data-variant="danger"
          onClick={() => props.onSendCommand!("cancel")}
          title="Discard"
        >
          {"\u2715"}
        </button>
      </Show>

      {/* Execution phase: Pause / Resume */}
      <Show when={isExecuting() && props.running}>
        <Show when={!props.isPaused}>
          <button
            data-slot="oc-toolbar-btn"
            onClick={() => props.onSendCommand?.("pause")}
            title="Pause (Space)"
          >
            {"\u23F8"}
          </button>
        </Show>
        <Show when={props.isPaused}>
          <button
            data-slot="oc-toolbar-btn"
            data-active={true}
            onClick={() => props.onSendCommand?.("resume")}
            title="Resume (Space)"
          >
            {"\u25B6"}
          </button>
        </Show>
      </Show>

      {/* Add node — available during review and execution */}
      <Show when={props.running && (isReview() || isExecuting())}>
        <button
          data-slot="oc-toolbar-btn"
          onClick={props.onAddNode}
          title="Add node"
        >
          {"+\u229E"}
        </button>
      </Show>

      <div data-slot="oc-toolbar-separator" />

      {/* Close */}
      <button
        data-slot="oc-toolbar-btn"
        onClick={props.onClose}
        title="Close canvas (Esc)"
      >
        {"\u2715"}
      </button>
    </div>
  )
}
