import { cleanup, fireEvent, render } from "@solidjs/testing-library"
import { createSignal, Show } from "solid-js"
import { ScrollableOutput } from "@opencode-ai/session-ui/scrollable-output"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

// jsdom lays nothing out, so the box reports the heights the test gives it and
// the observer fires when the test says the content changed.
let observers: Array<() => void> = []
class FakeResizeObserver {
  constructor(private readonly callback: () => void) {
    observers.push(callback)
  }
  observe() {}
  disconnect() {}
}

function heights(box: HTMLElement, input: { scroll: number; client: number }) {
  Object.defineProperty(box, "scrollHeight", { configurable: true, get: () => input.scroll })
  Object.defineProperty(box, "clientHeight", { configurable: true, get: () => input.client })
}

function mount() {
  let rowClicks = 0
  const view = render(() => (
    <div data-testid="row" onClick={() => rowClicks++}>
      <ScrollableOutput component="tool-output">
        <pre>output</pre>
      </ScrollableOutput>
    </div>
  ))
  const box = view.container.querySelector<HTMLElement>('[data-component="tool-output"]')
  if (!box) throw new Error("the output box never mounted")
  const toggle = () => view.container.querySelector<HTMLButtonElement>('[data-slot="scrollable-output-toggle"]')
  const resize = () => observers.forEach((callback) => callback())
  return { view, box, toggle, resize, rowClicks: () => rowClicks }
}

beforeEach(() => {
  observers = []
  Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: FakeResizeObserver })
})
afterEach(cleanup)

describe("ScrollableOutput", () => {
  test("output that fits the cap has no control", () => {
    const { box, toggle, resize } = mount()
    heights(box, { scroll: 120, client: 240 })
    resize()
    expect(toggle()).toBeNull()
  })

  test("output taller than the cap can be revealed in full and capped again", () => {
    const { box, toggle, resize } = mount()
    heights(box, { scroll: 1512, client: 240 })
    resize()
    expect(toggle()?.textContent).toBe("Show all")
    expect(box.dataset.revealed).toBeUndefined()

    fireEvent.click(toggle()!)
    expect(box.dataset.revealed).toBe("true")
    expect(toggle()?.textContent).toBe("Show less")

    fireEvent.click(toggle()!)
    expect(box.dataset.revealed).toBeUndefined()
    expect(toggle()?.textContent).toBe("Show all")
  })

  test("content that grows past the cap after mount gains the control", () => {
    const { box, toggle, resize } = mount()
    heights(box, { scroll: 200, client: 240 })
    resize()
    expect(toggle()).toBeNull()
    heights(box, { scroll: 900, client: 240 })
    resize()
    expect(toggle()?.textContent).toBe("Show all")
  })

  test("a controlled reveal survives the box being unmounted and remounted", () => {
    const [mounted, setMounted] = createSignal(true)
    const [revealed, setRevealed] = createSignal(false)
    const view = render(() => (
      <Show when={mounted()}>
        <ScrollableOutput component="tool-output" revealed={revealed()} onRevealedChange={setRevealed}>
          <pre>output</pre>
        </ScrollableOutput>
      </Show>
    ))
    const box = () => view.container.querySelector<HTMLElement>('[data-component="tool-output"]')
    const toggle = () => view.container.querySelector<HTMLButtonElement>('[data-slot="scrollable-output-toggle"]')
    heights(box()!, { scroll: 1512, client: 240 })
    observers.forEach((callback) => callback())

    fireEvent.click(toggle()!)
    expect(revealed()).toBe(true)

    setMounted(false)
    expect(box()).toBeNull()
    setMounted(true)
    heights(box()!, { scroll: 1512, client: 240 })
    observers.forEach((callback) => callback())

    expect(box()!.dataset.revealed).toBe("true")
    expect(toggle()?.textContent).toBe("Show less")
    expect(toggle()?.getAttribute("aria-expanded")).toBe("true")
  })

  test("the control does not toggle the row it sits in", () => {
    const { box, toggle, resize, rowClicks } = mount()
    heights(box, { scroll: 900, client: 240 })
    resize()
    fireEvent.click(toggle()!)
    expect(rowClicks()).toBe(0)
  })
})
