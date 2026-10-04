import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createAnchoredPosition } from "./anchored-position"
import { highlightRange } from "./highlight"
import { clippingArea, insideEditable, selectedQuote, type QuoteBoxPosition, type SelectedQuote } from "./selected-quote"

export type QuoteSelection = {
  readonly current: Accessor<SelectedQuote | undefined>
  readonly position: Accessor<QuoteBoxPosition | undefined>
  readonly draft: Accessor<string>
  readonly setDraft: (value: string) => void
  readonly setBox: (element: HTMLElement) => void
  readonly close: () => void
}

type QuoteBoxState = QuoteSelection & {
  readonly open: (quote: SelectedQuote) => void
  readonly contains: (target: EventTarget | null) => boolean
  readonly focusEditor: () => void
}

function createQuoteBoxState(root: Accessor<HTMLElement | undefined>): QuoteBoxState {
  const [current, setCurrent] = createSignal<SelectedQuote>()
  const [draft, setDraft] = createSignal("")
  let box: HTMLElement | undefined
  const anchored = createAnchoredPosition({
    anchor: () => current()?.range.getBoundingClientRect(),
    area: () => {
      const surface = root()
      return surface ? clippingArea(surface)?.getBoundingClientRect() : undefined
    },
  })
  return {
    current,
    position: anchored.position,
    draft,
    setDraft,
    setBox: (element) => (box = element),
    open: (quote) => {
      setCurrent(quote)
      anchored.place()
    },
    contains: (target) => target instanceof Node && !!box?.contains(target),
    focusEditor: () => box?.querySelector("textarea")?.focus(),
    close: () => {
      setCurrent(undefined)
      setDraft("")
      anchored.place()
    },
  }
}

function typedCharacter(event: KeyboardEvent): boolean {
  return event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && !event.isComposing
}

function keyHandler(box: QuoteBoxState) {
  return (event: KeyboardEvent) => {
    if (!box.current() || box.contains(event.target) || insideEditable(document.activeElement)) return
    if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      box.close()
      return
    }
    if (typedCharacter(event)) box.focusEditor()
  }
}

function watchSelection(box: QuoteBoxState, capture: () => void) {
  let pointerDown = false
  let frame: number | undefined
  const schedule = () => {
    if (frame !== undefined) return
    frame = requestAnimationFrame(() => {
      frame = undefined
      capture()
    })
  }
  makeEventListener(document, "pointerdown", (event) => {
    if (box.contains(event.target)) return
    pointerDown = true
    if (!box.draft().trim()) box.close()
  }, { capture: true })
  makeEventListener(document, "pointerup", () => {
    pointerDown = false
    schedule()
  }, { capture: true })
  makeEventListener(document, "selectionchange", () => pointerDown || schedule())
  onCleanup(() => frame !== undefined && cancelAnimationFrame(frame))
}

export function createQuoteSelection(input: {
  readonly root: Accessor<HTMLElement | undefined>
  readonly enabled: Accessor<boolean>
}): QuoteSelection {
  const box = createQuoteBoxState(input.root)
  watchSelection(box, () => {
    const root = input.root()
    if (!root || !input.enabled() || box.draft().trim()) return
    const next = selectedQuote(root, document.getSelection())
    if (next) box.open(next)
  })
  makeEventListener(document, "keydown", keyHandler(box), { capture: true })
  createEffect(() => input.enabled() || box.close())
  highlightRange("composer-quote", () => box.current()?.range)
  return box
}
