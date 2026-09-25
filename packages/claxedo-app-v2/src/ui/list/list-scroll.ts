import { createEffect, on, type Accessor } from "solid-js"

export function findByKey(container: HTMLElement, key: string): HTMLElement | undefined {
  for (const node of container.querySelectorAll<HTMLElement>('[data-slot="list-item"][data-key]')) {
    if (node.getAttribute("data-key") === key) return node
  }
  return undefined
}

function scrollIntoView(container: HTMLDivElement, node: HTMLElement, block: "center" | "nearest") {
  const containerRect = container.getBoundingClientRect()
  const nodeRect = node.getBoundingClientRect()
  const top = nodeRect.top - containerRect.top + container.scrollTop
  const bottom = top + nodeRect.height
  const viewTop = container.scrollTop
  const viewBottom = viewTop + container.clientHeight
  const target =
    block === "center"
      ? top - container.clientHeight / 2 + nodeRect.height / 2
      : top < viewTop
        ? top
        : bottom > viewBottom
          ? bottom - container.clientHeight
          : viewTop
  const max = Math.max(0, container.scrollHeight - container.clientHeight)
  container.scrollTop = Math.max(0, Math.min(target, max))
}

export function createListScroll<T>(input: {
  readonly scrollRef: Accessor<HTMLDivElement | undefined>
  readonly filter: Accessor<string>
  readonly flat: Accessor<readonly T[]>
  readonly active: Accessor<string | null>
  readonly key: (item: T) => string
  readonly current: Accessor<T | undefined>
  readonly mouseActive: Accessor<boolean>
}): void {
  createEffect(on(input.filter, () => input.scrollRef()?.scrollTo(0, 0), { defer: true }))
  createEffect(() => {
    const scroll = input.scrollRef()
    const current = input.current()
    if (!scroll || !current) return
    const key = input.key(current)
    requestAnimationFrame(() => {
      const element = findByKey(scroll, key)
      if (element) scrollIntoView(scroll, element, "center")
    })
  })
  createEffect(() => {
    const all = input.flat()
    const scroll = input.scrollRef()
    if (input.mouseActive() || all.length === 0 || !scroll) return
    const first = all[0]
    if (first !== undefined && input.active() === input.key(first)) return scroll.scrollTo(0, 0)
    const key = input.active()
    const element = key ? findByKey(scroll, key) : undefined
    if (element) scrollIntoView(scroll, element, "center")
  })
}
