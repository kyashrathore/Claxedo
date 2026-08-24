import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test"
import { setupResizeHandlers } from "./resize-handlers"
import type { TerminalRendererRef } from "./renderer"
import type { Terminal as XTerm } from "@xterm/xterm"
import type { FitAddon } from "@xterm/addon-fit"

// ---------------------------------------------------------------------------
// Controllable environment
//
// setupResizeHandlers wires ResizeObserver, window/document listeners, RAF and
// setTimeout directly, so these specs replace those globals with fakes we can
// drive deterministically: capture the ResizeObserver callback, queue (never
// auto-run) timers/frames, and fire them by hand.
// ---------------------------------------------------------------------------

type Timer = { id: number; fn: () => void; ms: number }

let observerCallback: ResizeObserverCallback | null = null
let observeSpy: ReturnType<typeof vi.fn>
let disconnectSpy: ReturnType<typeof vi.fn>
let timers: Timer[] = []
let nextTimerId = 1

const realResizeObserver = globalThis.ResizeObserver
const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout
const realRaf = globalThis.requestAnimationFrame
const realCancelRaf = globalThis.cancelAnimationFrame

function installFakes() {
  observerCallback = null
  timers = []
  nextTimerId = 1
  observeSpy = vi.fn()
  disconnectSpy = vi.fn()

  class FakeResizeObserver {
    constructor(cb: ResizeObserverCallback) {
      observerCallback = cb
    }
    observe = observeSpy
    disconnect = disconnectSpy
    unobserve = vi.fn()
  }

  const fakeSetTimeout = ((fn: () => void, ms?: number) => {
    const id = nextTimerId++
    timers.push({ id, fn, ms: ms ?? 0 })
    return id
  }) as typeof setTimeout
  const fakeClearTimeout = ((id: unknown) => {
    timers = timers.filter((t) => t.id !== id)
  }) as typeof clearTimeout
  // RAF is recorded but never auto-fired, so nothing escapes the synchronous test.
  const fakeRaf = ((_fn: FrameRequestCallback) => nextTimerId++) as typeof requestAnimationFrame
  const fakeCancelRaf = (() => {}) as typeof cancelAnimationFrame

  // Swap in the capturing fake observer so tests can drive the resize callback by hand.
  globalThis.ResizeObserver = FakeResizeObserver as typeof ResizeObserver
  globalThis.setTimeout = fakeSetTimeout
  globalThis.clearTimeout = fakeClearTimeout
  globalThis.requestAnimationFrame = fakeRaf
  globalThis.cancelAnimationFrame = fakeCancelRaf
  window.setTimeout = fakeSetTimeout
  window.clearTimeout = fakeClearTimeout
  window.requestAnimationFrame = fakeRaf
  window.cancelAnimationFrame = fakeCancelRaf
}

function restoreFakes() {
  globalThis.ResizeObserver = realResizeObserver
  globalThis.setTimeout = realSetTimeout
  globalThis.clearTimeout = realClearTimeout
  globalThis.requestAnimationFrame = realRaf
  globalThis.cancelAnimationFrame = realCancelRaf
  window.setTimeout = realSetTimeout
  window.clearTimeout = realClearTimeout
  window.requestAnimationFrame = realRaf
  window.cancelAnimationFrame = realCancelRaf
}

/** Fire (in FIFO order) every queued timer whose delay matches `ms`, allowing reschedules. */
function drainTimers(ms: number, cap = 50): number {
  let fired = 0
  while (fired < cap) {
    const idx = timers.findIndex((t) => t.ms === ms)
    if (idx === -1) break
    const [timer] = timers.splice(idx, 1)
    timer.fn()
    fired++
  }
  return fired
}

function fireResize(width: number, height: number) {
  observerCallback?.([{ contentRect: { width, height } } as ResizeObserverEntry], {} as ResizeObserver)
}

function makeContainer(clientWidth = 100, clientHeight = 40) {
  const el = document.createElement("div")
  document.body.appendChild(el)
  Object.defineProperty(el, "clientWidth", { value: clientWidth, configurable: true })
  Object.defineProperty(el, "clientHeight", { value: clientHeight, configurable: true })
  Object.defineProperty(el, "isConnected", { value: true, configurable: true })
  return el
}

type FakeXterm = XTerm & { refresh: ReturnType<typeof vi.fn>; options: { fontSize: number } }

function makeXterm(rendererReady: boolean, cols = 80, rows = 24): FakeXterm {
  return {
    cols,
    rows,
    options: { fontSize: 14 },
    refresh: vi.fn(),
    write: vi.fn(),
    buffer: { active: { type: "normal" } },
    _core: { _renderService: { _renderer: { value: rendererReady ? {} : undefined } } },
    // as-any: structural xterm stand-in exposing only the fields setupResizeHandlers reads.
  } as unknown as FakeXterm
}

type FakeFitAddon = FitAddon & { fit: ReturnType<typeof vi.fn>; proposeDimensions: ReturnType<typeof vi.fn> }

function makeFitAddon(proposeDimensions: () => { cols: number; rows: number } | undefined): FakeFitAddon {
  return {
    fit: vi.fn(),
    proposeDimensions: vi.fn(proposeDimensions),
    // as-any: structural FitAddon stand-in — only fit() and proposeDimensions() are exercised.
  } as unknown as FakeFitAddon
}

function makeRenderer(): TerminalRendererRef & { current: { clearTextureAtlas: ReturnType<typeof vi.fn> } } {
  return {
    current: { kind: "webgl", dispose: () => {}, clearTextureAtlas: vi.fn() },
  } as TerminalRendererRef & { current: { clearTextureAtlas: ReturnType<typeof vi.fn> } }
}

