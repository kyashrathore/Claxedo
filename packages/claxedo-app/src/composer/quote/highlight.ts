import { createEffect, on, onCleanup, type Accessor } from "solid-js"

export type QuoteHighlightName = "composer-quote" | "composer-quote-edit"

function registered(name: QuoteHighlightName): Highlight | undefined {
  if (typeof CSS === "undefined" || typeof Highlight !== "function") return undefined
  const existing = CSS.highlights.get(name)
  if (existing) return existing
  const created = new Highlight()
  CSS.highlights.set(name, created)
  return created
}

export function highlightRange(name: QuoteHighlightName, range: Accessor<Range | undefined>) {
  createEffect(
    on(range, (current, previous) => {
      if (previous) registered(name)?.delete(previous)
      if (current) registered(name)?.add(current)
    }),
  )
  onCleanup(() => {
    const current = range()
    if (current) registered(name)?.delete(current)
  })
}
