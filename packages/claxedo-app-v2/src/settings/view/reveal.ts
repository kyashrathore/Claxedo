import { createEffect, createSignal, onCleanup, untrack, type Accessor } from "solid-js"

export function createRevealLimit(total: Accessor<number>, first: number, step: number): Accessor<number> {
  const [limit, setLimit] = createSignal(first)
  let frame: number | undefined
  const grow = () => {
    frame = undefined
    const next = untrack(limit) + step
    setLimit(next)
    if (next < untrack(total)) frame = requestAnimationFrame(grow)
  }
  createEffect(() => {
    if (limit() < total() && frame === undefined) frame = requestAnimationFrame(grow)
  })
  onCleanup(() => {
    if (frame !== undefined) cancelAnimationFrame(frame)
  })
  return limit
}
