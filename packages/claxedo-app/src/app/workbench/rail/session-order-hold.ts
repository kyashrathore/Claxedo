/**
 * The rail orders sessions most-recently-active first, which is the order a reader
 * wants when they arrive and the wrong one to apply while they are aiming at a row.
 * Activity lands continuously — a turn settling, a title resolving — and each arrival
 * re-sorts the list, so a row can move out from under the pointer between seeing it
 * and clicking it. Reported as: "as soon as i click second session it moves to first,
 * feels like auto jumped back this is very bad."
 *
 * Two holds answer that, and both work the same way: remember where a row already is
 * and keep it there until holding it no longer helps.
 */

export type OrderableRow = { id: string }

/**
 * `held` is the order to preserve — the last order actually shown. `frozen` is true
 * while the reader is aiming at the list; `pinned` marks rows that must not move even
 * when it is not.
 *
 * A row the held order does not know is new to the list and takes its natural place,
 * so a session created while the pointer rests over the rail still appears where it
 * belongs rather than being withheld until the pointer leaves.
 */
export function holdSessionOrder<Row extends OrderableRow>(input: {
  next: readonly Row[]
  held: readonly string[] | undefined
  frozen: boolean
  pinned?: (row: Row) => boolean
}): Row[] {
  const held = input.held
  if (!held?.length) return input.next.slice()

  const rank = new Map(held.map((id, index) => [id, index] as const))
  const holds = (row: Row) => rank.has(row.id) && (input.frozen || !!input.pinned?.(row))
  const anchored = input.next.filter(holds).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!)
  if (!anchored.length) return input.next.slice()

  // Each held row is laid back down at the index it was remembered at, ascending so
  // earlier rows are already in place; everything else keeps the order the data asks
  // for and fills in around them. A row the held order never saw therefore cannot
  // push a held row aside — appearing must not be a reason for the list to shift.
  const result = input.next.filter((row) => !holds(row))
  for (const row of anchored) result.splice(Math.min(rank.get(row.id)!, result.length), 0, row)
  return result
}

/** A session mid-turn: its activity time moves on every step, so its row would too. */
export function isBusyRow(row: { status?: readonly string[]; active?: boolean }) {
  return !!row.active || !!row.status?.includes("busy")
}
