import { cleanup, render } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { afterEach, describe, expect, test, vi } from "vitest"
import { DeferredSessionSecondaryStatus } from "./session-secondary-status"

const calls = vi.hoisted(() => ({
  health: vi.fn(),
  connection: vi.fn(),
}))

vi.mock("./session-health-peek", () => ({
  SessionHealthPeek: () => {
    calls.health()
    return <div data-testid="health" />
  },
}))

vi.mock("./session-connection-line", () => ({
  SessionConnectionLine: () => {
    calls.connection()
    return <div data-testid="connection" />
  },
}))

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  calls.health.mockReset()
  calls.connection.mockReset()
})

describe("DeferredSessionSecondaryStatus", () => {
  test("mounts advisory observers only after active first-fold settlement", async () => {
    vi.useFakeTimers()
    const [active, setActive] = createSignal(true)
    const [firstFoldReady, setFirstFoldReady] = createSignal(false)
    render(() => (
      <DeferredSessionSecondaryStatus
        active={active}
        firstFoldReady={firstFoldReady}
        directory={() => "/work/repo"}
        sessionId={() => "ses_1"}
        workspaceId={() => "ws_1"}
        delayMs={25}
      />
    ))

    await vi.advanceTimersByTimeAsync(100)
    expect(calls.health).not.toHaveBeenCalled()
    expect(calls.connection).not.toHaveBeenCalled()

    setFirstFoldReady(true)
    setActive(false)
    await vi.advanceTimersByTimeAsync(100)
    expect(calls.health).not.toHaveBeenCalled()

    setActive(true)
    await vi.advanceTimersByTimeAsync(24)
    expect(calls.health).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)

    expect(calls.health).toHaveBeenCalledOnce()
    expect(calls.connection).toHaveBeenCalledOnce()
  })
})
