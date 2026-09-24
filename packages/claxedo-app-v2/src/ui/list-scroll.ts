export function findListItem(container: HTMLElement, key: string): HTMLElement | undefined {
  for (const node of container.querySelectorAll<HTMLElement>('[data-slot="list-item"][data-key]')) {
    if (node.getAttribute("data-key") === key) return node
  }
  return undefined
}

export function scrollListItemIntoView(container: HTMLElement, node: HTMLElement, block: "center" | "nearest") {
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
