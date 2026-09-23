import { afterEach, describe, expect, test } from "bun:test"
import { animateHeightChanges } from "@/ui/controls/animate-height"

type Entry = { target: Element }
type Callback = (entries: Entry[]) => void

/** The observer the box is watched through, driven by hand. */
function stubResizeObserver() {
  const observers: Array<{ callback: Callback; targets: Element[] }> = []
  class FakeResizeObserver {
    private readonly entry: { callback: Callback; targets: Element[] }
    constructor(callback: Callback) {
      this.entry = { callback, targets: [] }
      observers.push(this.entry)
    }
    observe(target: Element) {
      this.entry.targets.push(target)
    }
    disconnect() {
      this.entry.targets.length = 0
    }
  }
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver
  return {
    fire: (targets: Element[]) => {
      for (const observer of observers) observer.callback(targets.map((target) => ({ target })))
    },
    observed: () => observers.flatMap((observer) => observer.targets),
  }
}

/** A box whose measured height is whatever the test says, and whose animations are recorded. */
function stubBox() {
  const box = document.createElement("div")
  const animations: Array<{ from: string; to: string; cancelled: boolean; finish: () => void }> = []
  let height = 100
  // Mid-animation the first measurement is the frame on screen; the next is layout's.
  const frames: number[] = []
  box.getBoundingClientRect = () => ({ height: frames.shift() ?? height } as DOMRect)
  box.animate = ((keyframes: Array<{ height: string }>) => {
    const listeners: Array<() => void> = []
    const record = { from: keyframes[0].height, to: keyframes[1].height, cancelled: false, finish: () => listeners.forEach((fn) => fn()) }
    animations.push(record)
    return {
      cancel: () => {
        record.cancelled = true
      },
      addEventListener: (_: string, listener: () => void) => listeners.push(listener),
    } as unknown as Animation
  }) as typeof box.animate
  return {
    box,
    animations,
    setHeight: (value: number) => (height = value),
    onScreen: (value: number) => frames.push(value),
  }
}

const realObserver = (globalThis as { ResizeObserver?: unknown }).ResizeObserver
const realMatchMedia = window.matchMedia

afterEach(() => {
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = realObserver
  window.matchMedia = realMatchMedia
})

describe("animateHeightChanges", () => {
  test("a content change animates the box from the height it settled at to the one layout gave it", () => {
    const observer = stubResizeObserver()
    const { box, animations, setHeight } = stubBox()
    const content = document.createElement("div")
    const stop = animateHeightChanges(box, [content])
    expect(observer.observed()).toEqual([box, content])

    observer.fire([box, content])
    expect(animations).toEqual([])

    setHeight(260)
    observer.fire([content])
    expect(animations.map((run) => [run.from, run.to])).toEqual([["100px", "260px"]])
    stop()
  })

  test("a change landing mid-animation starts from the height on screen, and the box's own frames are ignored", () => {
    const observer = stubResizeObserver()
    const { box, animations, setHeight, onScreen } = stubBox()
    const content = document.createElement("div")
    animateHeightChanges(box, [content])

    setHeight(300)
    observer.fire([content])
    // Mid-animation the box reports every frame; none of them is a change of content.
    observer.fire([box])
    expect(animations).toHaveLength(1)
    expect(animations[0].cancelled).toBe(false)

    onScreen(190)
    setHeight(220)
    observer.fire([content, box])
    expect(animations[0].cancelled).toBe(true)
    expect(animations.map((run) => [run.from, run.to])).toEqual([["100px", "300px"], ["190px", "220px"]])
  })

  test("a settled animation lets the next change start from where it ended", () => {
    const observer = stubResizeObserver()
    const { box, animations, setHeight } = stubBox()
    const content = document.createElement("div")
    animateHeightChanges(box, [content])

    setHeight(300)
    observer.fire([content])
    animations[0].finish()
    setHeight(150)
    observer.fire([content])
    expect(animations.map((run) => [run.from, run.to])).toEqual([["100px", "300px"], ["300px", "150px"]])
  })

  test("a resize that is not the content's moves the settled height without animating", () => {
    const observer = stubResizeObserver()
    const { box, animations, setHeight } = stubBox()
    const content = document.createElement("div")
    animateHeightChanges(box, [content])

    setHeight(80)
    observer.fire([box])
    expect(animations).toEqual([])
    setHeight(200)
    observer.fire([content])
    expect(animations.map((run) => [run.from, run.to])).toEqual([["80px", "200px"]])
  })

  test("reduced motion settles without animating", () => {
    const observer = stubResizeObserver()
    window.matchMedia = ((query: string) => ({ matches: query.includes("reduce") })) as typeof window.matchMedia
    const { box, animations, setHeight } = stubBox()
    const content = document.createElement("div")
    animateHeightChanges(box, [content])

    setHeight(400)
    observer.fire([content])
    expect(animations).toEqual([])
  })

  test("stopping disconnects the observer and cancels what is running", () => {
    const observer = stubResizeObserver()
    const { box, animations, setHeight } = stubBox()
    const content = document.createElement("div")
    const stop = animateHeightChanges(box, [content])
    setHeight(400)
    observer.fire([content])
    stop()
    expect(animations[0].cancelled).toBe(true)
    expect(observer.observed()).toEqual([])
  })
})
