import { describe, expect, test } from "bun:test"
import { createRemoteAccessClient } from "./remote-access-api"

function scripted(responses: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ path: string; method: string; body?: string }> = []
  return {
    calls,
    request: async (path: string, init?: RequestInit) => {
      calls.push({ path, method: init?.method ?? "GET", ...(typeof init?.body === "string" ? { body: init.body } : {}) })
      const next = responses.shift()
      if (!next) throw new Error("missing scripted response")
      return new Response(JSON.stringify(next.body), {
        status: next.status,
        headers: { "content-type": "application/json" },
      })
    },
  }
}

describe("remote access client", () => {
  test("loads honest capability state, enables one machine, and lists devices", async () => {
    const script = scripted([
      { status: 200, body: { device_login_configured: false, relay_configured: false, hosted_signed_in: false, enabled: false } },
      { status: 200, body: { host_id: "host_1", workspace_ids: ["ws_1", "ws_2"], connection_count: 1 } },
      { status: 200, body: { devices: [{ host_id: "host_1", display_name: "Yash's Mac", last_seen_at: 10, workspace_ids: ["ws_1", "ws_2"] }] } },
    ])
    const events: string[] = []
    const client = createRemoteAccessClient({ request: script.request, emit: (event) => events.push(event.name) })

    await expect(client.status()).resolves.toEqual({
      deviceLoginConfigured: false,
      relayConfigured: false,
      hostedSignedIn: false,
      enabled: false,
      secondDeviceOpen: false,
    })
    await expect(client.enable({ displayName: "Yash's Mac", startAtLogin: true })).resolves.toEqual({
      hostId: "host_1",
      workspaceIds: ["ws_1", "ws_2"],
      connectionCount: 1,
    })
    await expect(client.devices()).resolves.toEqual([{
      hostId: "host_1",
      displayName: "Yash's Mac",
      lastSeenAt: 10,
      workspaceIds: ["ws_1", "ws_2"],
    }])
    expect(script.calls).toEqual([
      { path: "/api/claxedo/remote-access", method: "GET" },
      { path: "/api/claxedo/remote-access/enable", method: "POST", body: JSON.stringify({ display_name: "Yash's Mac", start_at_login: true }) },
      { path: "/api/claxedo/remote-access/devices", method: "GET" },
    ])
    expect(events).toEqual(["remote_access_enabled"])
  })

  test("emits second-device completion only when the server records it", async () => {
    const script = scripted([
      { status: 200, body: { recorded: false } },
      { status: 200, body: { recorded: true } },
    ])
    const events: string[] = []
    const client = createRemoteAccessClient({ request: script.request, emit: (event) => events.push(event.name) })

    await client.markSecondDeviceOpen("ws_1", "desktop", "desktop")
    await client.markSecondDeviceOpen("ws_1", "desktop", "phone")

    expect(events).toEqual(["second_device_open"])
  })

  test("revokes a machine and surfaces blocker errors", async () => {
    const script = scripted([
      { status: 501, body: { error: { code: "remote_access_unavailable", message: "Device sign-in is not configured" } } },
      { status: 200, body: { revoked: true } },
    ])
    const client = createRemoteAccessClient({ request: script.request })
    await expect(client.enable({ displayName: "Mac", startAtLogin: false })).rejects.toThrow("Device sign-in is not configured")
    await expect(client.revoke("host/1")).resolves.toEqual({ revoked: true })
    expect(script.calls[1]).toEqual({
      path: "/api/claxedo/remote-access/devices/host%2F1",
      method: "DELETE",
    })
  })
})
