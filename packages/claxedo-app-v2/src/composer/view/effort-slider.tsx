import { For, createMemo, createSignal } from "solid-js"

export function EffortSlider(props: {
  levels: string[]
  current: string
  label: (value: string) => string
  onSelect: (value: string) => void
}) {
  const [dragging, setDragging] = createSignal(false)
  const index = createMemo(() => Math.max(0, props.levels.indexOf(props.current)))
  const last = createMemo(() => props.levels.length - 1)
  const ratio = createMemo(() => index() / last())

  const select = (next: number) => {
    const value = props.levels[Math.max(0, Math.min(last(), next))]
    if (value !== undefined && value !== props.current) props.onSelect(value)
  }
  const indexAt = (element: HTMLElement, clientX: number) => {
    const box = element.getBoundingClientRect()
    const inset = Number.parseFloat(getComputedStyle(element).getPropertyValue("--effort-stop-inset")) || 0
    const travel = box.width - inset * 2
    if (travel <= 0) return index()
    return Math.round(((clientX - box.left - inset) / travel) * last())
  }

  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label="Effort"
      aria-valuemin={0}
      aria-valuemax={last()}
      aria-valuenow={index()}
      aria-valuetext={props.label(props.current)}
      title={`Effort · ${props.label(props.current)}`}
      data-supported="true"
      data-dragging={dragging() ? "true" : undefined}
      class="harness-picker-effort"
      style={{ "--effort-ratio": ratio() }}
      onPointerDown={(event) => {
        if (event.button !== 0) return
        event.currentTarget.setPointerCapture(event.pointerId)
        setDragging(true)
        select(indexAt(event.currentTarget, event.clientX))
      }}
      onPointerMove={(event) => {
        if (!dragging()) return
        select(indexAt(event.currentTarget, event.clientX))
      }}
      onPointerUp={() => setDragging(false)}
      onPointerCancel={() => setDragging(false)}
      onKeyDown={(event) => {
        const step = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[event.key]
        if (step !== undefined) select(index() + step)
        else if (event.key === "Home") select(0)
        else if (event.key === "End") select(last())
        else return
        event.preventDefault()
      }}
    >
      <span aria-hidden="true" class="harness-picker-effort-fill" />
      <For each={props.levels}>
        {(_, stop) => (
          <span
            aria-hidden="true"
            class="harness-picker-effort-stop"
            data-filled={stop() <= index() ? "true" : undefined}
            style={{ "--effort-stop": stop() / last() }}
          />
        )}
      </For>
      <span aria-hidden="true" class="harness-picker-effort-thumb" />
    </div>
  )
}
