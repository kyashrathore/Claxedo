import { AcpTransportError } from "./errors"
import type { AcpEntry } from "./index"
import { AcpQuiet } from "./quiet"
import type { Clock, RoutedEvent } from "../../contract"
import type { AsyncPushQueue } from "@claxedo/helpers"

export function trackedAcpCancel(entry: AcpEntry): NonNullable<AcpEntry["cancelSent"]> {
  if (entry.cancelSent) return entry.cancelSent
  entry.cancelled = true
  entry.cancelSent = Promise.resolve().then(() => entry.peer.agent.cancel({ sessionId: entry.session.binding.upstreamSessionId }))
    .then(() => ({ ok: true as const }), (error: unknown) => {
      entry.phase = "uncertain"
      entry.queue?.fail(new AcpTransportError("session", "ACP cancel failed; prompt outcome is uncertain", error))
      return { ok: false as const, error }
    })
  return entry.cancelSent
}

export function acpQuiet(entry: AcpEntry, queue: AsyncPushQueue<RoutedEvent>, clock: Clock, timeoutMs: number): AcpQuiet {
  return new AcpQuiet(clock, timeoutMs, () => {
    entry.phase = "uncertain"
    void trackedAcpCancel(entry)
    queue.fail(new AcpTransportError("timeout", "ACP prompt outcome is uncertain"))
  })
}
