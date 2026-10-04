import { describe, expect, test, vi } from "vitest"
import type { ControlPlaneServices } from "../../authority/services"
import { HostSessionRowsRoutes, type SessionStatusNoticeSink } from "./host-session-rows"

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
    lastTurn: { status: "failed", completedAt: 3 },
  }],
  removed: [],
}

const notice = {
  type: "session.status.changed",
  ownerUserId: "user_owner",
  orgId: "org_1",
  sessionId: "ses_1",
  workspaceId: "ws_local",
  status: "idle",
  awaitingInput: false,
  lastTurn: { status: "failed", completedAt: 3 },
  ts: 3,
} as const

function routes(overrides: { verify?: unknown; publish?: unknown; notify?: SessionStatusNoticeSink } = {}) {
  const verify = "verify" in overrides ? overrides.verify : vi.fn(async () => claims)
  const publish = "publish" in overrides ? overrides.publish : vi.fn(async () => ({ accepted: 1, refused: [], statusNotices: [] }))
  const services = {
    relay: { hostTunnelTokenVerifier: verify },
    authority: { publishHostSessionRows: publish },
  } as unknown as ControlPlaneServices
  return { app: HostSessionRowsRoutes(services, overrides.notify ? { notify: overrides.notify } : {}), verify, publish }
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
    const unknownOutcome = await post(app, { ...body, rows: [{ ...body.rows[0], lastTurn: { status: "busy", completedAt: 3 } }] })

    expect(response.status).toBe(400)
    expect(unknownOutcome.status).toBe(400)
    expect(publish).not.toHaveBeenCalled()
  })

  test("nudges each room once with all its notices and answers the machine without them", async () => {
    const nudges: Array<[string, unknown[]]> = []
    const second = { ...notice, ownerUserId: "user_reader" }
    const elsewhere = { ...notice, orgId: "org_2" }
    const { app } = routes({
      publish: vi.fn(async () => ({ accepted: 1, refused: [], statusNotices: [notice, second, elsewhere] })),
      notify: async (orgId, notices) => void nudges.push([orgId, [...notices]]),
    })

    const response = await post(app, body)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ accepted: 1, refused: [] })
    expect(nudges).toEqual([["org_1", [notice, second]], ["org_2", [elsewhere]]])
  })

  test("a failed nudge is logged, the other rooms still get theirs, and the committed publish answers 200", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const delivered: string[] = []
    const { app } = routes({
      publish: vi.fn(async () => ({ accepted: 1, refused: [], statusNotices: [notice, { ...notice, orgId: "org_2" }] })),
      notify: async (orgId) => {
        if (orgId === "org_1") throw new Error("room unavailable")
        delivered.push(orgId)
      },
    })

    const response = await post(app, body)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ accepted: 1, refused: [] })
    expect(delivered).toEqual(["org_2"])
    expect(error).toHaveBeenCalledWith(expect.stringContaining("session.status.changed nudge failed"), expect.objectContaining({ orgId: "org_1" }))
    error.mockRestore()
  })

  test("on a Worker the nudges run after the answer, under waitUntil", async () => {
    const pending: Promise<unknown>[] = []
    let release = () => {}
    const { app } = routes({
      publish: vi.fn(async () => ({ accepted: 1, refused: [], statusNotices: [notice] })),
      notify: () => new Promise<void>((resolve) => { release = resolve }),
    })
    const executionCtx = { waitUntil: (work: Promise<unknown>) => void pending.push(work), passThroughOnException: () => {}, props: {} }

    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tunnel-token" },
      body: JSON.stringify(body),
    }, undefined, executionCtx)

    expect(response.status).toBe(200)
    expect(pending).toHaveLength(1)
    release()
    await pending[0]
  })

  test("takes a row's background work with its status and refuses a malformed count", async () => {
    const { app, publish } = routes()
    const status = { kind: "idle", awaitingInput: false, backgroundWork: { agents: 1, shells: 2, other: 0 }, at: 3 }
    expect((await post(app, { ...body, rows: [{ ...body.rows[0], status }] })).status).toBe(200)
    expect(publish).toHaveBeenCalledWith(expect.anything(), { rows: [{ ...body.rows[0], status }], removed: [] })
    const malformed = await post(app, { ...body, rows: [{ ...body.rows[0], status: { ...status, backgroundWork: { agents: -1, shells: 0, other: 0 } } }] })
    expect(malformed.status).toBe(400)
  })

  test("answers 501 on a plane with no verifier or no publishing authority", async () => {
    expect((await post(routes({ verify: undefined }).app, body)).status).toBe(501)
    expect((await post(routes({ publish: undefined }).app, body)).status).toBe(501)
  })
})
