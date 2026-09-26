const MAX_BREAKS = 200

export function createTextFragment(content: string): DocumentFragment {
  const fragment = document.createDocumentFragment()
  let breaks = 0
  for (const char of content) {
    if (char !== "\n") continue
    breaks += 1
    if (breaks > MAX_BREAKS) {
      const tail = content.endsWith("\n")
      const text = tail ? content.slice(0, -1) : content
      if (text) fragment.appendChild(document.createTextNode(text))
      if (tail) fragment.appendChild(document.createElement("br"))
      return fragment
    }
  }

  const segments = content.split("\n")
  segments.forEach((segment, index) => {
    if (segment) {
      fragment.appendChild(document.createTextNode(segment))
    }
    if (index < segments.length - 1) {
      fragment.appendChild(document.createElement("br"))
    }
  })
  return fragment
}

export function asElement(node: Node | null | undefined): HTMLElement | undefined {
  return node instanceof HTMLElement ? node : undefined
}

export function isBreakNode(node: Node | null | undefined): boolean {
  return asElement(node)?.tagName === "BR"
}

export function isPillNode(node: Node | null | undefined): boolean {
  const type = asElement(node)?.dataset.type
  return type === "file" || type === "agent"
}

export function getNodeLength(node: Node): number {
  if (isBreakNode(node)) return 1
  return (node.textContent ?? "").replace(/​/g, "").length
}

export function getTextLength(node: Node): number {
  if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? "").replace(/​/g, "").length
  if (isBreakNode(node)) return 1
  let length = 0
  for (const child of Array.from(node.childNodes)) {
    length += getTextLength(child)
  }
  return length
}

export function getCursorPosition(parent: HTMLElement): number {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return 0
  const range = selection.getRangeAt(0)
  if (!parent.contains(range.startContainer)) return 0
  const preCaretRange = range.cloneRange()
  preCaretRange.selectNodeContents(parent)
  preCaretRange.setEnd(range.startContainer, range.startOffset)
  return getTextLength(preCaretRange.cloneContents())
}

function placeCaret(range: Range) {
  range.collapse(true)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}

function caretAfterBreak(range: Range, node: Node) {
  const next = node.nextSibling
  if (next && next.nodeType === Node.TEXT_NODE) {
    range.setStart(next, 0)
    return
  }
  range.setStartAfter(node)
}

function caretAtEnd(parent: HTMLElement) {
  const range = document.createRange()
  const last = parent.lastChild
  if (last && last.nodeType === Node.TEXT_NODE) range.setStart(last, last.textContent ? last.textContent.length : 0)
  else range.selectNodeContents(parent)
  range.collapse(false)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}

function caretInNode(node: Node, remaining: number): Range | undefined {
  const range = document.createRange()
  if (node.nodeType === Node.TEXT_NODE) {
    range.setStart(node, remaining)
    return range
  }
  const pill = isPillNode(node)
  if (!pill && !isBreakNode(node)) return undefined
  if (remaining === 0) range.setStartBefore(node)
  else if (pill) range.setStartAfter(node)
  else caretAfterBreak(range, node)
  return range
}

export function setCursorPosition(parent: HTMLElement, position: number) {
  let remaining = position
  for (let node = parent.firstChild; node; node = node.nextSibling) {
    const length = getNodeLength(node)
    const range = remaining <= length ? caretInNode(node, remaining) : undefined
    if (range) return placeCaret(range)
    remaining -= length
  }
  caretAtEnd(parent)
}

