import { cleanup, render } from "@solidjs/testing-library"
import { Show, Loading, createSignal, flush } from "solid-js"
import { afterEach, describe, expect, test, vi } from "vitest"
import { SessionParamsProvider } from "@/features/session/providers/session-params"
import { createMessageNavDeferredMount } from "./message-nav-deferred-mount"

const { markRendererPhase } = vi.hoisted(() => ({
  markRendererPhase: vi.fn(),
}))

vi.mock("@/platform/performance/renderer-trace", () => ({
  markRendererPhase,
}))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  markRendererPhase.mockClear()
})

const idleDeadline = { didTimeout: false, timeRemaining: () => 10 } as IdleDeadline
// Solid 2 settles an async signal through its own promise chain and then
// STAGES the resulting write for the next auto-flush, so the fixed pair of
// microtask turns Solid 1's resource needed no longer reaches the DOM. Drain
// the microtask queue, then flush explicitly. This only moves the observation
// point later, so every negative assertion below ("still not mounted", "never
// marked") gets strictly more time to be violated.
const flushResource = async () => {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
  flush()
}

describe("createMessageNavDeferredMount", () => {
  test("keeps the timeline mounted while optional nav work waits for idle", async () => {
    let runIdle: IdleRequestCallback | undefined
    vi.stubGlobal(
      "requestIdleCallback",
      vi.fn((callback: IdleRequestCallback) => {
        runIdle = callback
        return 1
      }),
    )
    vi.stubGlobal("cancelIdleCallback", vi.fn())

    const [revealed] = createSignal(true)
    const [visible] = createSignal(true)
    const Harness = () => {
      const ready = createMessageNavDeferredMount(revealed, visible)
      return (
        <>
          <div data-testid="real-timeline" />
          <Show when={ready()}>
            <div data-testid="message-nav" />
          </Show>
        </>
      )
    }

    const view = render(() => (
      <SessionParamsProvider
        sessionId={() => "ses_1"}
        directory={() => "/workspace"}
        paneId={() => "pane_1"}
        active={() => true}
      >
        <Loading fallback={<div data-testid="pane-fallback" />}>
          <Harness />
        </Loading>
      </SessionParamsProvider>
    ))

    await Promise.resolve()
    expect(view.queryByTestId("pane-fallback")).toBeNull()
    expect(view.queryByTestId("real-timeline")).not.toBeNull()
    expect(view.queryByTestId("message-nav")).toBeNull()

    runIdle?.(idleDeadline)
    await flushResource()

    expect(view.queryByTestId("pane-fallback")).toBeNull()
    expect(view.queryByTestId("real-timeline")).not.toBeNull()
    expect(view.queryByTestId("message-nav")).not.toBeNull()
    expect(markRendererPhase).toHaveBeenCalledTimes(1)
    expect(markRendererPhase).toHaveBeenCalledWith("timeline.messageNav.idleMount")
  })

  test("cancels stale idle work and mounts once after the session reactivates", async () => {
    let nextIdle = 0
    const idleTasks = new Map<number, IdleRequestCallback>()
    const requestIdle = vi.fn((callback: IdleRequestCallback) => {
      const handle = ++nextIdle
      idleTasks.set(handle, callback)
      return handle
    })
    const cancelIdle = vi.fn((handle: number) => idleTasks.delete(handle))
    vi.stubGlobal("requestIdleCallback", requestIdle)
    vi.stubGlobal("cancelIdleCallback", cancelIdle)

    const [active, setActive] = createSignal(true)
    const Harness = () => {
      const ready = createMessageNavDeferredMount(
        () => true,
        () => true,
      )
      return (
        <>
          <div data-testid="real-timeline" />
          <Show when={ready()}>
            <div data-testid="message-nav" />
          </Show>
        </>
      )
    }

    const view = render(() => (
      <SessionParamsProvider
        sessionId={() => "ses_1"}
        directory={() => "/workspace"}
        paneId={() => "pane_1"}
        active={active}
      >
        <Loading fallback={<div data-testid="pane-fallback" />}>
          <Harness />
        </Loading>
      </SessionParamsProvider>
    ))

    await flushResource()
    expect(requestIdle).toHaveBeenCalledTimes(1)
    const staleIdle = idleTasks.get(1)
    expect(staleIdle).toBeDefined()

    setActive(false)
    await flushResource()
    expect(cancelIdle).toHaveBeenCalledWith(1)

    // A queued callback may already have crossed the browser boundary when it
    // is cancelled. The settled wait must make that stale delivery harmless.
    staleIdle?.(idleDeadline)
    await flushResource()
    expect(view.queryByTestId("pane-fallback")).toBeNull()
    expect(view.queryByTestId("real-timeline")).not.toBeNull()
    expect(view.queryByTestId("message-nav")).toBeNull()
    expect(markRendererPhase).not.toHaveBeenCalled()

    setActive(true)
    await flushResource()
    expect(requestIdle).toHaveBeenCalledTimes(2)
    idleTasks.get(2)?.(idleDeadline)
    await flushResource()

    expect(view.queryByTestId("message-nav")).not.toBeNull()
    expect(markRendererPhase).toHaveBeenCalledTimes(1)

    setActive(false)
    setActive(true)
    await flushResource()
    expect(requestIdle).toHaveBeenCalledTimes(2)
    expect(markRendererPhase).toHaveBeenCalledTimes(1)
  })
})
