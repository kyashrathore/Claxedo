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

export function scrollPromptCursorIntoView(input: {
  editor: HTMLElement
  container: HTMLElement
  length: number
  bottomInset: number
}) {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return
  const range = selection.getRangeAt(0)
  if (!input.editor.contains(range.startContainer)) return
  if (getCursorPosition(input.editor) >= input.length) {
    input.container.scrollTop = input.container.scrollHeight
    return
  }
  const rect = range.getClientRects().item(0) ?? range.getBoundingClientRect()
  if (!rect.height) return
  const containerRect = input.container.getBoundingClientRect()
  const top = rect.top - containerRect.top + input.container.scrollTop
  const bottom = rect.bottom - containerRect.top + input.container.scrollTop
  if (top < input.container.scrollTop + 12) {
    input.container.scrollTop = Math.max(0, top - 12)
    return
  }
  if (bottom > input.container.scrollTop + input.container.clientHeight - input.bottomInset) {
    input.container.scrollTop = bottom - input.container.clientHeight + input.bottomInset
  }
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

export function setCursorPosition(parent: HTMLElement, position: number) {
  let remaining = position
  let node = parent.firstChild
  while (node) {
    const length = getNodeLength(node)
    const isText = node.nodeType === Node.TEXT_NODE
    const isPill = isPillNode(node)
    const isBreak = isBreakNode(node)

    if (isText && remaining <= length) {
      const range = document.createRange()
      range.setStart(node, remaining)
      placeCaret(range)
      return
    }

    if ((isPill || isBreak) && remaining <= length) {
      const range = document.createRange()
      if (remaining === 0) range.setStartBefore(node)
      if (remaining > 0 && isPill) range.setStartAfter(node)
      if (remaining > 0 && isBreak) caretAfterBreak(range, node)
      placeCaret(range)
      return
    }

    remaining -= length
    node = node.nextSibling
  }

  const fallbackRange = document.createRange()
  const last = parent.lastChild
  if (last && last.nodeType === Node.TEXT_NODE) {
    fallbackRange.setStart(last, last.textContent ? last.textContent.length : 0)
  }
  if (!last || last.nodeType !== Node.TEXT_NODE) {
    fallbackRange.selectNodeContents(parent)
  }
  fallbackRange.collapse(false)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(fallbackRange)
}

export function setRangeEdge(parent: HTMLElement, range: Range, edge: "start" | "end", offset: number) {
  let remaining = offset
  const nodes = Array.from(parent.childNodes)

  for (const node of nodes) {
    const length = getNodeLength(node)
    const isText = node.nodeType === Node.TEXT_NODE
    const isPill = isPillNode(node)
    const isBreak = isBreakNode(node)

    if (isText && remaining <= length) {
      if (edge === "start") range.setStart(node, remaining)
      if (edge === "end") range.setEnd(node, remaining)
      return
    }

    if ((isPill || isBreak) && remaining <= length) {
      if (edge === "start" && remaining === 0) range.setStartBefore(node)
      if (edge === "start" && remaining > 0) range.setStartAfter(node)
      if (edge === "end" && remaining === 0) range.setEndBefore(node)
      if (edge === "end" && remaining > 0) range.setEndAfter(node)
      return
    }

    remaining -= length
  }
}
