/**
 * A usage percentage as a reader acts on it. The vendors report the fraction
 * they measured — `72.68615984405457` — which moves on every poll and answers
 * no question anyone asked of it.
 *
 * The number alone: every sentence that shows one writes its own sign, and a
 * translated sentence spells it its own way — Turkish `%73`, French `73 %`,
 * Arabic `73٪`.
 */
export function readPercent(value: number): number {
  return Math.round(value)
}
