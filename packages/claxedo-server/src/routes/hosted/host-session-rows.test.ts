import { describe, expect, test, vi } from "vitest"
import type { ControlPlaneServices } from "../../authority/services"
import { HostSessionRowsRoutes } from "./host-session-rows"

const claims = {
  iss: "claxedo-control-plane",
  aud: "workspace-relay-host-tunnel",
  sub: "user_owner",
  host_id: "machine-r",
  workspace_ids: ["ws_local"],
  enrollment_id: "enr_1",
  generation: 3,
  exp: 2_000_000_000,
  iat: 1_900_000_000,
  jti: "jti_1",
}

const body = {
  hostId: "machine-r",
  rows: [{
    workspaceId: "ws_local",
    sessionId: "ses_1",
    title: "One",
    createdAt: 1,
    updatedAt: 2,
    status: { kind: "idle", awaitingInput: false, at: 3 },
  }],
  removed: [],
}

function routes(overrides: { verify?: unknown; publish?: unknown } = {}) {
  const verify = "verify" in overrides ? overrides.verify : vi.fn(async () => claims)
  const publish = "publish" in overrides ? overrides.publish : vi.fn(async () => ({ accepted: 1, refused: [] }))
  const services = {
    relay: { hostTunnelTokenVerifier: verify },
    authority: { publishHostSessionRows: publish },
  } as unknown as ControlPlaneServices
  return { app: HostSessionRowsRoutes(services), verify, publish }
}

function post(app: ReturnType<typeof routes>["app"], payload: unknown, token: string | null = "tunnel-token") {
  return app.request("/", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(payload),
  })
}

describe("POST /api/claxedo/host/session-rows", () => {
  test("publishes as the host, owner, workspaces and generation the token names", async () => {
    const { app, verify, publish } = routes()
    const response = await post(app, body)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ accepted: 1, refused: [] })
    expect(verify).toHaveBeenCalledWith("tunnel-token", "machine-r")
    expect(publish).toHaveBeenCalledWith(
      { hostId: "machine-r", ownerUserId: "user_owner", workspaceIds: ["ws_local"], enrollmentId: "enr_1", generation: 3 },
      { rows: body.rows, removed: [] },
    )
  })

  test("refuses a missing or unverifiable token before publishing anything", async () => {
    const missing = routes()
    expect((await post(missing.app, body, null)).status).toBe(401)

    const refused = routes({ verify: vi.fn(async () => { throw new Error("bad signature") }) })
    const response = await post(refused.app, body)
    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ error: { code: "invalid_host_tunnel_token" } })
    expect(refused.publish).not.toHaveBeenCalled()
  })

  test("refuses a malformed publication", async () => {
    const { app, publish } = routes()
    const response = await post(app, { ...body, rows: [{ ...body.rows[0], status: { kind: "thinking", awaitingInput: false, at: 1 } }] })

    expect(response.status).toBe(400)
    expect(publish).not.toHaveBeenCalled()
  })

  test("answers 501 on a plane with no verifier or no publishing authority", async () => {
    expect((await post(routes({ verify: undefined }).app, body)).status).toBe(501)
    expect((await post(routes({ publish: undefined }).app, body)).status).toBe(501)
  })

  test("committed removals reach private fanout and report a failed fanout", async () => {
    const removed = { workspaceId: "ws_local", sessionId: "ses_1" }
    const notice = { ...removed, type: "session.removed" as const, ownerUserId: "user_owner", projectId: "prj_1", ts: 10 }
    const publish = vi.fn(async () => ({ accepted: 1, refused: [] }))
    const sessionPublicationNotices = vi.fn(async () => [notice])
    const sink = vi.fn(async () => { throw new Error("Room unavailable") })
    const app = HostSessionRowsRoutes({
      relay: { hostTunnelTokenVerifier: async () => claims },
      authority: { publishHostSessionRows: publish, sessionPublicationNotices },
    } as unknown as ControlPlaneServices, { notice: sink })
    const response = await post(app, { hostId: "machine-r", rows: [], removed: [removed] })
    expect(response.status).toBe(500)
    expect(publish).toHaveBeenCalledOnce()
    expect(sessionPublicationNotices).toHaveBeenCalledWith([removed], [])
    expect(sink).toHaveBeenCalledWith(notice)
  })


})
