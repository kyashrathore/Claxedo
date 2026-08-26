import { cleanup, render } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { SessionHealthPeek } from "./session-health-peek"

const harness = vi.hoisted(() => ({
  probeHealth: vi.fn(),
}))

vi.mock("@/features/session/composer/ui/harness-controller", () => ({
  usePromptHarnessControllersOptional: () => ({
    submit: {},
    selection: {
      read: () => ({ readiness: "ready" }),
      probeHealth: harness.probeHealth,
    },
  }),
}))

let visibility = "visible"

function probesFor(directory: string) {
  return harness.probeHealth.mock.calls.filter((call) => call[1]?.directory === directory)
}

beforeEach(() => {
  vi.useFakeTimers()
  harness.probeHealth.mockReset()
  visibility = "visible"
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  delete (document as Document & { visibilityState?: string }).visibilityState
})

describe("SessionHealthPeek observer ownership", () => {
  test("only the active retained session owns the standing poll", async () => {
    render(() => (
      <>
        <SessionHealthPeek
          active={() => true}
          directory={() => "/active"}
          sessionId={() => "ses_active"}
          intervalMs={1_000}
        />
        <SessionHealthPeek
          active={() => false}
          directory={() => "/retained"}
          sessionId={() => "ses_retained"}
          intervalMs={1_000}
        />
      </>
    ))
    await Promise.resolve()

    expect(probesFor("/active")).toHaveLength(1)
    expect(probesFor("/retained")).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(3_000)

    expect(probesFor("/active")).toHaveLength(4)
    expect(probesFor("/retained")).toHaveLength(0)
  })

  test("only the active session catches up when the document becomes visible", async () => {
    render(() => (
      <>
        <SessionHealthPeek
          active={() => true}
          directory={() => "/active"}
          sessionId={() => "ses_active"}
          intervalMs={1_000}
        />
        <SessionHealthPeek
          active={() => false}
          directory={() => "/retained"}
          sessionId={() => "ses_retained"}
          intervalMs={1_000}
        />
      </>
    ))
    await Promise.resolve()

    visibility = "hidden"
    document.dispatchEvent(new Event("visibilitychange"))
    await vi.advanceTimersByTimeAsync(2_000)
    expect(probesFor("/active")).toHaveLength(1)
    expect(probesFor("/retained")).toHaveLength(0)

    visibility = "visible"
    document.dispatchEvent(new Event("visibilitychange"))

    expect(probesFor("/active")).toHaveLength(2)
    expect(probesFor("/retained")).toHaveLength(0)
  })

  test("activation performs one immediate catch-up and then owns one poll", async () => {
    const [active, setActive] = createSignal(false)
    const [directory, setDirectory] = createSignal("/old")
    const [sessionId, setSessionId] = createSignal("ses_old")
    render(() => (
      <SessionHealthPeek
        active={active}
        directory={directory}
        sessionId={sessionId}
        intervalMs={1_000}
      />
    ))
    await Promise.resolve()

    setDirectory("/current")
    setSessionId("ses_current")
    await Promise.resolve()
    expect(harness.probeHealth).not.toHaveBeenCalled()

    setActive(true)
    await Promise.resolve()
    expect(harness.probeHealth).toHaveBeenCalledTimes(1)
    expect(harness.probeHealth).toHaveBeenLastCalledWith("session:ses_current", {
      directory: "/current",
      sessionId: "ses_current",
    })

    await vi.advanceTimersByTimeAsync(1_000)
    expect(harness.probeHealth).toHaveBeenCalledTimes(2)

    setActive(false)
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(3_000)
    expect(harness.probeHealth).toHaveBeenCalledTimes(2)

    setActive(true)
    await Promise.resolve()
    expect(harness.probeHealth).toHaveBeenCalledTimes(3)
  })
})
