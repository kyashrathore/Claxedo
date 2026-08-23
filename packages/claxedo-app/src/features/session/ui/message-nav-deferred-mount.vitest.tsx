import { cleanup, render } from "@solidjs/testing-library"
import { Show, Suspense, createSignal } from "solid-js"
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
  markRendererPhase.mockClear()
})

describe("createMessageNavDeferredMount", () => {
  test("keeps the timeline mounted while optional nav work waits for idle", async () => {
    let runIdle: IdleRequestCallback | undefined
    vi.stubGlobal("requestIdleCallback", vi.fn((callback: IdleRequestCallback) => {
      runIdle = callback
      return 1
    }))
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
        <Suspense fallback={<div data-testid="pane-fallback" />}>
          <Harness />
        </Suspense>
      </SessionParamsProvider>
    ))

    await Promise.resolve()
    expect(view.queryByTestId("pane-fallback")).toBeNull()
    expect(view.queryByTestId("real-timeline")).not.toBeNull()
    expect(view.queryByTestId("message-nav")).toBeNull()

    runIdle?.({ didTimeout: false, timeRemaining: () => 10 } as IdleDeadline)
    await Promise.resolve()
    await Promise.resolve()

    expect(view.queryByTestId("pane-fallback")).toBeNull()
    expect(view.queryByTestId("real-timeline")).not.toBeNull()
    expect(view.queryByTestId("message-nav")).not.toBeNull()
    expect(markRendererPhase).toHaveBeenCalledTimes(1)
    expect(markRendererPhase).toHaveBeenCalledWith("timeline.messageNav.idleMount")
  })
})
