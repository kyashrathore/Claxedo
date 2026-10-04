import type { Clock } from "./services"
import type { Deadline } from "./session"

export function deadlineAfter(clock: Pick<Clock, "now">, ms: number): Deadline {
  return { at: clock.now() + ms, signal: new AbortController().signal }
}
