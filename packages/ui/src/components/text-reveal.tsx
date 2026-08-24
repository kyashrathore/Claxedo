import { storePath } from "solid-js"
import { createEffect, onCleanup, onSettled, untrack } from "solid-js"
import { createStore } from "solid-js"

const px = (value: number | string | undefined, fallback: number) => {
  if (typeof value === "number") return `${value}px`
  if (typeof value === "string") return value
  return `${fallback}px`
}

const ms = (value: number | string | undefined, fallback: number) => {
  if (typeof value === "number") return `${value}ms`
  if (typeof value === "string") return value
  return `${fallback}ms`
}

const pct = (value: number | undefined, fallback: number) => {
  const v = value ?? fallback
  return `${v}%`
}

export function TextReveal(props: {
  text?: string
  class?: string
  duration?: number | string
  /** Gradient edge softness as a percentage of the mask (0 = hard wipe, 17 = soft). */
  edge?: number
  /** Optional small vertical travel for entering text (px). Default 0. */
  travel?: number | string
  spring?: string
  springSoft?: string
  growOnly?: boolean
  truncate?: boolean
}) {
  const [state, setState] = createStore({
    cur: untrack(() => props.text),
    old: undefined as string | undefined,
    width: "auto",
    ready: false,
    swapping: false,
  })
  const cur = () => state.cur
  const old = () => state.old
  const width = () => state.width
  const ready = () => state.ready
  const swapping = () => state.swapping
  let inRef: HTMLSpanElement | undefined
  let outRef: HTMLSpanElement | undefined
  let rootRef: HTMLSpanElement | undefined
  let frame: number | undefined

  const win = () => inRef?.scrollWidth ?? 0
  const wout = () => outRef?.scrollWidth ?? 0

  const widen = (next: number) => {
    if (next <= 0) return
    if (props.growOnly ?? true) {
      const prev = Number.parseFloat(width())
      if (Number.isFinite(prev) && next <= prev) return
    }
    setState(storePath("width", `${next}px`))
  }

  createEffect(
    () => props.text,
    (next, prev) => {
      if (next === prev) return
      if (typeof next === "string" && typeof prev === "string" && next.startsWith(prev)) {
        setState(storePath("cur", next))
        widen(win())
        return
      }
      setState(storePath("swapping", true))
      setState(storePath("old", prev))
      setState(storePath("cur", next))

      if (typeof requestAnimationFrame !== "function") {
        widen(Math.max(win(), wout()))
        rootRef?.offsetHeight
        setState(storePath("swapping", false))
        return
      }
      if (frame !== undefined && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        widen(Math.max(win(), wout()))
        rootRef?.offsetHeight
        setState(storePath("swapping", false))
        frame = undefined
      })
    },
  )

  onSettled(() => {
    widen(win())
    const fonts = typeof document !== "undefined" ? document.fonts : undefined
    if (typeof requestAnimationFrame !== "function") {
      setState(storePath("ready", true))
      return
    }
    if (!fonts) {
      requestAnimationFrame(() => setState(storePath("ready", true)))
      return
    }
    void fonts.ready.finally(() => {
      widen(win())
      requestAnimationFrame(() => setState(storePath("ready", true)))
    })
  })

  onCleanup(() => {
    if (frame === undefined || typeof cancelAnimationFrame !== "function") return
    cancelAnimationFrame(frame)
  })

  return (
    <span
      ref={rootRef}
      data-component="text-reveal"
      data-ready={ready() ? "true" : "false"}
      data-swapping={swapping() ? "true" : "false"}
      data-truncate={props.truncate ? "true" : "false"}
      class={props.class}
      aria-label={props.text ?? ""}
      style={{
        "--text-reveal-duration": ms(props.duration, 450),
        "--text-reveal-edge": pct(props.edge, 17),
        "--text-reveal-travel": px(props.travel, 0),
        "--text-reveal-spring": props.spring ?? "cubic-bezier(0.34, 1.08, 0.64, 1)",
        "--text-reveal-spring-soft": props.springSoft ?? "cubic-bezier(0.34, 1, 0.64, 1)",
      }}
    >
      <span data-slot="text-reveal-track" style={{ width: props.truncate ? "100%" : width() }}>
        <span data-slot="text-reveal-entering" ref={inRef}>
          {cur() ?? "\u00A0"}
        </span>
        <span data-slot="text-reveal-leaving" ref={outRef}>
          {old() ?? "\u00A0"}
        </span>
      </span>
    </span>
  )
}
