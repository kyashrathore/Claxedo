import { type SelectedLineRange, type SelectionSide } from "@pierre/diffs"

/**
 * Which column of a split diff a selection belongs to. `@pierre/diffs` owns the definition;
 * this alias only gives it the name this package's diff code uses.
 */
export type DiffSelectionSide = SelectionSide

export function findDiffSide(node: HTMLElement): DiffSelectionSide {
  const line = node.closest("[data-line], [data-alt-line]")
  if (line instanceof HTMLElement) {
    const side = diffSideFromLineType(line.dataset.lineType)
    if (side) return side
  }

  const code = node.closest("[data-code]")
  if (!(code instanceof HTMLElement)) return "additions"
  return code.hasAttribute("data-deletions") ? "deletions" : "additions"
}

/** Maps a `data-line-type` attribute to the side it belongs to, or `undefined` when it names neither. */
export function diffSideFromLineType(type: string | undefined): DiffSelectionSide | undefined {
  if (type === "change-deletion") return "deletions"
  if (type === "change-addition" || type === "change-additions") return "additions"
  return undefined
}

export function diffLineIndex(split: boolean, node: HTMLElement): number | undefined {
  const raw = node.dataset.lineIndex
  if (!raw) return undefined

  const values = raw
    .split(",")
    .map((x) => parseInt(x, 10))
    .filter((x) => !Number.isNaN(x))
  if (values.length === 0) return undefined
  if (!split) return values[0]
  if (values.length === 2) return values[1]
  return values[0]
}

export function diffRowIndex(
  root: ShadowRoot,
  split: boolean,
  line: number,
  side: DiffSelectionSide | undefined,
): number | undefined {
  const rows = Array.from(root.querySelectorAll(`[data-line="${line}"], [data-alt-line="${line}"]`)).filter(
    (node): node is HTMLElement => node instanceof HTMLElement,
  )
  if (rows.length === 0) return undefined

  const target = side ?? "additions"
  for (const row of rows) {
    if (findDiffSide(row) === target) return diffLineIndex(split, row)
    if (parseInt(row.dataset.altLine ?? "", 10) === line) return diffLineIndex(split, row)
  }
  return undefined
}

export function fixDiffSelection(
  root: ShadowRoot | undefined,
  range: SelectedLineRange | null,
): SelectedLineRange | null | undefined {
  if (!range) return range
  if (!root) return undefined

  const diffs = root.querySelector("[data-diff]")
  if (!(diffs instanceof HTMLElement)) return undefined

  const split = diffs.dataset.diffType === "split"
  const start = diffRowIndex(root, split, range.start, range.side)
  const end = diffRowIndex(root, split, range.end, range.endSide ?? range.side)

  if (start === undefined || end === undefined) {
    if (root.querySelector("[data-line], [data-alt-line]") == null) return undefined
    return null
  }
  if (start <= end) return range

  const side = range.endSide ?? range.side
  const swapped: SelectedLineRange = {
    start: range.end,
    end: range.start,
  }

  if (side) swapped.side = side
  if (range.endSide && range.side) swapped.endSide = range.side
  return swapped
}
