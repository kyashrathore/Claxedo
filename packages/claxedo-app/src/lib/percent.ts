/**
 * A usage percentage as a reader acts on it. The vendors report the fraction
 * they measured — `72.68615984405457` — which moves on every poll and answers
 * no question anyone asked of it.
 */
export function readPercent(value: number): number {
  return Math.round(value)
}

/**
 * The same figure where the surface writes the sign itself. A translated
 * sentence spells its own — Turkish `%73`, French `73 %`, Arabic `73٪` — so
 * those pass `readPercent` into their template rather than this.
 */
export function percentText(value: number): string {
  return `${readPercent(value)}%`
}
