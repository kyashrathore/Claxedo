import { createSignal, type Accessor } from "solid-js"

export type Transition<State, Event> = (state: State, event: Event) => State

export type Machine<State, Event> = {
  readonly state: Accessor<State>
  readonly send: (event: Event) => void
}

export function machine<State extends { kind: string }, Event extends { type: string }>(
  initial: State,
  transition: Transition<State, Event>,
): Machine<State, Event> {
  const [state, setState] = createSignal(initial)
  return {
    state,
    send: (event) => setState((current) => transition(current, event)),
  }
}

export function unreachable(value: never): never {
  throw new Error(`Unhandled case: ${JSON.stringify(value)}`)
}
