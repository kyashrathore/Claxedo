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

  events: OpenCodeEventHealth

  reason?: string
}>

export function canServe(lifecycle: OpenCodeLifecycle): boolean {
  return lifecycle === "ready" || lifecycle === "draining"
}

export function isTerminal(lifecycle: OpenCodeLifecycle): boolean {
  return lifecycle === "closed"
}

const ORDER: readonly OpenCodeLifecycle[] = ["cold", "migrating", "ready", "draining", "closed"]

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
