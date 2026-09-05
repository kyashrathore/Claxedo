/**
 * OpenCode runtime lifecycle and health, as separate dimensions.
 *
 * Lifecycle is a linear progression a host makes exactly once:
 *
 *   cold -> migrating -> ready -> draining -> closed
 *
 * with `unavailable` as an observable failure state reachable from `cold` or
 * `migrating`. A closed owner never reopens; a restart constructs a fresh one.
 *
 * Event health is ORTHOGONAL. An OpenCode host can be `ready` while its event
 * stream is `degraded` (reconnecting after stream loss), and that combination
 * must stay describable — collapsing the two into one enum is what makes
 * "sessions work but the UI stopped updating" unreportable.
 *
 * Other harnesses do not depend on this state machine.
 */

export type OpenCodeLifecycle =
  | "cold"
  | "migrating"
  | "ready"
  | "draining"
  | "closed"
  | "unavailable"

export type OpenCodeEventHealth = "healthy" | "degraded"

export type OpenCodeStatus = Readonly<{
  lifecycle: OpenCodeLifecycle
  /** Only meaningful once the host has started its event pump. */
  events: OpenCodeEventHealth
  /** Present when lifecycle is `unavailable`; the reason the host is unusable. */
  reason?: string
}>

/** Lifecycle states that may serve OpenCode work. */
export function canServe(lifecycle: OpenCodeLifecycle): boolean {
  return lifecycle === "ready" || lifecycle === "draining"
}

/** A closed owner is terminal: no retry, no reopen, construct a new one. */
export function isTerminal(lifecycle: OpenCodeLifecycle): boolean {
  return lifecycle === "closed"
}

const ORDER: readonly OpenCodeLifecycle[] = ["cold", "migrating", "ready", "draining", "closed"]

/**
 * Guards the linear progression. `unavailable` is reachable only from the
 * pre-serving states — once a host has served work it drains and closes rather
 * than reporting itself unavailable, so in-flight callers get a real drain.
 */
export function canTransition(from: OpenCodeLifecycle, to: OpenCodeLifecycle): boolean {
  if (from === to) return true
  if (isTerminal(from)) return false
  if (to === "unavailable") return from === "cold" || from === "migrating"
  if (from === "unavailable") return to === "cold" || to === "closed"
  const start = ORDER.indexOf(from)
  const end = ORDER.indexOf(to)
  if (start < 0 || end < 0) return false
  return end > start
}
