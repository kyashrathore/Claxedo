export type FloatingPeekInput = {
  readonly floating: boolean
  readonly toggles: number
  readonly sends: number
  readonly sessionId: string
  readonly loaded: boolean
  readonly turns: number
}

export type FloatingPeekState = FloatingPeekInput & { readonly peeked: boolean }

export function floatingPeekStep(previous: FloatingPeekState | undefined, next: FloatingPeekInput): FloatingPeekState {
  if (!previous) return { ...next, peeked: false }
  let peeked = previous.peeked
  if (next.floating && !previous.floating) peeked = false
  if (next.toggles !== previous.toggles) peeked = !peeked
  const sent = next.sends !== previous.sends
  const grew = next.sessionId === previous.sessionId && previous.loaded && next.loaded && next.turns > previous.turns
  if (next.floating && (sent || grew)) peeked = true
  return { ...next, peeked }
}
