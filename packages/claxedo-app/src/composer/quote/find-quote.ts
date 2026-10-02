type Position = { readonly node: Node; readonly offset: number }

const WHITESPACE = /\s/

export function findQuoteRange(root: Node, quote: string): Range | undefined {
  const target = quote.replace(/\s+/g, "")
  if (!target) return undefined
  const positions: Position[] = []
  const characters: string[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const value = node.nodeValue ?? ""
    for (let offset = 0; offset < value.length; offset++) {
      if (WHITESPACE.test(value[offset])) continue
      characters.push(value[offset])
      positions.push({ node, offset })
    }
  }
  const start = characters.join("").indexOf(target)
  if (start < 0) return undefined
  const first = positions[start]
  const last = positions[start + target.length - 1]
  const range = document.createRange()
  range.setStart(first.node, first.offset)
  range.setEnd(last.node, last.offset + 1)
  return range
}
