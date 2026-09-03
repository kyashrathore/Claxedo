import { cleanup, render, waitFor } from "@solidjs/testing-library"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { useSharedWorkspaceIds } from "./shared-workspaces"

const bound = vi.hoisted(() => ({ port: undefined as unknown }))

vi.mock("@/platform/remote-access/machine-remote-access", () => ({
  machineRemoteAccess: () => bound.port,
}))

function read() {
  let query!: ReturnType<typeof useSharedWorkspaceIds>
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(() => (
    <QueryClientProvider client={client}>
      {(() => {
        query = useSharedWorkspaceIds()
        return null
      })()}
    </QueryClientProvider>
  ))
  return () => query
}

beforeEach(() => {
  bound.port = undefined
})

afterEach(() => cleanup())

describe("which workspaces this account publishes", () => {
  test("a product that enumerates machines answers account-wide, de-duplicated", async () => {
    // The self-hosted/browser product: several machines may publish, and the
    // same workspace may appear on more than one of them.
    bound.port = {
      status: async () => {
        throw new Error("status must not be the source where a device list exists")
      },
      devices: async () => [
        { hostId: "a", displayName: "A", lastSeenAt: 0, workspaceIds: ["ws_1", "ws_2"] },
        { hostId: "b", displayName: "B", lastSeenAt: 0, workspaceIds: ["ws_2", "ws_3"] },
      ],
    }
    const query = read()

    await waitFor(() => expect(query().ids()).toEqual(["ws_1", "ws_2", "ws_3"]))
    expect(query().shared("ws_3")).toBe(true)
    expect(query().shared("ws_4")).toBe(false)
    // Same read answers "could a share succeed right now" — an account with
    // enrolled machines is publishing.
    expect(query().publishing()).toBe(true)
  })

  test("a product that knows only itself answers from its own connector status", async () => {
    // The desktop: `devices` is absent because enumerating the account's
    // machines is not one of its closed operations, and the connector's
    // snapshot is the complete truth for the one machine there is.
    bound.port = {
      status: async () => ({
        deviceLoginConfigured: true,
        relayConfigured: true,
        hostedSignedIn: true,
        enrolled: true,
        enabled: true,
        secondDeviceOpen: false,
        sharedWorkspaceIds: ["ws_local"],
      }),
    }
    const query = read()

    await waitFor(() => expect(query().ids()).toEqual(["ws_local"]))
    expect(query().publishing()).toBe(true)
  })

  test("a connector that is not up publishes nothing, and says so in the same read", async () => {
    // The reconciler must not post an assignment at an idle machine: it would
    // reject, and the user would read a failure for a feature they never
    // turned on.
    bound.port = {
      status: async () => ({
        deviceLoginConfigured: true,
        relayConfigured: true,
        hostedSignedIn: true,
        enrolled: false,
        enabled: false,
        secondDeviceOpen: false,
        sharedWorkspaceIds: [],
      }),
    }
    const query = read()

    await waitFor(() => expect(query().publishing()).toBe(false))
    expect(query().ids()).toEqual([])
  })

  test("no port at all reads as nothing published, and stays distinguishable from 'not asked yet'", async () => {
    const query = read()

    expect(query().ids()).toBeUndefined()
    expect(query().publishing()).toBeUndefined()
    await waitFor(() => expect(query().ids()).toEqual([]))
    expect(query().publishing()).toBe(false)
  })
})
