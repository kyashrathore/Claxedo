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
  running?: boolean
}) {
  const label = () => {
    const verb = props.running ? "Working" : "Worked"
    return typeof props.durationMs === "number" ? `${verb} for ${formatDuration(props.durationMs)}` : verb
  }
  const footer = () => {
    if (!props.showTokens || !props.tokens) return undefined
    const parts = [`${formatTokenCount(props.tokens)} tokens`]
    if (typeof props.cost === "number" && props.cost > 0) parts.push(`$${props.cost.toFixed(2)}`)
    return parts.join(" · ")
  }
  return (
    <div data-component="turn-fold" class="w-full">
      <button
        type="button"
        aria-expanded={!props.folded}
        onClick={(event) => {
          event.stopPropagation()
          props.onToggle()
        }}
        class="group/turn-fold flex items-center gap-1.5 h-8 rounded-sm px-1 -mx-1 text-text-weak hover:text-text-strong focus-visible:text-text-strong focus-visible:outline-none transition-colors"
      >
        <span class="text-14-medium tabular-nums">{label()}</span>
        <span
          class="inline-flex items-center opacity-60 group-hover/turn-fold:opacity-100 transition-transform duration-300"
          style={{ transform: props.folded ? "rotate(0deg)" : "rotate(90deg)" }}
        >
          <Icon name="chevron-right" size="small" />
        </span>
        <Show when={footer()}>
          <span class="ml-auto text-12-regular text-text-weaker tabular-nums">{footer()}</span>
        </Show>
      </button>
      <div class="h-px w-full bg-border-weak-base" aria-hidden="true" />
    </div>
  )
}
