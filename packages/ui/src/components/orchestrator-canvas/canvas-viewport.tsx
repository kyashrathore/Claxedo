// ---------------------------------------------------------------------------
// Main SVG viewport — transform group, grid, edge layer, node layer
// Review phase adds right-click context menu on nodes
// ---------------------------------------------------------------------------

import { createMemo, createSignal, For, Show } from "solid-js"
import type { OrchestratorNode, OrchestratorEdge, CanvasState, NodePos, OrchestratorPhase } from "./types"
import type { CanvasActions } from "./canvas-store"
import { EXPANDED_LAYOUT } from "./types"
import { layoutDAG } from "./layout"
import { usePanZoom } from "./use-pan-zoom"
import { useNodeDrag } from "./use-node-drag"
import { GridBackground } from "./grid-background"
import { CanvasEdge } from "./canvas-edge"
import { CanvasNodeCard } from "./canvas-node-card"

interface CanvasViewportProps {
  nodes: OrchestratorNode[]
  edges: OrchestratorEdge[]
  store: CanvasState
  actions: CanvasActions
  navigateTo: (sessionID: string) => void
  phase?: OrchestratorPhase
  onSendCommand?: (command: string, payload?: any) => void
}

interface ContextMenuState {
  x: number
  y: number
  nodeId: string
}

export function CanvasViewport(props: CanvasViewportProps) {
  let svgRef: SVGSVGElement | undefined

  // Base layout — only recomputes when nodes/edges/version change.
  // Does NOT include drag overrides (those are applied at lookup time).
  const baseLayout = createMemo(() =>
    layoutDAG(props.nodes, props.edges, EXPANDED_LAYOUT, undefined, props.store.layoutVersion),
  )

  // Position lookup: override (drag) takes priority, then base layout.
  // Each call reads the store proxy directly, so SolidJS tracks per-node.
  const getPos = (nodeId: string): NodePos | undefined => {
    const override = props.store.nodeOverrides[nodeId]
    if (override) return override as NodePos
    return baseLayout().positions.get(nodeId)
  }

  const panZoom = usePanZoom({
    store: props.store,
    actions: props.actions,
    svgRef: () => svgRef,
  })

  const nodeDrag = useNodeDrag({
    store: props.store,
    actions: props.actions,
    svgRef: () => svgRef,
  })

  const transformStyle = createMemo(() => {
    const { pan, zoom, animateTransform } = props.store
    return {
      transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
      "transform-origin": "0 0",
      transition: animateTransform ? "transform 0.3s ease" : "none",
    }
  })

  // Context menu state
  const [ctxMenu, setCtxMenu] = createSignal<ContextMenuState | null>(null)
  const isReview = () => props.phase === "review"

  // Click on background deselects and closes context menu
  const onBackgroundClick = () => {
    props.actions.selectNode(null)
    setCtxMenu(null)
  }

  const onNodeContextMenu = (e: MouseEvent, nodeId: string) => {
    if (!isReview() || !props.onSendCommand) return
    e.preventDefault()
    setCtxMenu({ x: e.clientX, y: e.clientY, nodeId })
  }

  return (
    <>
      <svg
        ref={svgRef}
        data-slot="oc-canvas-viewport"
        style={{ width: "100%", height: "100%", display: "block" }}
        onWheel={panZoom.onWheel}
        onPointerDown={panZoom.onPointerDown}
        onPointerMove={panZoom.onPointerMove}
        onPointerUp={panZoom.onPointerUp}
        onTouchStart={panZoom.onTouchStart}
        onTouchMove={panZoom.onTouchMove}
        onTouchEnd={panZoom.onTouchEnd}
        onClick={onBackgroundClick}
      >
        {/* SVG-scoped animation keyframes */}
        <defs>
          <style>{`
            @keyframes oc-pulse{0%,100%{opacity:1}50%{opacity:.3}}
            .oc-dot-pulse{animation:oc-pulse 1.5s ease-in-out infinite}
            @keyframes oc-dash{to{stroke-dashoffset:-12}}
            .oc-edge-flow{animation:oc-dash .8s linear infinite}
            @keyframes oc-node-in{from{opacity:0;transform:scale(0.8)}to{opacity:1;transform:scale(1)}}
            .oc-node-enter{animation:oc-node-in 0.3s ease-out}
          `}</style>
        </defs>

        <g style={transformStyle()}>
          <GridBackground />

          {/* Edge layer */}
          <For each={props.edges}>
            {(edge) => {
              const srcPos = createMemo(() => getPos(edge.source))
              const tgtPos = createMemo(() => getPos(edge.target))
              return (
                <CanvasEdge
                  edge={edge}
                  sourcePos={srcPos()}
                  targetPos={tgtPos()}
                  sourceNode={props.nodes.find((n) => n.id === edge.source)}
                  nodeW={EXPANDED_LAYOUT.nodeW}
                  nodeH={EXPANDED_LAYOUT.nodeH}
                  selectedNodeId={props.store.selectedNodeId}
                />
              )
            }}
          </For>

          {/* Node layer */}
          <For each={props.nodes}>
            {(node) => {
              const pos = createMemo(() => getPos(node.id))
              return (
                <Show when={pos()}>
                  {(p) => (
                    <CanvasNodeCard
                      node={node}
                      pos={p()}
                      nodeW={EXPANDED_LAYOUT.nodeW}
                      nodeH={EXPANDED_LAYOUT.nodeH}
                      selected={props.store.selectedNodeId === node.id}
                      expanded={props.store.expandedNodeIds.includes(node.id)}
                      onPointerDown={(e) =>
                        nodeDrag.onNodePointerDown(e, node.id, p().x, p().y)
                      }
                      onPointerMove={nodeDrag.onNodePointerMove}
                      onPointerUp={nodeDrag.onNodePointerUp}
                      onClick={() => {
                        props.actions.selectNode(node.id)
                        setCtxMenu(null)
                      }}
                      onDoubleClick={() => {
                        if (node.sessionID) props.navigateTo(node.sessionID)
                      }}
                      onContextMenu={(e: MouseEvent) => onNodeContextMenu(e, node.id)}
                    />
                  )}
                </Show>
              )
            }}
          </For>
        </g>
      </svg>

      {/* Context menu (review phase) */}
      <Show when={ctxMenu()}>
        {(menu) => {
          const node = () => props.nodes.find((n) => n.id === menu().nodeId)
          return (
            <div
              data-component="oc-context-menu"
              style={{
                position: "fixed",
                left: `${menu().x}px`,
                top: `${menu().y}px`,
              }}
              onClick={() => setCtxMenu(null)}
            >
              <button
                data-slot="oc-context-item"
                onClick={() => {
                  props.onSendCommand?.("edit-node", { nodeId: menu().nodeId })
                  props.actions.selectNode(menu().nodeId)
                }}
              >
                {"\u270E Edit"}
              </button>
              <button
                data-slot="oc-context-item"
                onClick={() => {
                  props.onSendCommand?.("remove-node", { nodeId: menu().nodeId })
                }}
              >
                {"\u2715 Remove"}
              </button>
              <div data-slot="oc-context-separator" />
              <button
                data-slot="oc-context-item"
                onClick={() => {
                  // Placeholder: triggers add-node with this as dependency
                  // The parent will handle the actual form
                }}
              >
                {"+ Add dependent"}
              </button>
            </div>
          )
        }}
      </Show>
    </>
  )
}
