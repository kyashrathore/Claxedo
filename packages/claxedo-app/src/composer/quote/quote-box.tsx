import type { JSX } from "solid-js"
import { Portal } from "solid-js/web"
import { LineCommentEditor } from "@/transcript"
import type { QuoteBoxPosition } from "./selected-quote"
import "./quote.css"

function boxStyle(position: QuoteBoxPosition): JSX.CSSProperties {
  const vertical = "top" in position ? { top: `${position.top}px` } : { bottom: `${position.bottom}px` }
  return { left: `${position.left}px`, width: `${position.width}px`, ...vertical }
}

export function QuoteBox(props: {
  readonly position: QuoteBoxPosition
  readonly ref: (element: HTMLElement) => void
  readonly value: string
  readonly autofocus: boolean
  readonly submitLabel?: string
  readonly onInput: (value: string) => void
  readonly onSubmit: (comment: string) => void
  readonly onCancel: () => void
}): JSX.Element {
  return (
    <Portal>
      <div ref={props.ref} data-owns-escape class="fixed z-50" style={boxStyle(props.position)}>
        <LineCommentEditor
          inline
          autofocus={props.autofocus}
          class="w-full"
          value={props.value}
          submitLabel={props.submitLabel}
          onInput={props.onInput}
          onCancel={props.onCancel}
          onSubmit={props.onSubmit}
        />
      </div>
    </Portal>
  )
}
