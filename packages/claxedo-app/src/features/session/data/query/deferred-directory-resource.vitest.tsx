import { cleanup, render } from "@solidjs/testing-library"
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/solid-query"
import { createSignal } from "solid-js"
import { afterEach, describe, expect, test, vi } from "vitest"
import {
  createDeferredDirectoryResourceGate,
  DIRECTORY_RESOURCE_FIRST_PAINT_DELAY_MS,
} from "./deferred-directory-resource"

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("deferred directory resource hydration", () => {
  test("keeps stale cached projection readable while deduplicating refresh after the first-paint boundary", async () => {
    vi.useFakeTimers()
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
      callback(0)
      return 1
    }))
    vi.stubGlobal("cancelAnimationFrame", vi.fn())
    vi.stubGlobal("requestIdleCallback", vi.fn((callback: IdleRequestCallback) => {
      callback({ didTimeout: false, timeRemaining: () => 10 })
      return 2
    }))
    vi.stubGlobal("cancelIdleCallback", vi.fn())

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const key = ["directory", "agents", "/repo"] as const
    client.setQueryData(key, ["cached"])
    let requests = 0
    let resolveRequest!: (value: string[]) => void

    const Probe = (props: { id: string }) => {
      const enabled = createDeferredDirectoryResourceGate({ scope: () => "/repo:agents" })
      const query = useQuery(() => ({
        queryKey: key,
        enabled: enabled(),
        staleTime: 0,
        queryFn: async () => {
          requests++
          return await new Promise<string[]>((resolve) => {
            resolveRequest = resolve
          })
        },
      }))
      return <div data-testid={props.id}>{query.data?.[0]}</div>
    }

    const view = render(() => (
      <QueryClientProvider client={client}>
        <Probe id="selection" />
        <Probe id="composer" />
        <Probe id="timeline" />
      </QueryClientProvider>
    ))

    expect(view.getByTestId("selection")).toHaveTextContent("cached")
    expect(view.getByTestId("composer")).toHaveTextContent("cached")
    expect(view.getByTestId("timeline")).toHaveTextContent("cached")

    await vi.advanceTimersByTimeAsync(50)
    expect(requests).toBe(0)

    await vi.advanceTimersByTimeAsync(DIRECTORY_RESOURCE_FIRST_PAINT_DELAY_MS - 50)
    await vi.advanceTimersByTimeAsync(0)
    await Promise.resolve()
    expect(requests).toBe(1)
    resolveRequest(["hydrated"])
    await vi.advanceTimersByTimeAsync(0)
    await Promise.resolve()
    expect(view.getByTestId("selection")).toHaveTextContent("hydrated")
    expect(view.getByTestId("composer")).toHaveTextContent("hydrated")
    expect(view.getByTestId("timeline")).toHaveTextContent("hydrated")
  })

  test("cancels every pending refresh stage when the pane deactivates", async () => {
    vi.useFakeTimers()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const [active, setActive] = createSignal(true)
    let requests = 0

    const Probe = () => {
      const enabled = createDeferredDirectoryResourceGate({ scope: () => "/repo:commands", active })
      useQuery(() => ({
        queryKey: ["directory", "commands", "/repo"],
        enabled: enabled(),
        queryFn: async () => {
          requests++
          return []
        },
      }))
      return null
    }

    render(() => <QueryClientProvider client={client}><Probe /></QueryClientProvider>)
    await vi.advanceTimersByTimeAsync(50)
    setActive(false)
    await vi.advanceTimersByTimeAsync(1_000)

    expect(requests).toBe(0)
  })
})
