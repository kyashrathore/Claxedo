import type { SourceFile } from "./scanners"

/** The one file allowed to mount PromptInput without an explicit mode prop: its own definition. */
export const COMPOSER_MODE_OWNER_FILE = "features/session/composer/composer.tsx"

const MOUNTS_PROMPT_INPUT = /<PromptInput\b/g
const HAS_EXPLICIT_MODE = /\bmode=/

/**
 * Every `<PromptInput` mount site (outside its own definition) must pass an
 * explicit ComposerMode via `mode=`. Each mount occurrence in a file is
 * evaluated independently -- one compliant mount earlier in the file must
 * not mask a later bare mount.
 */
export function promptInputMountsMissingExplicitMode(files: SourceFile[]) {
  const offenders = new Set<string>()
  for (const file of files) {
    if (file.path === COMPOSER_MODE_OWNER_FILE) continue
    for (const match of file.text.matchAll(MOUNTS_PROMPT_INPUT)) {
      const start = match.index ?? 0
      const tagEnd = openingTagEnd(file.text, start)
      const tagText = tagEnd < 0 ? file.text.slice(start) : file.text.slice(start, tagEnd + 1)
      if (!HAS_EXPLICIT_MODE.test(tagText)) {
        offenders.add(file.path)
        break
      }
    }
  }
  return [...offenders].sort()
}

/**
 * Finds the index of the `>` that closes the JSX opening tag starting at
 * `start` (which must point at `<`), tracking brace depth and string/
 * template quoting so `>` characters inside prop expressions (generics,
 * comparisons, arrow bodies) don't terminate the tag early. Returns -1 if
 * the tag never closes (malformed/truncated source).
 */
function openingTagEnd(text: string, start: number): number {
  let depth = 0
  let quote: string | null = null
  for (let index = start; index < text.length; index++) {
    const char = text[index]
    if (quote) {
      if (char === "\\" && quote !== "`") {
        index++
        continue
      }
      if (char === quote) quote = null
      continue
    }
    if (char === "\"" || char === "'" || char === "`") {
      quote = char
      continue
    }
    if (char === "{") {
      depth++
      continue
    }
    if (char === "}") {
      depth--
      continue
    }
    if (depth === 0 && char === ">") return index
  }
  return -1
}
