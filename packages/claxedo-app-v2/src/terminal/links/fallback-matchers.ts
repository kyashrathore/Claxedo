export type FallbackLink = {
  readonly link: string
  readonly path: string
  readonly line?: number
  readonly col?: number
  readonly index: number
}

const MATCHERS: readonly RegExp[] = [
  /^ *File (?<link>"(?<path>.+?)"(?:, line (?<line>\d+))?)/d,
  /^ +FILE +(?<link>(?<path>.+?)(?::(?<line>\d+)(?::(?<col>\d+))?)?)\s*$/d,
  /^ *--> (?<link>(?<path>[^:]+):(?<line>\d+)(?::(?<col>\d+))?)/d,
  /^(?<link>(?<path>[^\s:]+\.go):(?<line>\d+)(?::(?<col>\d+))?):/d,
  /\bat \S+\((?<link>(?<path>[^:)]+):(?<line>\d+))\)/d,
  /\bat .+\((?<link>(?<path>\/[^:)]+):(?<line>\d+)(?::(?<col>\d+))?)\)/d,
  /^(?<link>(?<path>\/[^\s:]+):(?<line>\d+)(?::(?<col>\d+))?) [-–]/d,
  /^@ (?<link>(?<path>\.[^\s]+) (?<line>\d+):(?<col>\d+))/d,
  /from (?<link>(?<path>[^:]+):(?<line>\d+)):in/d,
  /in (?<link>(?<path>[^\s]+) on line (?<line>\d+))/d,
  /^(?<link>(?<path>[^\s:]+\.swift):(?<line>\d+)(?::(?<col>\d+))?):/d,
  /^(?<link>(?<path>.+?)\((?<line>\d+)(?:, ?(?<col>\d+))?\)) ?:(?= |$)/d,
  /^(?<link>(?<path>(?:[^:]|:(?! ))+?):(?<line>\d+)(?::(?<col>\d+))?) ?:(?= |$)/d,
  /^(?:PS\s+)?(?<link>(?<path>(?:[a-zA-Z]:[\\/]|\\\\)[^>]*))>/d,
]

type IndexedMatch = RegExpExecArray & { indices?: { groups?: Record<string, [number, number] | undefined> } }

function linkIndex(match: IndexedMatch, link: string): number | undefined {
  const fromGroup = match.indices?.groups?.link?.[0]
  if (fromGroup !== undefined) return fromGroup
  const offset = match[0].indexOf(link)
  return offset === -1 ? undefined : (match.index ?? 0) + offset
}

export function detectFallbackLinks(line: string): FallbackLink[] {
  for (const matcher of MATCHERS) {
    const match = matcher.exec(line) as IndexedMatch | null
    const groups = match?.groups
    if (!match || !groups?.link || !groups.path) continue
    const index = linkIndex(match, groups.link)
    if (index === undefined) continue
    return [
      {
        link: groups.link,
        path: groups.path,
        line: groups.line ? Number.parseInt(groups.line, 10) : undefined,
        col: groups.col ? Number.parseInt(groups.col, 10) : undefined,
        index,
      },
    ]
  }
  return []
}
