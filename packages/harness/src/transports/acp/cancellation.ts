import { AcpTransportError } from "./errors"
import type { AcpEntry } from "./index"
import type { Clock, Deadline, RoutedEvent } from "../../contract"
import { HoldableCountdown, settleAtRequestDeadline, type AsyncPushQueue } from "@claxedo/helpers"

export const ACP_CANCEL_DEADLINE_MS = 5_000

export function acpCancelDeadline(): Deadline {
  return { at: Date.now() + ACP_CANCEL_DEADLINE_MS, signal: new AbortController().signal }
}

export function trackedAcpCancel(entry: AcpEntry, deadline: Deadline): NonNullable<AcpEntry["cancelSent"]> {
  if (entry.cancelSent) return entry.cancelSent
  entry.cancelled = true
  let acknowledged = false
  let timeout: AcpTransportError | undefined
  const request = Promise.resolve().then(async () => {
    await entry.peer.agent.cancel({ sessionId: entry.session.binding.upstreamSessionId })
    acknowledged = true
    await Promise.allSettled([entry.prompt])
  })
  const tracked = settleAtRequestDeadline("session/cancel", { signal: deadline.signal, deadlineAt: deadline.at }, request, () => {},
    (what: string, aborted: boolean) => timeout = new AcpTransportError("timeout", `ACP ${what} ${aborted ? "was abandoned" : "timed out"}`))
    .then(() => ({ ok: true as const }), (error: unknown) => {
      const running = acknowledged && timeout !== undefined && error === timeout
      if (running) {
        entry.observation.stopIgnored("The ACP agent acknowledged the cancel but its prompt is still running")
        void request.then(entry.observation.stopSettled)
      } else {
        entry.phase = "uncertain"
        const failure = new AcpTransportError("session", "ACP cancel failed; prompt outcome is uncertain", error)
        entry.queue?.fail(failure)
        entry.providerTurn?.queue.fail(failure)
      }
      return { ok: false as const, error, running }
    })
  entry.cancelSent = tracked
  return tracked
}

export function acpQuiet(entry: AcpEntry, queue: AsyncPushQueue<RoutedEvent>, clock: Clock, timeoutMs: number): HoldableCountdown {
  return new HoldableCountdown(clock, timeoutMs, () => {
    entry.phase = "uncertain"
    void trackedAcpCancel(entry, acpCancelDeadline())
    queue.fail(new AcpTransportError("timeout", "ACP prompt outcome is uncertain"))
  })
}
