const TITLE_CHARACTERS = 60

export function pendingTitle(title: string | undefined, prompt: string | undefined): string {
  if (title) return title
  const words = (prompt ?? "").replace(/\s+/g, " ").trim()
  if (words.length <= TITLE_CHARACTERS) return words
  const cut = words.slice(0, TITLE_CHARACTERS)
  const boundary = cut.lastIndexOf(" ")
  return `${(boundary > 0 ? cut.slice(0, boundary) : cut).trimEnd()}…`
}
