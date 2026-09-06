/**
 * Runtime-neutral error-reporting seam.
 *
 * The Worker, the Node server, and tests share this module, and none of them
 * import an SDK from here: the file must stay Worker-safe (the import-graph
 * guard walks it, and `posthog-node` is a forbidden Worker import). Only the
 * Node server registers a sink (`posthog-node`, via `./node.ts`); the Worker
 * reports through `platform/auth/worker-telemetry.ts` without this seam. With
 * no sink registered, which is also what no PostHog key means, every report is
 * a no-op.
 *
 * Two page classes: payment-path errors carry `page_class=payment` so one
 * alert rule can page on them; the external-uptime class lives outside this
 * process. Everything else lands in the daily digest.
 */

export type ErrorReportContext = {
  /** Extra tags attached to the event (merged over the unit/mode base tags). */
  tags?: Record<string, string>
  /** Non-indexed extra payload. Never include credential values or PII. */
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
 * Billing code reports through this instead of `reportError` so the event
 * carries `page_class=payment`, the property the paging alert rule matches on.
 */
export function reportPaymentError(error: unknown, context: ErrorReportContext = {}): void {
  reportError(error, {
    ...context,
    tags: { ...context.tags, page_class: "payment" },
  })
}
