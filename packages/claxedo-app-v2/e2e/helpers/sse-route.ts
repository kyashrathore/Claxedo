/**
 * Server-sent-event plumbing shared by the Playwright route mocks.
 *
 * `core-cloud-provisioning.spec.ts` and `core-host-tunnel-workspace.spec.ts`
 * each carried a byte-identical copy of both helpers. They describe the wire
 * format of one endpoint family, so they live once.
 */
import type { Route } from "@playwright/test"

/**
 * The cursor a reconnecting EventSource sends. Anything that is not a positive
 * finite number means "from the beginning", which is what a first connect does.
 */
export function lastEventId(route: Route): number {
  const value = Number(route.request().headers()["last-event-id"])
  return Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * Render a drained batch as an SSE body. An empty batch still has to answer
 * with something, or the client sees a closed stream instead of a quiet one.
 */
export function eventStream(events: readonly { id: number; payload: unknown }[]): string {
  if (events.length === 0) return ": heartbeat\n\n"
  return events.map((event) => `id: ${event.id}\ndata: ${JSON.stringify(event.payload)}\n\n`).join("")
}
