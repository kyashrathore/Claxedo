import { createSignal, onCleanup, onMount, Show, type JSX } from "solid-js"
import { useI18n } from "@opencode-ai/ui/context/i18n"

/** Whether the box holds more than its cap shows; a revealed box keeps its control so it can close again. */
export function outputOverflows(box: { scrollHeight: number; clientHeight: number }) {
  return box.scrollHeight > box.clientHeight + 1
}

/**
 * A tool's output inside a capped, scrolling box, with a control that lifts the
 * cap when the output is taller than it. The control is measured from the
 * content, not the box: a capped box keeps its size while what it holds grows.
 */
export function ScrollableOutput(props: {
  children: JSX.Element
  component?: string
  slot?: string
  class?: string
  label?: string
}) {
  const i18n = useI18n()
  const [revealed, setRevealed] = createSignal(false)
  const [overflows, setOverflows] = createSignal(false)
  let box: HTMLDivElement | undefined
  let content: HTMLDivElement | undefined

  onMount(() => {
    if (!box || !content) return
    const target = box
    const measure = () => setOverflows(revealed() || outputOverflows(target))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(content)
    observer.observe(box)
    onCleanup(() => observer.disconnect())
  })

  return (
    <>
      <div
        ref={box}
        data-component={props.component}
        data-slot={props.slot}
        classList={{ "ui-scrollable-output": true, [props.class ?? ""]: !!props.class }}
        data-scrollable
        data-revealed={revealed() ? "true" : undefined}
        tabIndex={0}
        role="region"
        aria-label={props.label ?? i18n.t("ui.scrollView.ariaLabel")}
      >
        <div ref={content} data-slot="scrollable-output-content">
          {props.children}
        </div>
      </div>
      <Show when={overflows() || revealed()}>
        <button
          type="button"
          data-slot="scrollable-output-toggle"
          class="ui-scrollable-output-toggle"
          aria-expanded={revealed()}
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => {
            event.stopPropagation()
            setRevealed((value) => !value)
          }}
        >
          {revealed() ? i18n.t("ui.scrollableOutput.showLess") : i18n.t("ui.scrollableOutput.showAll")}
        </button>
      </Show>
    </>
  )
}
