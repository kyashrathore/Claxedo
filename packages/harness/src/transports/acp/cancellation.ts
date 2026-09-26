import { AcpTransportError } from "./errors"
import type { AcpEntry } from "./index"
import { AcpQuiet } from "./quiet"
import type { Clock, Deadline, RoutedEvent } from "../../contract"
import { settleAtRequestDeadline, type AsyncPushQueue } from "@claxedo/helpers"

export const ACP_CANCEL_DEADLINE_MS = 5_000

export function acpCancelDeadline(): Deadline {
  return { at: Date.now() + ACP_CANCEL_DEADLINE_MS, signal: new AbortController().signal }
}

export function trackedAcpCancel(entry: AcpEntry, deadline: Deadline): NonNullable<AcpEntry["cancelSent"]> {
  if (entry.cancelSent) return entry.cancelSent
  entry.cancelled = true
  const request = Promise.resolve().then(() => entry.peer.agent.cancel({ sessionId: entry.session.binding.upstreamSessionId }))
  const tracked = settleAtRequestDeadline("session/cancel", { signal: deadline.signal, deadlineAt: deadline.at }, request, () => {},
    (what: string, aborted: boolean) => new AcpTransportError("timeout", `ACP ${what} ${aborted ? "was abandoned" : "timed out"}`))
    .then(() => ({ ok: true as const }), (error: unknown) => {
      entry.phase = "uncertain"
      entry.queue?.fail(new AcpTransportError("session", "ACP cancel failed; prompt outcome is uncertain", error))
      return { ok: false as const, error }
    })
  entry.cancelSent = tracked
  return tracked
}

export function acpQuiet(entry: AcpEntry, queue: AsyncPushQueue<RoutedEvent>, clock: Clock, timeoutMs: number): AcpQuiet {
  return new AcpQuiet(clock, timeoutMs, () => {
    entry.phase = "uncertain"
    void trackedAcpCancel(entry, acpCancelDeadline())
    queue.fail(new AcpTransportError("timeout", "ACP prompt outcome is uncertain"))
  })
}
