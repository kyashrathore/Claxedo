import { QueryClientProvider } from "@tanstack/solid-query"
import { cleanup, render, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, test, vi } from "vitest"

const SERVER_URL = "http://127.0.0.1:39123"

const platform = vi.hoisted(() => ({
  fetch: async () =>
    new Response(JSON.stringify({ healthy: true, version: "1.2.3", localExecution: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
}))

vi.mock("@/platform/runtime/platform-provider", () => ({ usePlatform: () => platform }))

const { ServerConnection, ServerProvider, useServer } = await import("./server")
const { serverHealthQueryKey } = await import("./server-health")
const { queryClient } = await import("@/platform/query/query-client")

afterEach(() => {
  cleanup()
  queryClient.clear()
})

describe("ServerProvider health poll", () => {
  test("stores the whole health document under the key serverHealthQueryOptions observers read", async () => {
    let server: ReturnType<typeof useServer> | undefined
    const Probe = () => {
      server = useServer()
      return null
    }
    render(() => (
      <QueryClientProvider client={queryClient}>
        <ServerProvider defaultServer={ServerConnection.Key.make(SERVER_URL)}>
          <Probe />
        </ServerProvider>
      </QueryClientProvider>
    ))

    await waitFor(() => expect(server?.healthy()).toBe(true))
    expect(queryClient.getQueryData(serverHealthQueryKey({ url: SERVER_URL }))).toMatchObject({
      healthy: true,
      version: "1.2.3",
      localExecution: true,
    })
  })
})
