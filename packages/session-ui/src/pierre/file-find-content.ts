/**
 * Where a find query matches, read from the file's own text.
 *
 * A text view renders a WINDOW of its file: the rows outside that window have
 * no DOM, so a find that reads the rendered rows can only ever report the
 * matches that happen to be on screen — the count is wrong and the matches
 * below the fold are unreachable. The file's text is the thing that does not
 * move, so the match list is computed from it and the DOM is used only to
 * paint the matches whose rows currently exist.
 *
 * Matches are per line and never span one, which is the rule the rendered-row
 * scan already followed (it searched each row's `textContent` on its own). The
 * comparison is case-insensitive and occurrences within a line do not overlap.
 */

export type FileFindMatch = {
  /** 1-based, the same numbering `data-line` carries. */
  line: number
  /** Character offset of the match inside its line. */
  start: number
  length: number
}

/** The lines a file's contents are rendered as, 1-based by index + 1. */
export function fileFindLines(text: string): string[] {
  const lines = text.split("\n")
  // A trailing newline ends the last line, it does not begin another one --
  // the renderer draws one row per line and does the same.
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

/** Which match indexes fall on each line, in the order they were found. */
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

/**
 * Line up what the rendered rows can paint with what the file says is there.
 *
 * The match list is the file's; a rendered row supplies the ranges for its own
 * line, in its own order. Pairing them positionally keeps a highlighted row's
 * offsets its own — the row is the authority on where its text sits — while the
 * count, the order and the navigation stay the file's. A line with no rendered
 * row leaves its matches unpaired, which is what makes them still countable.
 */
export function assignFindRanges<Range>(
  matchCount: number,
  slotsByLine: ReadonlyMap<number, readonly number[]>,
  rows: Iterable<{ line: number; ranges: readonly Range[] }>,
): Array<Range | undefined> {
  const assigned: Array<Range | undefined> = new Array(matchCount).fill(undefined)
  for (const row of rows) {
    const slots = slotsByLine.get(row.line)
    if (!slots) continue
    for (let at = 0; at < slots.length && at < row.ranges.length; at++) {
      assigned[slots[at]] = row.ranges[at]
    }
  }
  return assigned
}
