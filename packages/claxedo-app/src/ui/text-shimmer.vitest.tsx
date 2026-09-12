import { cleanup, render } from "@solidjs/testing-library"
import { TextShimmer } from "@opencode-ai/ui/text-shimmer"
import { createSignal } from "solid-js"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const SWAP_MS = 220

const base = (root: HTMLElement) => root.querySelectorAll('[data-slot="text-shimmer-char-base"]')
const swept = (root: HTMLElement) => root.querySelectorAll('[data-slot="text-shimmer-char-shimmer"]')

/**
 * The crossfade needs a computed style to animate from, and jsdom computes none
 * on its own, so the component forces one by reading a layout property. Recording
 * the shimmer's state at each of those reads is what makes the fade-in observable
 * here: a read that happens while the swept copy exists and the root is still
 * unlit is the start frame the transition animates from.
 */
function recordLayoutReads() {
  const reads: Array<{ swept: boolean; active: string | null }> = []
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
    if (this.dataset.component === "text-shimmer") {
      reads.push({ swept: swept(this).length > 0, active: this.getAttribute("data-active") })
    }
    return 0
  })
  return reads
}

describe("TextShimmer", () => {
  beforeEach(() => vi.useFakeTimers())

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    cleanup()
  })

  test("an idle row carries one copy of the text and no swept copy", () => {
    const { container } = render(() => <TextShimmer text="Reading" active={false} />)
    const root = container.querySelector<HTMLElement>('[data-component="text-shimmer"]')!

    expect(base(root)).toHaveLength(1)
    expect(swept(root)).toHaveLength(0)
    expect(root.textContent).toBe("Reading")
  })

  test("activating mounts the swept copy and lights it only after a computed start frame", () => {
    const reads = recordLayoutReads()
    const [active, setActive] = createSignal(false)
    const { container } = render(() => <TextShimmer text="Reading" active={active()} />)
    const root = container.querySelector<HTMLElement>('[data-component="text-shimmer"]')!
    expect(swept(root)).toHaveLength(0)

    setActive(true)

    expect(swept(root)).toHaveLength(1)
    expect(root.getAttribute("data-active")).toBe("false")

    vi.advanceTimersToNextFrame()

    expect(root.getAttribute("data-active")).toBe("true")
    expect(reads).toContainEqual({ swept: true, active: "false" })
  })

  test("deactivating keeps the swept copy through the swap window, then drops it", () => {
    const [active, setActive] = createSignal(true)
    const { container } = render(() => <TextShimmer text="Reading" active={active()} />)
    const root = container.querySelector<HTMLElement>('[data-component="text-shimmer"]')!
    expect(swept(root)).toHaveLength(1)

    setActive(false)

    expect(root.getAttribute("data-active")).toBe("false")
    vi.advanceTimersByTime(SWAP_MS - 1)
    expect(swept(root)).toHaveLength(1)

    vi.advanceTimersByTime(1)
    expect(swept(root)).toHaveLength(0)
    expect(base(root)).toHaveLength(1)
  })

  test("reactivating inside the swap window cancels the pending unmount", () => {
    const [active, setActive] = createSignal(true)
    const { container } = render(() => <TextShimmer text="Reading" active={active()} />)
    const root = container.querySelector<HTMLElement>('[data-component="text-shimmer"]')!

    setActive(false)
    vi.advanceTimersByTime(SWAP_MS - 50)
    setActive(true)
    vi.advanceTimersByTime(SWAP_MS)

    expect(swept(root)).toHaveLength(1)
    expect(root.getAttribute("data-active")).toBe("true")
  })
})
