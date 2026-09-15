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
  /** Controlled expansion — callers pass it so the state outlives a virtualized unmount. */
  revealed?: boolean
  onRevealedChange?: (revealed: boolean) => void
}) {
  const i18n = useI18n()
  const [localRevealed, setLocalRevealed] = createSignal(false)
  const revealed = () => props.revealed ?? localRevealed()
  const setRevealed = (value: boolean) => {
    if (props.revealed === undefined) setLocalRevealed(value)
    props.onRevealedChange?.(value)
  }
  const [overflows, setOverflows] = createSignal(false)
  let box: HTMLDivElement | undefined
  let content: HTMLDivElement | undefined
  let dead = false
  onCleanup(() => {
    dead = true
  })

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
            // Lifting the cap deletes this box's own scroll range, so the line
            // under the reader should move by exactly that range. The transfer
            // needs scrollable room, though: inside a virtualized list the
            // spacer only grows when the next measurement pass commits — a
            // rAF later — so a bare scrollTop write would clamp against the
            // pre-growth height. Grow the spacer (the data-index row's parent)
            // first; the list rewrites it with the real total on measure.
            const carried = revealed() ? 0 : (box?.scrollTop ?? 0)
            const outer = box?.parentElement?.closest<HTMLElement>("[data-scrollable]")
            const base = outer?.scrollTop ?? 0
            const growth = revealed() || !box ? 0 : box.scrollHeight - box.clientHeight
            const spacer = box?.parentElement?.closest<HTMLElement>("[data-index]")?.parentElement
            setRevealed(!revealed())
            if (!outer || carried <= 0) return
            const top = base + carried
            if (spacer && growth > 0) spacer.style.height = `${spacer.offsetHeight + growth}px`
            void outer.scrollHeight
            outer.scrollTop = top
            // Re-assert across the next few frames: the list's own resize and
            // reconcile passes still run and can move the target until they
            // settle. The reader's own scroll wins over the assertion — a
            // wheel or drag means they are done reading this position.
            let stopped = false
            const release = () => {
              stopped = true
              outer.removeEventListener("wheel", release)
              outer.removeEventListener("touchmove", release)
              outer.removeEventListener("pointerdown", scrollbarRelease)
            }
            // A pointerdown beyond the content box is the scrollbar itself —
            // a drag about to move the position the pin would re-assert. A
            // pointerdown inside it is a click on content, not a scroll.
            const scrollbarRelease = (event: PointerEvent) => {
              if (event.offsetX > outer.clientWidth) release()
            }
            outer.addEventListener("wheel", release, { passive: true })
            outer.addEventListener("touchmove", release, { passive: true })
            outer.addEventListener("pointerdown", scrollbarRelease, { passive: true })
            let stable = 0
            let frames = 0
            const pin = () => {
              if (stopped || dead) return
              if (Math.abs(outer.scrollTop - top) > 1) {
                outer.scrollTop = top
                stable = 0
              } else {
                stable += 1
              }
              if (stable < 3 && ++frames < 30) {
                requestAnimationFrame(pin)
                return
              }
              release()
            }
            requestAnimationFrame(pin)
          }}
        >
          {revealed() ? i18n.t("ui.scrollableOutput.showLess") : i18n.t("ui.scrollableOutput.showAll")}
        </button>
      </Show>
    </>
  )
}
