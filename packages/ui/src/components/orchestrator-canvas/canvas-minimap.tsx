// ---------------------------------------------------------------------------
// 200x120 minimap — scaled-down graph + draggable viewport rectangle
// Theme-aware: uses CSS custom properties for colours.
// ---------------------------------------------------------------------------

import { createMemo, For, Show } from "solid-js"
import type { OrchestratorNode, OrchestratorEdge, CanvasState } from "./types"
import type { CanvasActions } from "./canvas-store"
import { EXPANDED_LAYOUT, statusColors } from "./types"
import { layoutDAG, edgePath } from "./layout"

interface CanvasMinimapProps {
  nodes: OrchestratorNode[]
  edges: OrchestratorEdge[]
  store: CanvasState
  actions: CanvasActions
  viewportWidth: number
  viewportHeight: number
}

const MINIMAP_W = 200
const MINIMAP_H = 120

export function CanvasMinimap(props: CanvasMinimapProps) {
  const layout = createMemo(() =>
    layoutDAG(props.nodes, props.edges, EXPANDED_LAYOUT, undefined, props.store.layoutVersion),
  )

  const scale = createMemo(() => {
    const { width, height } = layout()
    if (width === 0 || height === 0) return 1
    return Math.min(MINIMAP_W / width, MINIMAP_H / height) * 0.9
  })

  const offset = createMemo(() => {
    const { width, height } = layout()
    const s = scale()
    return {
      x: (MINIMAP_W - width * s) / 2,
      y: (MINIMAP_H - height * s) / 2,
    }
  })

  // Viewport rectangle in minimap coordinates
  const viewRect = createMemo(() => {
    const s = scale()
    const { pan, zoom } = props.store
    const o = offset()
    return {
      x: o.x + (-pan.x / zoom) * s,
      y: o.y + (-pan.y / zoom) * s,
      w: (props.viewportWidth / zoom) * s,
      h: (props.viewportHeight / zoom) * s,
    }
  })

  let isDragging = false
  let dragStartPanX = 0
  let dragStartPanY = 0
  let dragStartX = 0
  let dragStartY = 0

  const onMinimapPointerDown = (e: PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    isDragging = true
    dragStartPanX = props.store.pan.x
    dragStartPanY = props.store.pan.y
    dragStartX = e.clientX
    dragStartY = e.clientY
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
  }

  const onMinimapPointerMove = (e: PointerEvent) => {
    if (!isDragging) return
    const s = scale()
    const { zoom } = props.store
    const dx = e.clientX - dragStartX
    const dy = e.clientY - dragStartY
    // Movement in minimap pixels → canvas pan adjustment
    props.actions.setPan(
      dragStartPanX - (dx / s) * zoom,
      dragStartPanY - (dy / s) * zoom,
    )
  }

  const onMinimapPointerUp = (e: PointerEvent) => {
    isDragging = false
    ;(e.currentTarget as Element).releasePointerCapture(e.pointerId)
  }

  return (
    <div
      data-component="oc-canvas-minimap"
      onPointerDown={onMinimapPointerDown}
      onPointerMove={onMinimapPointerMove}
      onPointerUp={onMinimapPointerUp}
    >
      <svg width={MINIMAP_W} height={MINIMAP_H}>
        <g transform={`translate(${offset().x}, ${offset().y}) scale(${scale()})`}>
          {/* Edges */}
          <For each={props.edges}>
            {(edge) => {
              const s = () => layout().positions.get(edge.source)
              const t = () => layout().positions.get(edge.target)
              return (
                <Show when={s() && t()}>
                  <path
                    d={edgePath(s()!, t()!, EXPANDED_LAYOUT.nodeW, EXPANDED_LAYOUT.nodeH)}
                    fill="none"
                    stroke="var(--border-weak-base)"
                    stroke-width="1"
                  />
                </Show>
              )
            }}
          </For>

          {/* Nodes */}
          <For each={props.nodes}>
            {(node) => {
              const pos = () => layout().positions.get(node.id)
              const c = () => statusColors(node.status)
              return (
                <Show when={pos()}>
                  {(p) => (
                    <rect
                      x={p().x}
                      y={p().y}
                      width={EXPANDED_LAYOUT.nodeW}
                      height={EXPANDED_LAYOUT.nodeH}
                      rx="4"
                      fill={c().dot}
                      opacity="0.6"
                    />
                  )}
                </Show>
              )
            }}
          </For>
        </g>

        {/* Viewport rectangle */}
        <rect
          x={viewRect().x}
          y={viewRect().y}
          width={viewRect().w}
          height={viewRect().h}
          fill="var(--surface-interactive-weak)"
          stroke="var(--border-interactive-base)"
          stroke-width="1"
          rx="2"
        />
      </svg>
    </div>
  )
}
