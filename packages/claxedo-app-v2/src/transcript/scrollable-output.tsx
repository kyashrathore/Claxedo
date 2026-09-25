import { createSignal, onCleanup, onMount, Show, type JSX } from "solid-js"
import { useTranscriptI18n } from "./i18n"

export function outputOverflows(box: { scrollHeight: number; clientHeight: number }) {
  return box.scrollHeight > box.clientHeight + 1
}

export function ScrollableOutput(props: {
  children: JSX.Element
  component?: "tool-output"
  slot?: "bash-scroll"
  class?: string
  label?: string
  revealed?: boolean
  onRevealedChange?: (revealed: boolean) => void
}) {
  const i18n = useTranscriptI18n()
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
        aria-label={props.label ?? i18n.t("transcript.scrollView.ariaLabel")}
      >
        <div ref={content}>
          {props.children}
        </div>
      </div>
      <Show when={overflows() || revealed()}>
        <button
          type="button"
          class="ui-scrollable-output-toggle"
          aria-expanded={revealed()}
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => {
            event.stopPropagation()
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
            let stopped = false
            const release = () => {
              stopped = true
              outer.removeEventListener("wheel", release)
              outer.removeEventListener("touchmove", release)
              outer.removeEventListener("pointerdown", scrollbarRelease)
            }
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
          {revealed() ? i18n.t("transcript.scrollableOutput.showLess") : i18n.t("transcript.scrollableOutput.showAll")}
        </button>
      </Show>
    </>
  )
}
