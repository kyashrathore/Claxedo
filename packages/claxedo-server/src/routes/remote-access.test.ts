import { describe, expect, test, vi } from "vitest"
import { RemoteAccessRoutes } from "./remote-access"

const auth = { user: { subject: "user_1" } } as never

describe("remote access routes", () => {
  test("reports Phase A and relay blockers and fails closed before enrollment", async () => {
    const authenticate = vi.fn(async () => auth)
    const enable = vi.fn()
    const app = RemoteAccessRoutes({
      deviceLoginConfigured: false,
      relayConfigured: false,
      authenticate,
      service: {
        status: vi.fn(async () => ({ enrolled: false, enabled: false, secondDeviceOpen: false })),
        enable,
        devices: vi.fn(async () => []),
        revoke: vi.fn(async () => ({ revoked: false })),
        markSecondDeviceOpen: vi.fn(async () => ({ recorded: false })),
      },
    })

    const status = await app.request("http://localhost/")
    expect(status.status).toBe(200)
    await expect(status.json()).resolves.toEqual({
      device_login_configured: false,
      relay_configured: false,
      hosted_signed_in: false,
      enrolled: false,
      enabled: false,
      second_device_open: false,
    })

    const response = await app.request("http://localhost/enable", { method: "POST", body: "{}" })
    expect(response.status).toBe(501)
    await expect(response.json()).resolves.toMatchObject({ error: { code: "remote_access_unavailable" } })
    expect(authenticate).not.toHaveBeenCalled()
    expect(enable).not.toHaveBeenCalled()
  })

  test("enables, lists, and revokes enrolled machines through signed auth", async () => {
    const service = {
      status: vi.fn(async () => ({ enrolled: true, enabled: true, secondDeviceOpen: false })),
      enable: vi.fn(async () => ({ hostId: "host_1", workspaceIds: ["ws_1", "ws_2"], connectionCount: 1 })),
      devices: vi.fn(async () => [{ hostId: "host_1", displayName: "Mac", lastSeenAt: 10, workspaceIds: ["ws_1", "ws_2"] }]),
      revoke: vi.fn(async () => ({ revoked: true })),
      markSecondDeviceOpen: vi.fn(async () => ({ recorded: true })),
    }
    const app = RemoteAccessRoutes({
      deviceLoginConfigured: true,
      relayConfigured: true,
      authenticate: vi.fn(async () => auth),
      service,
    })

    const enabled = await app.request("http://localhost/enable", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ display_name: "Mac", start_at_login: true }),
    })
    await expect(enabled.json()).resolves.toEqual({ host_id: "host_1", workspace_ids: ["ws_1", "ws_2"], connection_count: 1 })
    expect(service.enable).toHaveBeenCalledWith(auth, { displayName: "Mac", startAtLogin: true })

    await expect((await app.request("http://localhost/devices")).json()).resolves.toEqual({
      devices: [{ host_id: "host_1", display_name: "Mac", last_seen_at: 10, workspace_ids: ["ws_1", "ws_2"] }],
    })
    await expect((await app.request("http://localhost/devices/host_1", { method: "DELETE" })).json())
      .resolves.toEqual({ revoked: true })
    expect(service.revoke).toHaveBeenCalledWith(auth, "host_1")
  })

  test("records completion only for a different client id", async () => {
    const markSecondDeviceOpen = vi.fn(async () => ({ recorded: true }))
    const app = RemoteAccessRoutes({
      deviceLoginConfigured: true,
      relayConfigured: true,
      authenticate: vi.fn(async () => auth),
      service: {
        status: vi.fn(async () => ({ enrolled: true, enabled: true, secondDeviceOpen: false })),
        enable: vi.fn(),
        devices: vi.fn(async () => []),
        revoke: vi.fn(),
        markSecondDeviceOpen,
      },
    })

    const same = await app.request("http://localhost/workspaces/ws_1/second-device-open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source_client_id: "desktop", current_client_id: "desktop" }),
    })
    expect(same.status).toBe(400)
    expect(markSecondDeviceOpen).not.toHaveBeenCalled()

    const phone = await app.request("http://localhost/workspaces/ws_1/second-device-open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source_client_id: "desktop", current_client_id: "phone" }),
    })
    await expect(phone.json()).resolves.toEqual({ recorded: true })
    expect(markSecondDeviceOpen).toHaveBeenCalledWith(auth, "ws_1")
  })
})
