export type MarkdownEnvelope = {
  bom: "" | "\uFEFF"
  frontmatter: string
  body: string
}

export function splitMarkdownEnvelope(markdown: string): MarkdownEnvelope {
  const bom = markdown.startsWith("\uFEFF") ? "\uFEFF" : ""
  const content = bom ? markdown.slice(1) : markdown
  const opening = /^---(?:\r\n|\n)/.exec(content)
  if (!opening) return { bom, frontmatter: "", body: content }

  const delimiter = /^(?:---|\.\.\.)(?:\r\n|\n|$)/gm
  delimiter.lastIndex = opening[0].length
  const closing = delimiter.exec(content)
  if (!closing) return { bom, frontmatter: "", body: content }

  const end = closing.index + closing[0].length
  const separator = content.startsWith("\r\n", end) ? "\r\n" : content.startsWith("\n", end) ? "\n" : ""
  const prefixEnd = end + separator.length
  return {
    bom,
    frontmatter: content.slice(0, prefixEnd),
    body: content.slice(prefixEnd),
  }
}

export function joinMarkdownEnvelope(envelope: Pick<MarkdownEnvelope, "bom" | "frontmatter">, body: string) {
  return envelope.bom + envelope.frontmatter + body
}
