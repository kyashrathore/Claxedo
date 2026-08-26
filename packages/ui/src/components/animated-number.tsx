import { storePath } from "solid-js"
import { For, createEffect, createMemo, untrack } from "solid-js"
import { createStore } from "solid-js"

const TRACK = Array.from({ length: 30 }, (_, index) => index % 10)
const DURATION = 600

function normalize(value: number) {
  return ((value % 10) + 10) % 10
}

function spin(from: number, to: number, direction: 1 | -1) {
  if (from === to) return 0
  if (direction > 0) return (to - from + 10) % 10
  return -((from - to + 10) % 10)
}

function Digit(props: { value: number; direction: 1 | -1 }) {
  const initial = untrack(() => props.value)
  const [state, setState] = createStore({
    step: initial + 10,
    animating: false,
  })
  const step = () => state.step
  const animating = () => state.animating
  let last = initial

  createEffect(
    () => props.value,
    (next) => {
      const delta = spin(last, next, props.direction)
      last = next
      if (!delta) {
        setState(storePath("animating", false))
        setState(storePath("step", next + 10))
        return
      }

      setState(storePath("animating", true))
      setState(storePath("step", (value) => value + delta))
    },
    { defer: true },
  )

  return (
    <span data-slot="animated-number-digit">
      <span
        data-slot="animated-number-strip"
        data-animating={animating() ? "true" : "false"}
        onTransitionEnd={() => {
          setState(storePath("animating", false))
          setState(storePath("step", (value) => normalize(value) + 10))
        }}
        style={{
          "--animated-number-offset": `${step()}`,
          "--animated-number-duration": `var(--tool-motion-odometer-ms, ${DURATION}ms)`,
        }}
      >
        <For each={TRACK}>{(value) => <span data-slot="animated-number-cell">{value}</span>}</For>
      </span>
    </span>
  )
}

export function AnimatedNumber(props: { value: number; class?: string }) {
  const target = createMemo(() => {
    if (!Number.isFinite(props.value)) return 0
    return Math.max(0, Math.round(props.value))
  })

  const [state, setState] = createStore({
    value: untrack(target),
    direction: 1 as 1 | -1,
  })
  const value = () => state.value
  const direction = () => state.direction

  createEffect(
    target,
    (next) => {
      const current = value()
      if (next === current) return

      setState(storePath("direction", next > current ? 1 : -1))
      setState(storePath("value", next))
    },
    { defer: true },
  )

  const label = createMemo(() => value().toString())
  const digits = createMemo(() =>
    Array.from(label(), (char) => {
      const code = char.charCodeAt(0) - 48
      if (code < 0 || code > 9) return 0
      return code
    }).reverse(),
  )
  const width = createMemo(() => `${digits().length}ch`)

  return (
    <span data-component="animated-number" class={props.class} aria-label={label()}>
      <span data-slot="animated-number-value" style={{ "--animated-number-width": width() }}>
        <For keyed={false} each={digits()}>
          {(digit) => <Digit value={digit()} direction={direction()} />}
        </For>
      </span>
    </span>
  )
}
