import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js"

export function createNavigationGeometry(scroller: Accessor<HTMLElement | undefined>, content: Accessor<HTMLElement | undefined>): Accessor<number> {
  const [revision, setRevision] = createSignal(0)
  createEffect(() => {
    const parent = scroller()
    const rows = content()
    if (!parent || !rows) return
    const observer = new ResizeObserver(() => setRevision((value) => value + 1))
    observer.observe(parent)
    observer.observe(rows)
    onCleanup(() => observer.disconnect())
  })
  return revision
}
