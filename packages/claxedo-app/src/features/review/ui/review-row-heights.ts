/**
 * One review surface's measured row heights, kept PER EXPANSION STATE.
 *
 * A row measured while collapsed says nothing about the height of the same row
 * expanded — they differ by the whole diff. One map keyed only by file let a
 * collapsed 40px measurement stand in for an expanded row, so the window
 * materialized its entire budget at header height and then tore most of it
 * down again a frame later, once the real heights landed.
 *
 * A height is only ever read back for the state it was measured in; the window
 * projects the rest (`reviewExpandedRowHeight`).
 */
export function createReviewRowHeights() {
  const heights = new Map<string, { collapsed?: number; expanded?: number }>()
  return {
    /** The measured height of `file` in this expansion state, if one exists. */
    get: (file: string, expanded: boolean) => {
      const entry = heights.get(file)
      return expanded ? entry?.expanded : entry?.collapsed
    },
    /** Record a height measured in this state. Returns whether it moved. */
    record: (file: string, expanded: boolean, height: number) => {
      const entry = heights.get(file)
      if (Math.abs(((expanded ? entry?.expanded : entry?.collapsed) ?? 0) - height) <= 0.5) return false
      heights.set(file, expanded ? { ...entry, expanded: height } : { ...entry, collapsed: height })
      return true
    },
  }
}
