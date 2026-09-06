/**
 * Nearest-rank percentile, no interpolation. `rank` is on the 0-100 percentage
 * scale. Sorts a copy, so callers never need to pre-sort and the input is never
 * mutated; `.sort()` on a spread rather than `toSorted`, which is ES2023 and not
 * guaranteed on every workerd/renderer target this replaces.
 */
export function percentile(values: readonly number[], rank: number): number {
  const count = values.length
  if (count === 0 || !Number.isFinite(rank) || rank < 0 || rank > 100) return Number.NaN
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.min(Math.max(Math.ceil((rank / 100) * count) - 1, 0), count - 1)
  return sorted[index] ?? Number.NaN
}

/**
 * Two decimal places, for the metric and timing values whose copies all wrote
 * `Math.round(value * 100) / 100`. Non-finite input is returned unchanged — and
 * so is a finite value large enough that `* 100` overflows, which the bare
 * expression turns into Infinity.
 */
export function round2(value: number): number {
  const scaled = Math.round(value * 100)
  return Number.isFinite(scaled) ? scaled / 100 : value
}

/**
 * The one string-to-positive-number parse in this package. Lenient: never
 * throws, so callers apply `?? fallback`. Returns the parsed NUMBER, never the
 * source string; a non-string, blank, zero, negative, NaN or Infinite value all
 * yield undefined.
 */
export function parsePositiveNumber(input: unknown): number | undefined {
  if (typeof input !== "string") return undefined
  const trimmed = input.trim()
  if (trimmed.length === 0) return undefined
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

/** The integral form: additionally rejects fractions and unsafe magnitudes. */
export function parsePositiveInteger(input: unknown): number | undefined {
  const parsed = parsePositiveNumber(input)
  return parsed !== undefined && Number.isSafeInteger(parsed) ? parsed : undefined
}
