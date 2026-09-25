import { createMemo, createSignal, type Accessor } from "solid-js"

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

export type FloatingPeek = {
  readonly peeked: Accessor<boolean>
  readonly toggle: () => void
  readonly sent: () => void
}

export function createFloatingPeek(input: {
  readonly floating: Accessor<boolean>
  readonly sessionId: Accessor<string>
  readonly loaded: Accessor<boolean>
  readonly turns: Accessor<number>
}): FloatingPeek {
  const [toggles, setToggles] = createSignal(0)
  const [sends, setSends] = createSignal(0)
  const peek = createMemo<FloatingPeekState>((previous) =>
    floatingPeekStep(previous, {
      floating: input.floating(),
      toggles: toggles(),
      sends: sends(),
      sessionId: input.sessionId(),
      loaded: input.loaded(),
      turns: input.turns(),
    }),
  )
  return {
    peeked: () => peek().peeked,
    toggle: () => setToggles((count) => count + 1),
    sent: () => setSends((count) => count + 1),
  }
}
