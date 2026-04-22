/**
 * Small pill that renders a truncated CSS selector with a copy button. Used
 * as the `selection` JSX for `LineCommentEditor` when authoring a comment
 * on a page element. Reusable — knows nothing about pane-bus, sessions, or
 * the browser pane.
 */

import { createSignal, Show, type Component } from "solid-js"

export type ElementSelectionChipProps = {
  selector: string
  /** Max characters shown before truncating with an ellipsis. */
  maxChars?: number
  /** Optional click handler for users who want to scroll back to the element. */
  onClick?: () => void
}

const DEFAULT_MAX_CHARS = 48

export const ElementSelectionChip: Component<ElementSelectionChipProps> = (props) => {
  const [copied, setCopied] = createSignal(false)

  const display = () => {
    const max = props.maxChars ?? DEFAULT_MAX_CHARS
    if (props.selector.length <= max) return props.selector
    return `…${props.selector.slice(-(max - 1))}`
  }

  const copy = async (e: MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
    try {
      const clip = typeof navigator !== "undefined" ? navigator.clipboard : undefined
      if (clip?.writeText) {
        await clip.writeText(props.selector)
      }
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {
      // Swallow — copy is a convenience, not essential.
    }
  }

  return (
    <span
      data-testid="element-selection-chip"
      class="inline-flex items-center gap-1 rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[11px]"
      title={props.selector}
    >
      <Show
        when={props.onClick}
        fallback={<span data-slot="selector">{display()}</span>}
      >
        <button
          type="button"
          class="text-foreground hover:underline"
          data-slot="selector"
          onClick={(e) => {
            e.stopPropagation()
            props.onClick?.()
          }}
        >
          {display()}
        </button>
      </Show>
      <button
        type="button"
        class="text-muted-foreground hover:text-foreground"
        aria-label="Copy selector"
        data-slot="copy"
        onClick={copy}
      >
        {copied() ? "copied" : "copy"}
      </button>
    </span>
  )
}
