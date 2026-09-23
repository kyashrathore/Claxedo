import { cleanup, render } from "@solidjs/testing-library"
import { Show, createSignal } from "solid-js"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { DelayedLoading, LOADING_INDICATOR_DELAY_MS, LoadingEpisodesProvider } from "@/ui/controls/delayed-loading"

describe("DelayedLoading", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date", "queueMicrotask"] })
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  test("paints nothing until the load outlasts the delay", () => {
    const view = render(() => (
      <div data-testid="marker">
        <DelayedLoading>
          <span data-testid="spinner" />
        </DelayedLoading>
      </div>
    ))

    expect(view.getByTestId("marker")).toBeTruthy()
    vi.advanceTimersByTime(LOADING_INDICATOR_DELAY_MS - 1)
    expect(view.queryByTestId("spinner")).toBeNull()
    vi.advanceTimersByTime(1)
    expect(view.getByTestId("spinner")).toBeTruthy()
  })

  test("a load that finishes inside the delay never paints", () => {
    const [loading, setLoading] = createSignal(true)
    const view = render(() => (
      <Show when={loading()}>
        <DelayedLoading>
          <span data-testid="spinner" />
        </DelayedLoading>
      </Show>
    ))

    vi.advanceTimersByTime(LOADING_INDICATOR_DELAY_MS / 2)
    setLoading(false)
    vi.advanceTimersByTime(LOADING_INDICATOR_DELAY_MS * 2)
    expect(view.queryByTestId("spinner")).toBeNull()
  })

  test("a swapped fallback in the same episode keeps showing instead of restarting the delay", async () => {
    const [stage, setStage] = createSignal<"first" | "second">("first")
    const view = render(() => (
      <LoadingEpisodesProvider>
        <Show
          when={stage() === "second"}
          fallback={
            <DelayedLoading episode="session-transcript:a">
              <span data-testid="first" />
            </DelayedLoading>
          }
        >
          <DelayedLoading episode="session-transcript:a">
            <span data-testid="second" />
          </DelayedLoading>
        </Show>
      </LoadingEpisodesProvider>
    ))

    vi.advanceTimersByTime(LOADING_INDICATOR_DELAY_MS)
    expect(view.getByTestId("first")).toBeTruthy()
    setStage("second")
    expect(view.getByTestId("second")).toBeTruthy()
    await vi.runAllTimersAsync()
    expect(view.getByTestId("second")).toBeTruthy()
  })

  test("a new wait after the episode ended starts a fresh delay", async () => {
    const [loading, setLoading] = createSignal(true)
    const view = render(() => (
      <LoadingEpisodesProvider>
        <Show when={loading()}>
          <DelayedLoading episode="session-transcript:b">
            <span data-testid="spinner" />
          </DelayedLoading>
        </Show>
      </LoadingEpisodesProvider>
    ))

    vi.advanceTimersByTime(LOADING_INDICATOR_DELAY_MS)
    expect(view.getByTestId("spinner")).toBeTruthy()
    setLoading(false)
    await Promise.resolve()
    vi.advanceTimersByTime(LOADING_INDICATOR_DELAY_MS * 3)

    setLoading(true)
    expect(view.queryByTestId("spinner")).toBeNull()
    vi.advanceTimersByTime(LOADING_INDICATOR_DELAY_MS)
    expect(view.getByTestId("spinner")).toBeTruthy()
  })

  test("waits in different episodes do not share a start", () => {
    const [second, setSecond] = createSignal(false)
    const view = render(() => (
      <LoadingEpisodesProvider>
        <>
          <DelayedLoading episode="session-transcript:c">
            <span data-testid="c" />
          </DelayedLoading>
          <Show when={second()}>
            <DelayedLoading episode="session-transcript:d">
              <span data-testid="d" />
            </DelayedLoading>
          </Show>
        </>
      </LoadingEpisodesProvider>
    ))

    vi.advanceTimersByTime(LOADING_INDICATOR_DELAY_MS)
    setSecond(true)
    expect(view.getByTestId("c")).toBeTruthy()
    expect(view.queryByTestId("d")).toBeNull()
    vi.advanceTimersByTime(LOADING_INDICATOR_DELAY_MS)
    expect(view.getByTestId("d")).toBeTruthy()
  })
})
