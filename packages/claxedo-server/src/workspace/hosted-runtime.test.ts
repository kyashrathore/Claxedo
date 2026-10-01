import { afterEach, expect, test, vi } from "vitest"
import type { ControlPlaneServices } from "../authority/services"
import { hostedRuntimeFetch } from "./hosted-runtime"

afterEach(() => vi.unstubAllGlobals())

test("the plane's relay token names the routing identity of the sandbox it reaches", async () => {
  const mintRuntimeAccessToken = vi.fn(async () => ({ token: "rat" }))
  const fetched = vi.fn(async (_url: string, _init?: RequestInit) => new Response("{}"))
  vi.stubGlobal("fetch", fetched)
  const services = {
    sandbox: { sandboxManager: { target: async () => ({ status: "ready", hostId: "host_cloud", routingId: "routing_1", homeRegion: "iad", url: "http://sandbox", epoch: 3 }) } },
    relay: { provider: { mintRuntimeAccessToken, getRelayEndpoint: async () => "https://relay.test/" } },
  } as unknown as ControlPlaneServices

  await hostedRuntimeFetch(services, "ws_1", { orgId: "org_1", projectId: "proj_1" }, "/api/wr/agent-plugins/apply", { method: "POST" })

  expect(mintRuntimeAccessToken).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws_1", hostId: "host_cloud", routingId: "routing_1" }))
  expect(fetched.mock.calls[0]?.[0]).toBe("https://relay.test/workspaces/ws_1/api/wr/agent-plugins/apply")
})
