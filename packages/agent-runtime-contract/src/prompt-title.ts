export const PROMPT_TITLE_MAX_CHARS = 60

const MARKDOWN_LINK = /!?\[([^\]]*)\]\([^)]*\)/g
const LINE_MARKER = /^[ \t]*(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+|\d+[.)][ \t]+)/gm
const INLINE_MARK = /[`*~]+/g
const GREETING = /^(hi|hello|hey|yo|greetings)[!. ]*$/i
const POLITE_OPENING = /^(please|can you|could you|would you)\s+/i

function plainPromptText(prompt: string): string {
  return prompt.replace(MARKDOWN_LINK, "$1").replace(LINE_MARKER, "").replace(INLINE_MARK, "").replace(/\s+/g, " ").trim()
}

export function promptTitle(prompt: string): string {
  const plain = plainPromptText(prompt)
  if (GREETING.test(plain)) return "Greeting"
  const words = plain.replace(POLITE_OPENING, "").trim() || plain
  if (words.length <= PROMPT_TITLE_MAX_CHARS) return words
  const boundary = words.slice(0, PROMPT_TITLE_MAX_CHARS + 1).lastIndexOf(" ")
  return `${words.slice(0, boundary > 0 ? boundary : PROMPT_TITLE_MAX_CHARS).trimEnd()}…`
}
