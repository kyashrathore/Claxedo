import { Show } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { formatDuration } from "./format-duration"

function formatTokenCount(tokens: number): string {
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`
  return String(tokens)
}

export function TurnFoldRow(props: {
  durationMs?: number
  folded: boolean
  onToggle: () => void
  tokens?: number
  cost?: number
  showTokens?: boolean
}) {
  const label = () =>
    typeof props.durationMs === "number" ? `Worked for ${formatDuration(props.durationMs)}` : "Worked"
  const footer = () => {
    if (!props.showTokens || !props.tokens) return undefined
    const parts = [`${formatTokenCount(props.tokens)} tokens`]
    if (typeof props.cost === "number" && props.cost > 0) parts.push(`$${props.cost.toFixed(2)}`)
    return parts.join(" · ")
  }
  return (
    <div data-component="turn-fold">
      <button
        type="button"
        data-slot="turn-fold-toggle"
        aria-expanded={!props.folded}
        onClick={(event) => {
          event.stopPropagation()
          props.onToggle()
        }}
      >
        <span data-slot="turn-fold-label">{label()}</span>
        <span data-slot="turn-fold-chevron" style={{ transform: props.folded ? "rotate(0deg)" : "rotate(90deg)" }}>
          <Icon name="chevron-right" size="small" />
        </span>
        <Show when={footer()}>
          <span data-slot="turn-fold-footer">{footer()}</span>
        </Show>
      </button>
      <div data-slot="turn-fold-rule" aria-hidden="true" />
    </div>
  )
}
