/**
 * The single rearm predicate over a WorkGraph reconcile result, shared by the
 * WorkGraphSettler Durable Object and the wakes settlement sinks. It walks the
 * whole result for unsettled-work markers: `unsettled: true`, `settled: false`,
 * an in-flight `state`, an explicit `retryAfterMs` request, or a non-empty
 * `launched[]` all mean the tenant needs another settlement pass.
 */
export interface SettlementRearm {
  pending: boolean
  /** Largest explicit retryAfterMs found anywhere in the result, if any. */
  retryAfterMs?: number
  /** True when this reconcile pass launched new work. */
  launched: boolean
}

export interface SettlementRearmOptions {
  /**
   * Whether `state: "parked"` counts as unsettled. A parked Run only clears via
   * an owner-issued restart, so the Settler DO must NOT keep re-arming on it
   * (it would spin its whole settlement window against work reconciling cannot
   * advance), while the wakes sinks historically treat it as retryable. Each
   * caller states its choice explicitly so the two behaviors never merge by
   * accident again.
   */
  parkedIsUnsettled: boolean
}

const UNSETTLED_STATES = ["pending", "provisioning", "running", "retrying_explicit_completion", "compensating"]

export function evaluateSettlementRearm(result: unknown, options: SettlementRearmOptions): SettlementRearm {
  const visited = new Set<object>()
  let pending = false
  let launched = false
  let retryAfterMs: number | undefined
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object" || visited.has(value)) return
    visited.add(value)
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    const record = value as Record<string, unknown>
    if (record.unsettled === true || record.settled === false || unsettledState(record.state, options)) pending = true
    if (finiteNonNegative(record.retryAfterMs)) {
      retryAfterMs = Math.max(retryAfterMs ?? 0, record.retryAfterMs)
      pending = true
    }
    if (Array.isArray(record.launched) && record.launched.length > 0) {
      pending = true
      launched = true
    }
    Object.values(record).forEach(visit)
  }
  visit(result)
  return { pending, launched, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) }
}

function unsettledState(value: unknown, options: SettlementRearmOptions) {
  if (typeof value !== "string") return false
  if (value === "parked") return options.parkedIsUnsettled
  return UNSETTLED_STATES.includes(value)
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}
