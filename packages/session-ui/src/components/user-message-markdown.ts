const structuralMarkdown = [
  /(?:^|\n) {0,3}(?:#{1,6}\s+|>\s+|[-+*]\s+|\d+[.)]\s+)\S/,
  /(?:^|\n)\s*(?:```|~~~)/,
  /(?:^|\n)\s*\|?.+\|.+\n\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*(?:\n|$)/,
  /\[[^\]\n]+\]\([^\s)]+(?:\s+"[^"]*")?\)/,
  /`[^`\n]+`/,
  /(?:\*\*|__)[^\n]+(?:\*\*|__)/,
]

export function shouldRenderUserMarkdown(text: string) {
  return structuralMarkdown.some((pattern) => pattern.test(text))
}
