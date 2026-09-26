const SHELF_ID = "svg-sprite-shelf"

function isSpriteHost(node: Node): node is SVGSVGElement {
  return node instanceof SVGSVGElement && node.id.endsWith("-sprite") && node.getAttribute("aria-hidden") === "true"
}

export function mountSpriteShelf(body: HTMLElement): () => void {
  const existing = document.getElementById(SHELF_ID)
  const shelf = existing ?? document.createElement("div")
  if (!existing) {
    shelf.id = SHELF_ID
    shelf.style.display = "contents"
    body.insertBefore(shelf, body.firstChild)
  }
  for (const child of [...body.children]) if (isSpriteHost(child)) shelf.append(child)
  const observer = new MutationObserver((records) => {
    for (const record of records) for (const node of record.addedNodes) if (isSpriteHost(node)) shelf.append(node)
  })
  observer.observe(body, { childList: true })
  return () => observer.disconnect()
}
