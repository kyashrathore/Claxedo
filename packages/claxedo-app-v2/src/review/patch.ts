import type { LineSide } from "./model"

export type PatchLine = {
  readonly index: number
  readonly kind: "hunk" | "context" | "add" | "del" | "note"
  readonly old?: number
  readonly new?: number
  readonly text: string
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

function isHeader(line: string): boolean {
  return line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ")
}

export function parsePatch(patch: string): readonly PatchLine[] {
  const out: PatchLine[] = []
  let old = 0
  let next = 0
  let inHunk = false
  for (const line of patch.split("\n")) {
    const hunk = line.match(HUNK)
    if (hunk) {
      old = Number.parseInt(hunk[1], 10)
      next = Number.parseInt(hunk[2], 10)
      inHunk = true
      out.push({ index: out.length, kind: "hunk", text: line })
    } else if (!inHunk || isHeader(line)) {
      continue
    } else if (line.startsWith("+")) {
      out.push({ index: out.length, kind: "add", new: next, text: line.slice(1) })
      next += 1
    } else if (line.startsWith("-")) {
      out.push({ index: out.length, kind: "del", old, text: line.slice(1) })
      old += 1
    } else if (line.startsWith("\\")) {
      out.push({ index: out.length, kind: "note", text: line.slice(1).trim() })
    } else {
      out.push({ index: out.length, kind: "context", old, new: next, text: line.slice(1) })
      old += 1
      next += 1
    }
  }
  return out
}

export function selectable(line: PatchLine): boolean {
  return line.kind === "add" || line.kind === "del" || line.kind === "context"
}

export type LineRange = {
  readonly start: number
  readonly end: number
  readonly side: LineSide
  readonly preview: string
}

export function rangeOf(lines: readonly PatchLine[], from: number, to: number): LineRange | undefined {
  const [first, last] = from <= to ? [from, to] : [to, from]
  const picked = lines.slice(first, last + 1).filter(selectable)
  if (picked.length === 0) return undefined
  const side: LineSide = picked[0].kind === "del" ? "deletions" : "additions"
  const numbers = picked.map((line) => (side === "deletions" ? line.old : line.new)).filter((n): n is number => n !== undefined)
  if (numbers.length === 0) return undefined
  return {
    start: Math.min(...numbers),
    end: Math.max(...numbers),
    side,
    preview: picked.map((line) => line.text).join("\n"),
  }
}
