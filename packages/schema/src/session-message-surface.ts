/**
 * Wire-level limits for the latency-bounded `latest-surface` transcript view.
 * All byte counts are UTF-8. Values that do not fit are omitted whole and the
 * authoritative `latest-turn` view repairs the fragment after first paint.
 */
export const LATEST_SURFACE_MAX_TEXT_PART_BYTES = 48 * 1024
export const LATEST_SURFACE_MAX_PART_BYTES = 56 * 1024
export const LATEST_SURFACE_MAX_TEXT_BYTES = 64 * 1024
export const LATEST_SURFACE_MAX_PARTS_BYTES = 80 * 1024
export const LATEST_SURFACE_MAX_TEXT_PARTS = 16
export const LATEST_SURFACE_MAX_OPTIONAL_INFO_VALUE_BYTES = 8 * 1024
export const LATEST_SURFACE_MAX_INFO_BYTES = 16 * 1024

export type LatestSurfaceTextBudget = {
  textBytes: number
  partBytes: number
  count: number
}

export type LatestSurfaceTextBudgetCandidate = Readonly<{
  textBytes: number
  partBytes: number
}>

function utf8Bytes(value: string) {
  return new TextEncoder().encode(value).byteLength
}

/** The canonical UTF-8 JSON byte measure for a first-paint wire value. */
export function latestSurfaceJSONBytes(value: unknown) {
  try {
    const encoded = JSON.stringify(value)
    return encoded === undefined ? Number.POSITIVE_INFINITY : utf8Bytes(encoded)
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

/**
 * Apply the envelope-only latest-surface contract to the final wire shape.
 * Optional values are omitted whole; a required envelope that still exceeds
 * the limit makes the complete surface unavailable until `latest-turn`.
 */
export function projectLatestSurfaceInfo<TInfo extends Record<string, unknown>>(input: TInfo): TInfo | undefined {
  const info: Record<string, unknown> = { ...input }
  if (info.role === "user") {
    delete info.summary
    delete info.system
    delete info.tools
  }
  if (
    info.role === "assistant" &&
    "error" in info &&
    latestSurfaceJSONBytes(info.error) > LATEST_SURFACE_MAX_OPTIONAL_INFO_VALUE_BYTES
  ) {
    delete info.error
  }
  if (latestSurfaceJSONBytes(info) > LATEST_SURFACE_MAX_INFO_BYTES) return undefined
  return info as TInfo
}

/** Select a bounded newest-priority set from candidates in priority order. */
export function selectLatestSurfaceTextCandidates(
  candidates: readonly LatestSurfaceTextBudgetCandidate[],
  initial: LatestSurfaceTextBudget = { textBytes: 0, partBytes: 0, count: 0 },
) {
  const budget = { ...initial }
  const indexes: number[] = []
  for (const [index, candidate] of candidates.entries()) {
    if (budget.count >= LATEST_SURFACE_MAX_TEXT_PARTS) break
    if (candidate.textBytes > LATEST_SURFACE_MAX_TEXT_PART_BYTES) continue
    if (candidate.partBytes > LATEST_SURFACE_MAX_PART_BYTES) continue
    if (budget.textBytes + candidate.textBytes > LATEST_SURFACE_MAX_TEXT_BYTES) continue
    if (budget.partBytes + candidate.partBytes > LATEST_SURFACE_MAX_PARTS_BYTES) continue
    indexes.push(index)
    budget.count++
    budget.textBytes += candidate.textBytes
    budget.partBytes += candidate.partBytes
  }
  return { indexes, budget }
}
