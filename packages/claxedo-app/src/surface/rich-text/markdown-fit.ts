import type { MarkdownManager } from "@tiptap/markdown"

export type RenderMarkdown = (markdown: string) => string

function trimmed(markdown: string): string {
  return markdown.replace(/\s+$/, "")
}

export function markdownRoundTrips(markdown: string, manager: Pick<MarkdownManager, "parse" | "serialize">, render: RenderMarkdown): boolean {
  const kept = manager.serialize(manager.parse(markdown))
  if (trimmed(kept) === trimmed(markdown)) return true
  return render(kept) === render(markdown)
}
