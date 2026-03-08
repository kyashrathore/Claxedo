// ---------------------------------------------------------------------------
// Expanded node card (280x80) — status dot, title, kind, agent, connection
// ports, and optional inline message preview via foreignObject.
// Theme-aware: all colours use CSS custom properties.
// ---------------------------------------------------------------------------

import { createMemo, Show } from "solid-js"
import type { OrchestratorNode, NodePos } from "./types"
import { statusColors, truncate, KIND_LABELS } from "./types"

interface CanvasNodeCardProps {
  node: OrchestratorNode
  pos: NodePos
  nodeW: number
  nodeH: number
  selected: boolean
  expanded: boolean
  onPointerDown: (e: PointerEvent) => void
  onPointerMove: (e: PointerEvent) => void
  onPointerUp: (e: PointerEvent) => void
  onClick: () => void
  onDoubleClick: () => void
  onContextMenu?: (e: MouseEvent) => void
}

export function CanvasNodeCard(props: CanvasNodeCardProps) {
  const c = createMemo(() => statusColors(props.node.status))
  const kind = createMemo(() => KIND_LABELS[props.node.kind] ?? props.node.kind)

  return (
    <g
      data-canvas-node={props.node.id}
      style={{ cursor: "grab" }}
      class="oc-node-enter"
      onPointerDown={props.onPointerDown}
      onPointerMove={props.onPointerMove}
      onPointerUp={props.onPointerUp}
      onClick={(e) => {
        e.stopPropagation()
        props.onClick()
      }}
      onDblClick={(e) => {
        e.stopPropagation()
        props.onDoubleClick()
      }}
      onContextMenu={(e: MouseEvent) => {
        if (props.onContextMenu) {
          e.stopPropagation()
          props.onContextMenu(e)
        }
      }}
    >
      {/* Selection highlight ring */}
      <Show when={props.selected}>
        <rect
          x={props.pos.x - 3}
          y={props.pos.y - 3}
          width={props.nodeW + 6}
          height={props.nodeH + 6}
          rx="11"
          fill="none"
          stroke="var(--border-selected)"
          stroke-width="2"
          stroke-dasharray="4 2"
        />
      </Show>

      {/* Card background */}
      <rect
        x={props.pos.x}
        y={props.pos.y}
        width={props.nodeW}
        height={props.nodeH}
        rx="8"
        fill={c().fill}
        stroke={c().stroke}
        stroke-width="1"
      />

      {/* Status dot */}
      <Show
        when={props.node.status === "running"}
        fallback={
          <circle
            cx={props.pos.x + 16}
            cy={props.pos.y + 22}
            r="4"
            fill={c().dot}
          />
        }
      >
        <circle
          cx={props.pos.x + 16}
          cy={props.pos.y + 22}
          r="4"
          fill={c().dot}
          class="oc-dot-pulse"
        />
      </Show>

      {/* Title */}
      <text
        x={props.pos.x + 30}
        y={props.pos.y + 22}
        fill={c().text}
        font-size="13"
        font-family="var(--font-family-sans, Inter, system-ui, sans-serif)"
        dominant-baseline="central"
        style={{ "pointer-events": "none" }}
      >
        {truncate(props.node.title, 28)}
      </text>

      {/* Kind + Agent label */}
      <text
        x={props.pos.x + 30}
        y={props.pos.y + 46}
        fill="var(--text-weaker)"
        font-size="10"
        font-family="var(--font-family-mono, 'IBM Plex Mono', monospace)"
        dominant-baseline="central"
        style={{ "pointer-events": "none" }}
      >
        {kind()} · {props.node.agent}
      </text>

      {/* Status label (right side) */}
      <text
        x={props.pos.x + props.nodeW - 10}
        y={props.pos.y + 22}
        fill="var(--text-weaker)"
        font-size="10"
        font-family="var(--font-family-mono, 'IBM Plex Mono', monospace)"
        text-anchor="end"
        dominant-baseline="central"
        style={{ "pointer-events": "none" }}
      >
        {props.node.status}
      </text>

      {/* Session link indicator */}
      <Show when={props.node.sessionID}>
        <text
          x={props.pos.x + props.nodeW - 6}
          y={props.pos.y + 46}
          fill="var(--text-interactive-base)"
          font-size="9"
          text-anchor="end"
          dominant-baseline="central"
          style={{ "pointer-events": "none", opacity: 0.6 }}
        >
          {"\u2197"}
        </text>
      </Show>

      {/* Connection port — top (input) */}
      <circle
        cx={props.pos.x + props.nodeW / 2}
        cy={props.pos.y}
        r="3"
        fill="var(--icon-weak-base)"
        stroke="var(--border-base)"
        stroke-width="1"
      />
      {/* Connection port — bottom (output) */}
      <circle
        cx={props.pos.x + props.nodeW / 2}
        cy={props.pos.y + props.nodeH}
        r="3"
        fill="var(--icon-weak-base)"
        stroke="var(--border-base)"
        stroke-width="1"
      />

      {/* Error indicator */}
      <Show when={props.node.error}>
        <title>{props.node.error}</title>
        <text
          x={props.pos.x + props.nodeW - 10}
          y={props.pos.y + 46}
          fill="var(--icon-critical-base)"
          font-size="10"
          text-anchor="end"
          dominant-baseline="central"
          style={{ "pointer-events": "none" }}
        >
          {"\u26A0"}
        </text>
      </Show>

      {/* Expanded inline message preview */}
      <Show when={props.expanded && props.node.lastMessage}>
        <foreignObject
          x={props.pos.x}
          y={props.pos.y + props.nodeH + 4}
          width={props.nodeW}
          height="60"
        >
          <div
            style={{
              "font-size": "10px",
              color: "var(--text-weaker)",
              padding: "6px 8px",
              background: "var(--surface-base)",
              "border-radius": "4px",
              overflow: "hidden",
              "text-overflow": "ellipsis",
              "white-space": "nowrap",
              "font-family": "var(--font-family-mono, 'IBM Plex Mono', monospace)",
            }}
          >
            {truncate(props.node.lastMessage!, 80)}
          </div>
        </foreignObject>
      </Show>
    </g>
  )
}
