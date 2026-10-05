import { describe, expect, test, vi } from "vitest"
import { ControlPlaneAuthError } from "@claxedo/server-core/platform/auth/auth"
import { RemoteAccessOwnerRoutes } from "./remote-access"

const auth = { user: { subject: "user_1" } } as never

describe("remote access routes", () => {
  test("reports device sign-in and relay blockers and no enrollment while either is missing", async () => {
    const authenticate = vi.fn(async () => auth)
    const app = RemoteAccessOwnerRoutes({
      deviceLoginConfigured: false,
      relayConfigured: false,
      authenticate,
      service: {
        status: vi.fn(async () => ({ enrolled: false, enabled: false })),
        devices: vi.fn(async () => []),
        revoke: vi.fn(async () => ({ revoked: false })),
        rename: vi.fn(async () => ({ displayName: "Renamed" })),
      },
    })

    const status = await app.request("http://localhost/")
    expect(status.status).toBe(200)
    await expect(status.json()).resolves.toEqual({
      device_login_configured: false,
      relay_configured: false,
      hosted_signed_in: true,
      enrolled: false,
      enabled: false,
    })
  })

  test("renaming a machine trims the name, refuses an empty one, and is 404 for a host the caller does not own", async () => {
    const rename = vi.fn(async (_auth: unknown, input: { hostId: string; displayName: string }) =>
      input.hostId === "host_1" ? { displayName: input.displayName } : undefined)
    const app = RemoteAccessOwnerRoutes({
      deviceLoginConfigured: true,
      relayConfigured: true,
      authenticate: vi.fn(async () => auth),
      service: {
        status: vi.fn(async () => ({ enrolled: true, enabled: true })),
        devices: vi.fn(async () => []),
        revoke: vi.fn(async () => ({ revoked: true })),
        rename,
      },
    })

    const renamed = await app.request("http://localhost/devices/host_1", {
      method: "PATCH",
      body: JSON.stringify({ display_name: "  Build box  " }),
    })
    expect(renamed.status).toBe(200)
    await expect(renamed.json()).resolves.toEqual({ display_name: "Build box" })
    expect(rename).toHaveBeenCalledWith(auth, { hostId: "host_1", displayName: "Build box" })

    const empty = await app.request("http://localhost/devices/host_1", {
      method: "PATCH",
      body: JSON.stringify({ display_name: "   " }),
    })
    expect(empty.status).toBe(400)
    expect(rename).toHaveBeenCalledTimes(1)

    const foreign = await app.request("http://localhost/devices/host_other", {
      method: "PATCH",
      body: JSON.stringify({ display_name: "Mine now" }),
    })
    expect(foreign.status).toBe(404)
    await expect(foreign.json()).resolves.toMatchObject({ error: { code: "host_enrollment_not_found" } })
  })

  test("status refuses an anonymous remote caller the same way /devices does", async () => {
    const authenticate = vi.fn(async () => {
      throw new ControlPlaneAuthError(401, "missing_bearer_token", "Authorization: Bearer token is required")
    })
    const status = vi.fn()
    const app = RemoteAccessOwnerRoutes({
      deviceLoginConfigured: true,
      relayConfigured: true,
      authenticate,
      service: {
        status,
        devices: vi.fn(),
        revoke: vi.fn(),
        rename: vi.fn(async () => ({ displayName: "Renamed" })),
      },
    })

    const response = await app.request("http://localhost/")
    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ error: { code: "missing_bearer_token" } })
    expect(status).not.toHaveBeenCalled()
  })

  test("lists and revokes enrolled machines through signed auth", async () => {
    const service = {
      status: vi.fn(async () => ({ enrolled: true, enabled: true })),
      devices: vi.fn(async () => [{ hostId: "host_1", enrollmentId: "enr_1", displayName: "Mac", lastSeenAt: 10, state: "paused" as const, workspaceIds: ["ws_1", "ws_2"] }]),
      revoke: vi.fn(async () => ({ revoked: true })),
      rename: vi.fn(async () => ({ displayName: "Renamed" })),
    }
    const app = RemoteAccessOwnerRoutes({
      deviceLoginConfigured: true,
      relayConfigured: true,
      authenticate: vi.fn(async () => auth),
      service,
    })

    await expect((await app.request("http://localhost/devices")).json()).resolves.toEqual({
      devices: [{ host_id: "host_1", enrollment_id: "enr_1", display_name: "Mac", last_seen_at: 10, state: "paused", workspace_ids: ["ws_1", "ws_2"] }],
    })
    await expect((await app.request("http://localhost/devices/host_1", { method: "DELETE" })).json())
      .resolves.toEqual({ revoked: true })
    expect(service.revoke).toHaveBeenCalledWith(auth, "host_1")
  })
})
