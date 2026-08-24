import { describe, expect, test } from "bun:test"
import { httpMachineRemoteAccess } from "./http-machine-remote-access"

/**
 * The self-hosted Node product's half of the port.
 *
 * `deployments/self-hosted-node/app.ts` still mounts `RemoteAccessRoutes` at
 * `/api/claxedo/remote-access`, so this implementation must keep reaching those
 * exact paths and verbs. Moved here with the module from
 * `features/onboarding/remote-access-api.test.ts`; the funnel assertions went
 * with the events, to the controller that now owns them.
 */
function scripted(responses: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ path: string; method: string; body?: string }> = []
  return {
    calls,
    request: async (path: string, init?: RequestInit) => {
      calls.push({
        path,
        method: init?.method ?? "GET",
        ...(typeof init?.body === "string" ? { body: init.body } : {}),
      })
      const next = responses.shift()
      if (!next) throw new Error("missing scripted response")
      return new Response(JSON.stringify(next.body), {
        status: next.status,
        headers: { "content-type": "application/json" },
      })
    },
  }
}

describe("http machine remote access", () => {
  test("loads honest capability state, enables one machine, and lists devices", async () => {
    const script = scripted([
      {
        status: 200,
        body: { device_login_configured: false, relay_configured: false, hosted_signed_in: false, enabled: false },
      },
      { status: 200, body: { host_id: "host_1", workspace_ids: ["ws_1", "ws_2"], connection_count: 1 } },
      {
        status: 200,
        body: {
          devices: [
            { host_id: "host_1", display_name: "Yash's Mac", last_seen_at: 10, workspace_ids: ["ws_1", "ws_2"] },
          ],
        },
      },
    ])
    const port = httpMachineRemoteAccess({ request: script.request })

    await expect(port.status()).resolves.toEqual({
      deviceLoginConfigured: false,
      relayConfigured: false,
      hostedSignedIn: false,
      enrolled: false,
      enabled: false,
      secondDeviceOpen: false,
    })
    await port.enable({ displayName: "Yash's Mac", startAtLogin: true })
    await expect(port.devices?.()).resolves.toEqual([
      {
        hostId: "host_1",
        displayName: "Yash's Mac",
        lastSeenAt: 10,
        workspaceIds: ["ws_1", "ws_2"],
      },
    ])
    // The regression's other side: a self-hosted server DOES serve these, so
    // the same Enable button must still produce exactly this request.
    expect(script.calls).toEqual([
      { path: "/api/claxedo/remote-access", method: "GET" },
      {
        path: "/api/claxedo/remote-access/enable",
        method: "POST",
        body: JSON.stringify({ display_name: "Yash's Mac", start_at_login: true }),
      },
      { path: "/api/claxedo/remote-access/devices", method: "GET" },
    ])
  })

  test("records second-device completion, reporting what the server decided", async () => {
    const script = scripted([
      { status: 200, body: { recorded: false } },
      { status: 200, body: { recorded: true } },
    ])
    const port = httpMachineRemoteAccess({ request: script.request })

    await expect(
      port.markSecondDeviceOpen?.({ workspaceId: "ws_1", sourceClientId: "desktop", currentClientId: "desktop" }),
    ).resolves.toEqual({ recorded: false })
    await expect(
      port.markSecondDeviceOpen?.({ workspaceId: "ws_1", sourceClientId: "desktop", currentClientId: "phone" }),
    ).resolves.toEqual({ recorded: true })
    expect(script.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /api/claxedo/remote-access/workspaces/ws_1/second-device-open",
      "POST /api/claxedo/remote-access/workspaces/ws_1/second-device-open",
    ])
  })

  test("revokes a machine and surfaces blocker errors", async () => {
    const script = scripted([
      {
        status: 501,
        body: { error: { code: "remote_access_unavailable", message: "Device sign-in is not configured" } },
      },
      { status: 200, body: { revoked: true } },
    ])
    const port = httpMachineRemoteAccess({ request: script.request })

    await expect(port.enable({ displayName: "Mac", startAtLogin: false })).rejects.toThrow(
      "Device sign-in is not configured",
    )
    await expect(port.revoke("host/1")).resolves.toEqual({ revoked: true })
    expect(script.calls[1]).toEqual({
      path: "/api/claxedo/remote-access/devices/host%2F1",
      method: "DELETE",
    })
  })

  test("rejects a 200 that enrolled nothing", async () => {
    // `enable` returns nothing, so the only way it can report failure is by
    // rejecting. A server answering 200 with an empty body must not read as a
    // published machine.
    const script = scripted([{ status: 200, body: {} }])
    const port = httpMachineRemoteAccess({ request: script.request })

    await expect(port.enable({ displayName: "Mac", startAtLogin: false })).rejects.toThrow("host_id")
  })

  test("offers the two capabilities the HTTP product has, and no pause", async () => {
    // Shape, not behaviour: `pause` exists only where a connector can stop its
    // own heartbeat. There is no pause route, and binding a stub would make
    // "this product cannot pause" look like "pausing did nothing".
    const port = httpMachineRemoteAccess({ request: async () => new Response("{}") })

    expect(typeof port.devices).toBe("function")
    expect(typeof port.markSecondDeviceOpen).toBe("function")
    expect(port.pause).toBeUndefined()
    expect(port.subscribe).toBeUndefined()
  })
})
