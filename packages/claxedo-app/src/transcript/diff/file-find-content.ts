export type FileFindMatch = {
  line: number
  start: number
  length: number
}

export function fileFindLines(text: string): string[] {
  const lines = text.split("\n")
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop()
  return lines
}

export function fileFindMatches(lines: readonly string[], query: string): FileFindMatch[] {
  const needle = query.toLowerCase()
  if (!needle) return []

  const matches: FileFindMatch[] = []
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (!line) continue
    const hay = line.toLowerCase()
    let at = hay.indexOf(needle)
    while (at !== -1) {
      matches.push({ line: index + 1, start: at, length: needle.length })
      at = hay.indexOf(needle, at + needle.length)
    }
  }
  return matches
}

export function fileFindMatchesByLine(matches: readonly FileFindMatch[]): Map<number, number[]> {
  const byLine = new Map<number, number[]>()
  for (let index = 0; index < matches.length; index++) {
    const line = matches[index].line
    const bucket = byLine.get(line)
    if (bucket) bucket.push(index)
    else byLine.set(line, [index])
  }
  return byLine
}

export function assignFindRanges<Range>(
  matchCount: number,
  slotsByLine: ReadonlyMap<number, readonly number[]>,
  rows: Iterable<{ line: number; ranges: readonly Range[] }>,
): Array<Range | undefined> {
  const assigned: Array<Range | undefined> = Array.from({ length: matchCount }, () => undefined)
  for (const row of rows) {
    const slots = slotsByLine.get(row.line)
    if (!slots) continue
    for (let at = 0; at < slots.length && at < row.ranges.length; at++) {
      assigned[slots[at]] = row.ranges[at]
    }
  }
  return assigned
}
