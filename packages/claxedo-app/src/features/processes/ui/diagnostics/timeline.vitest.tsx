import { afterEach, describe, expect, test, vi } from "vitest"
import { cleanup, render } from "@solidjs/testing-library"
import { DiagnosticsTimeline } from "./timeline"

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("DiagnosticsTimeline Solid 2 ref lifecycle", () => {
  test("disconnects its ResizeObserver when the component unmounts", () => {
    const observe = vi.fn()
    const disconnect = vi.fn()
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe = observe
        disconnect = disconnect
      },
    )

    const view = render(() => <DiagnosticsTimeline points={[]} bounds={{ startAt: 0, endAt: 1 }} />)
    expect(observe).toHaveBeenCalledTimes(1)

    view.unmount()

    expect(disconnect).toHaveBeenCalledTimes(1)
  })
})
