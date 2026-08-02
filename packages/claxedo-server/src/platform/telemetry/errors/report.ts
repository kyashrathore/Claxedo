/**
 * Runtime-neutral error-reporting seam (D12, ops-floor decision: unattended
 * detection and grouping is the binding requirement for a solo-operator
 * on-call).
 *
 * The Worker, the Node server, and tests all share this module; none of them
 * import an SDK from here (this file must stay Worker-safe — the import-graph
 * guard walks it, and `posthog-node` is a forbidden Worker import). Each
 * entrypoint registers its own sink at boot: worker.ts → a fetch-based
 * `$exception` POST, server.ts → `posthog-node` (via observability/node.ts).
 * With no sink registered — which is exactly what happens when no PostHog key
 * is configured — every report is a clean no-op: no network, no throw.
 *
 * Page classes (exactly TWO per the ADR): payment-path errors carry
 * `page_class=payment` so a single alert rule can page the phone on them; the
 * external-uptime page class lives outside this process entirely. Everything
 * else lands in the daily digest.
 */

export type ErrorReportContext = {
  /** Extra tags attached to the event (merged over the unit/mode base tags). */
  tags?: Record<string, string>
  /** Non-indexed extra payload. NEVER include credential values or PII (I-5). */
  extra?: Record<string, unknown>
}

export type ErrorReporterSink = (
  error: unknown,
  context: { tags: Record<string, string>; extra: Record<string, unknown> },
) => void

let sink: ErrorReporterSink | undefined

/** Register the process's error sink. Pass undefined to reset (tests). */
export function setErrorReporterSink(next: ErrorReporterSink | undefined): void {
  sink = next
}

/** Report an error to the registered sink. No-op without one; never throws. */
export function reportError(error: unknown, context: ErrorReportContext = {}): void {
  try {
    sink?.(error, { tags: context.tags ?? {}, extra: context.extra ?? {} })
  } catch {
    // Observability must never take down the request path.
  }
}

/**
 * Payment-path page class (ADR §4: one of exactly two page classes).
 *
 * Wave-2 billing code (Polar webhook route, checkout, seat sync) calls THIS
 * instead of reportError so the events carry `page_class=payment`; the alert
 * rule that pages the phone matches on that property. Everything reported
 * through plain reportError stays digest-tier.
 */
export function reportPaymentError(error: unknown, context: ErrorReportContext = {}): void {
  reportError(error, {
    ...context,
    tags: { ...context.tags, page_class: "payment" },
  })
}
