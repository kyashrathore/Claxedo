import { createEffect, createSignal, on, type Accessor, type JSX } from "solid-js"
import { resolveTreeKeyAction } from "../tree-helpers"
import type { TreeRow } from "../tree-rows"

function rowElement(container: HTMLElement | undefined, path: string): HTMLElement | null | undefined {
  return container?.querySelector<HTMLElement>(`[role="treeitem"][data-file-tree-path="${CSS.escape(path)}"]`)
}

export function createTreeKeys(input: {
  readonly rows: Accessor<readonly TreeRow[]>
  readonly visible: Accessor<readonly string[]>
  readonly container: () => HTMLElement | undefined
  readonly scrollTo: (index: number) => void
}) {
  const [focusTarget, setFocusTarget] = createSignal<string>()
  createEffect(
    on([focusTarget, input.visible], ([path, visible]) => {
      if (!path || !visible.includes(path)) return
      queueMicrotask(() => rowElement(input.container(), path)?.focus())
      setFocusTarget(undefined)
    }),
  )
  const onKeyDown: JSX.EventHandler<HTMLDivElement, KeyboardEvent> = (event) => {
    const current = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('[role="treeitem"]') : null
    const items = input.rows().filter((row) => row.kind === "node")
    const expandedAttr = current?.getAttribute("aria-expanded")
    const action = resolveTreeKeyAction({
      key: event.key,
      index: current ? items.findIndex((row) => row.key === current.dataset.fileTreePath) : -1,
      count: items.length,
      expanded: expandedAttr === null || expandedAttr === undefined ? undefined : expandedAttr === "true",
    })
    if (action.kind === "none") return
    event.preventDefault()
    if (action.kind === "toggle") return current?.click()
    const target = items[action.index]
    if (!target) return
    input.scrollTo(input.rows().indexOf(target))
    setFocusTarget(target.key)
  }
  return { onKeyDown }
}
