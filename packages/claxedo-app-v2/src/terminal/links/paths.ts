import { detectLinkSuffixes, type LinkPartialRange, type LinkSuffix } from "./suffix"

export type OperatingSystem = "windows" | "macintosh" | "linux"

export type ParsedLink = {
  readonly path: LinkPartialRange
  readonly prefix?: LinkPartialRange
  readonly suffix?: LinkSuffix
}

export function currentOperatingSystem(): OperatingSystem {
  const platform = typeof navigator === "undefined" ? "" : navigator.platform.toLowerCase()
  if (platform.includes("mac") || platform.includes("darwin")) return "macintosh"
  if (platform.includes("win")) return "windows"
  return "linux"
}

const PATH_WITH_SUFFIX = /(?<path>(?:file:\/\/\/)?[^\s|<>[({][^\s|<>]*)$/
const PATH_PREFIX = "(?:\\.\\.?|\\~|file:\\/\\/)"
const EXCLUDED = "[^\\0<>\\?\\s!`&*()'\";:\\\\]"
const EXCLUDED_START = "[^\\0<>\\?\\s!`&*()\\[\\]'\";:\\\\]"
const WIN_OTHER_PREFIX = "\\.\\.?|\\~"
const WIN_SEPARATOR = "(?:\\\\|\\/)"
const WIN_EXCLUDED = "[^\\0<>\\?\\|\\/\\s!`&*()'\";:]"
const WIN_EXCLUDED_START = "[^\\0<>\\?\\|\\/\\s!`&*()\\[\\]'\";:]"
const WIN_DRIVE_PREFIX = "(?:\\\\\\\\\\?\\\\|file:\\/\\/\\/)?[a-zA-Z]:"
const UNIX_PATH = `(?:(?:${PATH_PREFIX}|(?:${EXCLUDED_START}${EXCLUDED}*))?(?:\\/(?:${EXCLUDED})+)+)`
const WIN_PATH = `(?:(?:(?:${WIN_DRIVE_PREFIX}|${WIN_OTHER_PREFIX})|(?:${WIN_EXCLUDED_START}${WIN_EXCLUDED}*))?(?:${WIN_SEPARATOR}(?:${WIN_EXCLUDED})+)+)`

function conflicts(list: readonly ParsedLink[], item: ParsedLink): boolean {
  const start = item.path.index
  const end = start + item.path.text.length
  return list.some((other) => start < other.path.index + other.path.text.length && end > other.path.index)
}

function insertSorted(list: ParsedLink[], items: readonly ParsedLink[]): void {
  for (const item of items) {
    if (conflicts(list, item)) continue
    const at = list.findIndex((other) => other.path.index > item.path.index)
    list.splice(at === -1 ? list.length : at, 0, item)
  }
}

function trimQuotePrefix(path: string, start: number, suffix: LinkSuffix) {
  const prefixMatch = path.match(/^(?<prefix>['"]+)/)
  const text = prefixMatch?.groups?.prefix
  if (!text) return { path, start, prefix: undefined }
  let prefix: LinkPartialRange = { index: start, text }
  const bare = path.substring(text.length)
  const suffixFirst = suffix.suffix.text[0]
  const prefixLast = text[text.length - 1]
  if (text.length > 1 && suffixFirst && prefixLast && /['"]/.test(suffixFirst) && prefixLast === suffixFirst) {
    prefix = { index: start + text.length - 1, text: prefixLast }
    return { path: bare, start: start + text.length - 1, prefix }
  }
  return { path: bare, start, prefix }
}

function linksViaSuffix(line: string): ParsedLink[] {
  const results: ParsedLink[] = []
  for (const suffix of detectLinkSuffixes(line)) {
    const match = line.substring(0, suffix.suffix.index).match(PATH_WITH_SUFFIX)
    const rawPath = match?.groups?.path
    if (!match || match.index === undefined || !rawPath) continue
    const { path, start, prefix } = trimQuotePrefix(rawPath, match.index, suffix)
    if (path.trim().length === 0) continue
    const pathIndex = start + (prefix?.text.length ?? 0)
    results.push({ path: { index: pathIndex, text: path }, prefix, suffix })
    for (const bracket of path.matchAll(/(?<bracket>[[({])(?![\])}])/g)) {
      const open = bracket.groups?.bracket
      if (!open) continue
      results.push({
        path: { index: pathIndex + bracket.index + 1, text: path.substring(bracket.index + open.length) },
        prefix,
        suffix,
      })
    }
  }
  return results
}

function stripDiffMarker(line: string, text: string, index: number): { text: string; index: number } {
  const unified = (line.startsWith("--- a/") || line.startsWith("+++ b/")) && index === 4
  const gitDiff = line.startsWith("diff --git") && (text.startsWith("a/") || text.startsWith("b/"))
  return unified || gitDiff ? { text: text.substring(2), index: index + 2 } : { text, index }
}

function pathsWithoutSuffix(line: string, os: OperatingSystem): ParsedLink[] {
  const regex = new RegExp(os === "windows" ? WIN_PATH : UNIX_PATH, "g")
  const results: ParsedLink[] = []
  let match = regex.exec(line)
  while (match !== null) {
    if (!match[0]) break
    const { text, index } = stripDiffMarker(line, match[0], match.index)
    results.push({ path: { index, text } })
    match = regex.exec(line)
  }
  return results
}

export function detectLinks(line: string, os: OperatingSystem): ParsedLink[] {
  const results = linksViaSuffix(line)
  insertSorted(results, pathsWithoutSuffix(line, os))
  return results
}
