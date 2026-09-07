/**
 * Whether the floating card shows its transcript. Collapsed by default; the
 * user peeks it open, and a prompt the user sends while floating opens it so
 * the reply never lands hidden. History that is still loading is not a turn.
 */
export type TranscriptPeekInput = {
  floating: boolean
  /** Bumped by each user peek toggle. */
  toggles: number
  /** Bumped by each prompt sent from this card. */
  sends: number
  sessionId: string | undefined
  /** The session's message list has arrived; growth after this point is a turn. */
  loaded: boolean
  turns: number
}

export type TranscriptPeekState = TranscriptPeekInput & { peeked: boolean }

export function transcriptPeekStep(previous: TranscriptPeekState | undefined, next: TranscriptPeekInput): TranscriptPeekState {
  if (!previous) return { ...next, peeked: false }
  let peeked = previous.peeked
  if (next.floating && !previous.floating) peeked = false
  if (next.toggles !== previous.toggles) peeked = !peeked
  const sent = next.sends !== previous.sends
  // A turn that arrived from elsewhere (another surface on the same session).
  const grew = next.sessionId === previous.sessionId && previous.loaded && next.loaded && next.turns > previous.turns
  if (next.floating && (sent || grew)) peeked = true
  return { ...next, peeked }
}
