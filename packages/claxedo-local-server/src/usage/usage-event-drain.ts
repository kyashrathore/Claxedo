export async function drainUsageEvents(
  eventTail: Promise<void>,
  meter: { flush(): Promise<void> },
) {
  // Events are appended to the tail before the meter sees them. Flushing the
  // meter first can complete successfully while a queued terminal event is
  // still waiting to be consumed, losing that fact during shutdown.
  await eventTail
  await meter.flush()
}