beforeEach(installFakes)
afterEach(() => {
  restoreFakes()
  document.body.innerHTML = ""
})

// ---------------------------------------------------------------------------
// ResizeObserver wiring + fontSize nudge
// ---------------------------------------------------------------------------

describe("setupResizeHandlers — ResizeObserver + fontSize nudge", () => {
  test("observes the container", () => {
    const container = makeContainer()
    const xterm = makeXterm(true)
    const fit = makeFitAddon(() => ({ cols: 80, rows: 24 }))
    const handlers = setupResizeHandlers(container, xterm, fit, vi.fn(), makeRenderer())
    expect(observeSpy).toHaveBeenCalledTimes(1)
    expect(observeSpy).toHaveBeenCalledWith(container)
    handlers.cleanup()
  })

  test("nudges + fits on the 0→visible transition, skips a stable resize, nudges again on a >20% width change", () => {
    const container = makeContainer()
    const xterm = makeXterm(true)
    const fit = makeFitAddon(() => ({ cols: 80, rows: 24 }))
    const renderer = makeRenderer()
    const fitSpy = fit.fit
    const clearSpy = renderer.current.clearTextureAtlas
    const handlers = setupResizeHandlers(container, xterm, fit, vi.fn(), renderer)

    // 0 → visible: nudge fires an immediate fit + atlas clear + refresh.
    fitSpy.mockClear()
    clearSpy.mockClear()
    fireResize(100, 40)
    expect(fitSpy).toHaveBeenCalledTimes(1)
    expect(clearSpy).toHaveBeenCalledTimes(1)
    expect(xterm.refresh).toHaveBeenCalled()

    // Same width: no nudge, so no synchronous fit (coordinator settle is deferred).
    fitSpy.mockClear()
    fireResize(100, 40)
    expect(fitSpy).not.toHaveBeenCalled()

    // >20% width change (100 → 130 = 30%): nudge fires again.
    fitSpy.mockClear()
    fireResize(130, 40)
    expect(fitSpy).toHaveBeenCalledTimes(1)

    // A small (<20%) change does not nudge (130 → 140 ≈ 7.7%).
    fitSpy.mockClear()
    fireResize(140, 40)
    expect(fitSpy).not.toHaveBeenCalled()

    handlers.cleanup()
  })

  test("does not fit synchronously while the renderer is not ready (guards xterm internals)", () => {
    const container = makeContainer()
    const xterm = makeXterm(false) // _renderer.value undefined
    const fit = makeFitAddon(() => ({ cols: 80, rows: 24 }))
    const fitSpy = fit.fit
    const handlers = setupResizeHandlers(container, xterm, fit, vi.fn(), makeRenderer())

    fitSpy.mockClear()
    fireResize(100, 40) // 0 → visible would nudge, but renderer-not-ready gates the fit
    expect(fitSpy).not.toHaveBeenCalled()
    handlers.cleanup()
  })
})

// ---------------------------------------------------------------------------
// retry-fit exhaustion
// ---------------------------------------------------------------------------

describe("setupResizeHandlers — retry-fit safety net", () => {
  test("retries the mount fit on persistent mismatch, then gives up after 10 attempts", () => {
    const container = makeContainer(100, 40)
    const xterm = makeXterm(true, 80, 24)
    // proposeDimensions always disagrees with the terminal's current size → mismatch.
    const fit = makeFitAddon(() => ({ cols: 999, rows: 24 }))
    const proposeSpy = fit.proposeDimensions
    const handlers = setupResizeHandlers(container, xterm, fit, vi.fn(), makeRenderer())

    // Drive only the 200ms retry timers. retryFit reschedules while it sees a
    // mismatch, incrementing retryCount each call and bailing at >=10.
    const fired = drainTimers(200)

    // 10 invocations total; the 10th bails before proposing/​rescheduling, so
    // proposeDimensions ran 9 times and no further retry timer is queued.
    expect(fired).toBe(10)
    expect(proposeSpy).toHaveBeenCalledTimes(9)
    expect(timers.some((t) => t.ms === 200)).toBe(false)
    handlers.cleanup()
  })

  test("stops retrying immediately once the proposed size matches", () => {
    const container = makeContainer(100, 40)
    const xterm = makeXterm(true, 80, 24)
    // Proposed dims already match the terminal → no mismatch, no reschedule.
    const fit = makeFitAddon(() => ({ cols: 80, rows: 24 }))
    const handlers = setupResizeHandlers(container, xterm, fit, vi.fn(), makeRenderer())

    const fired = drainTimers(200)
    expect(fired).toBe(1) // single retry ran, found a match, did not reschedule
    expect(timers.some((t) => t.ms === 200)).toBe(false)
    handlers.cleanup()
  })
})

// ---------------------------------------------------------------------------
// cleanup
// ---------------------------------------------------------------------------

describe("setupResizeHandlers — cleanup", () => {
  test("disconnects the observer and cancels pending mount/retry timers", () => {
    const container = makeContainer()
    const xterm = makeXterm(true)
    const fit = makeFitAddon(() => ({ cols: 80, rows: 24 }))
    const handlers = setupResizeHandlers(container, xterm, fit, vi.fn(), makeRenderer())

    handlers.cleanup()
    expect(disconnectSpy).toHaveBeenCalledTimes(1)
    // The mount (50/250ms) and retry (200ms) timers are cleared on cleanup.
    expect(timers.some((t) => t.ms === 50 || t.ms === 250 || t.ms === 200)).toBe(false)
  })
})
