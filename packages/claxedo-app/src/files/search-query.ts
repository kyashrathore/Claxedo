import { createEffect, createSignal, on, onCleanup, untrack, type Accessor } from "solid-js"

export const SEARCH_DEBOUNCE_MS = 150

export function debouncedQuery(typed: Accessor<string>, scope: Accessor<unknown>): Accessor<string> {
  const [query, setQuery] = createSignal(untrack(typed))
  createEffect(
    on(
      [typed, scope],
      ([next, current], previous) => {
        if (!next || !previous || previous[1] !== current) {
          setQuery(next)
          return
        }
        const timer = setTimeout(() => setQuery(next), SEARCH_DEBOUNCE_MS)
        onCleanup(() => clearTimeout(timer))
      },
      { defer: true },
    ),
  )
  return query
}
