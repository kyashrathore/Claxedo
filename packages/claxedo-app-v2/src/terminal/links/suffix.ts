export type LinkPartialRange = { readonly index: number; readonly text: string }

export type LinkSuffix = {
  readonly row: number | undefined
  readonly col: number | undefined
  readonly rowEnd: number | undefined
  readonly colEnd: number | undefined
  readonly suffix: LinkPartialRange
}

function suffixRegex(eolOnly: boolean): RegExp {
  let ri = 0
  let ci = 0
  let rei = 0
  let cei = 0
  const r = () => `(?<row${ri++}>\\d+)`
  const c = () => `(?<col${ci++}>\\d+)`
  const re = () => `(?<rowEnd${rei++}>\\d+)`
  const ce = () => `(?<colEnd${cei++}>\\d+)`
  const eol = eolOnly ? "$" : ""
  const clauses = [
    `(?::|#| |['"],|, )${r()}([:.]${c()}(?:-(?:${re()}\\.)?${ce()})?)?${eol}`,
    `['"]?(?:,? |: ?| on )lines? ${r()}(?:-${re()})?(?:,? (?:col(?:umn)?|characters?) ${c()}(?:-${ce()})?)?${eol}`,
    `:? ?[[(]${r()}(?:(?:, ?|:)${c()})?[\\])]${eol}`,
  ]
  const clause = clauses.join("|").replace(/ /g, "[  ]")
  return new RegExp(`(${clause})`, eolOnly ? undefined : "g")
}

function parseIntOptional(value: string | undefined): number | undefined {
  return value === undefined ? undefined : Number.parseInt(value, 10)
}

function toLinkSuffix(match: RegExpExecArray | null): LinkSuffix | null {
  const groups = match?.groups
  if (!groups || match.length < 1) return null
  return {
    row: parseIntOptional(groups.row0 || groups.row1 || groups.row2),
    col: parseIntOptional(groups.col0 || groups.col1 || groups.col2),
    rowEnd: parseIntOptional(groups.rowEnd0 || groups.rowEnd1 || groups.rowEnd2),
    colEnd: parseIntOptional(groups.colEnd0 || groups.colEnd1 || groups.colEnd2),
    suffix: { index: match.index, text: match[0] },
  }
}

export function detectLinkSuffixes(line: string): LinkSuffix[] {
  const regex = suffixRegex(false)
  const results: LinkSuffix[] = []
  let match = regex.exec(line)
  while (match !== null) {
    const suffix = toLinkSuffix(match)
    if (suffix === null) break
    results.push(suffix)
    match = regex.exec(line)
  }
  return results
}

export function getLinkSuffix(link: string): LinkSuffix | null {
  return toLinkSuffix(suffixRegex(true).exec(link))
}

export function removeLinkSuffix(link: string): string {
  const suffix = getLinkSuffix(link)?.suffix
  return suffix ? link.substring(0, suffix.index) : link
}

export function decodeUrlEncodedPath(path: string): string {
  if (!path.includes("%")) return path
  try {
    return decodeURIComponent(path)
  } catch {
    return path
  }
}
