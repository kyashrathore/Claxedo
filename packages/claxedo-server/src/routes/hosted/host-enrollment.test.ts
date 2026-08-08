import { describe, expect, test, vi } from "vitest"
import type { ClerkVerifier } from "@claxedo/server-core/platform/auth/auth"
import type { ControlPlaneServices } from "../../authority/services"
import { HostEnrollmentRoutes } from "./host-enrollment"

/**
 * The HTTP surface of machine-wide enrollment.
 *
 * The authority's own behaviour is pinned in
 * `authority/adapters/sqlite/host-enrollment.test.ts` and the Convex policy
 * suite. What is only visible here: that these routes require a signed caller,
 * that they pass the client's signature through untouched rather than signing
 * anything themselves, that no path takes a workspace id, and that an authority
 * without enrollment answers 501 instead of throwing a TypeError into a 500.
 */

const authConfig = {
  enabled: true,
  issuer: "https://clerk.example.test",
  jwksUrl: "https://clerk.example.test/.well-known/jwks.json",
} as const

const verifier: ClerkVerifier = async (token, config) => ({
  mode: "signed" as const,
  user: { subject: token, tokenIdentifier: `${config.issuer}|${token}`, issuer: config.issuer },
})

function authority(overrides: Record<string, unknown> = {}) {
  return {
    usersMe: vi.fn(async () => ({ subject: "user_1" })),
    auditAllow: vi.fn(async () => {}),
    createHostEnrollmentRequest: vi.fn(async () => ({ request_id: "req_1", nonce: "n", expires_at: 9_999 })),
    enrollHost: vi.fn(async () => ({ enrollment_id: "enr_1", host_id: "host_1", expires_at: 9_999, last_seen_at: 1, created_at: 1 })),
    heartbeatHostEnrollment: vi.fn(async () => ({ expires_at: 9_999, last_seen_at: 1 })),
    pauseHostEnrollment: vi.fn(async () => ({ paused: true })),
    activeHostEnrollment: vi.fn(async () => ({ active: true, host_id: "host_1", enrollment_id: "enr_1", expires_at: 9_999, last_seen_at: 1, created_at: 1 })),
    ...overrides,
  }
}

function routes(overrides: Record<string, unknown> = {}) {
  const api = authority(overrides)
  const services = { authority: api } as unknown as ControlPlaneServices
  const app = HostEnrollmentRoutes(services, { authConfig, verifier } as never)
  const call = (path: string, init: RequestInit = {}) =>
    app.request(`http://control.test${path}`, {
      headers: { authorization: "Bearer user_1", "content-type": "application/json", ...(init.headers ?? {}) },
      ...init,
    })
  const post = (path: string, body: unknown) => call(path, { method: "POST", body: JSON.stringify(body) })
  return { api, call, post }
}

describe("authentication", () => {
  test("answers 401 to an unsigned caller on every route", async () => {
    // There is no unsigned path to machine enrollment: a loopback caller with
    // no account has no account to enroll a machine against.
    //
    // The 401 comes from `signedOrError` under `requireSigned: true`, not from
    // the `!auth` line in the handler — removing that line does not fail this,
    // which is why the implementation labels it as type narrowing.
    const { api, call } = routes()
    const anonymous = { headers: { "content-type": "application/json" } }

    for (const [path, method] of [
      ["/requests", "POST"],
      ["/", "POST"],
      ["/heartbeat", "POST"],
      ["/pause", "POST"],
      ["/", "GET"],
    ] as const) {
      const response = await call(path, { method, ...anonymous, ...(method === "POST" ? { body: "{}" } : {}) })
      expect(response.status, `${method} ${path}`).toBe(401)
    }
    expect(api.enrollHost).not.toHaveBeenCalled()
  })
})

describe("POST /requests", () => {
  test("issues a nonce for the named host", async () => {
    const { api, post } = routes()

    const response = await post("/requests", { hostId: "host_1" })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ request_id: "req_1", nonce: "n" })
    expect(api.createHostEnrollmentRequest).toHaveBeenCalledWith(expect.anything(), { hostId: "host_1" })
  })

  test("rejects a body with no host id", async () => {
    const { api, post } = routes()

    expect((await post("/requests", {})).status).toBe(400)
    expect(api.createHostEnrollmentRequest).not.toHaveBeenCalled()
  })

  test("rejects an unknown field rather than ignoring it", async () => {
    // `.strict()`. A caller sending `workspaceId` is using the old shape, and
    // silently dropping it would look like it worked.
    const { post } = routes()

    expect((await post("/requests", { hostId: "host_1", workspaceId: "ws_1" })).status).toBe(400)
  })
})

describe("POST /", () => {
  test("passes the client's signature through and records the enrollment", async () => {
    // The server never holds the host key. Its whole job here is to carry the
    // client's proof to the authority unmodified.
    const { api, post } = routes()

    const response = await post("/", {
      hostId: "host_1",
      publicKey: "{}",
      requestId: "req_1",
      signature: "sig",
      displayName: "Work laptop",
    })

    expect(response.status).toBe(200)
    expect(api.enrollHost).toHaveBeenCalledWith(expect.anything(), {
      hostId: "host_1",
      publicKey: "{}",
      requestId: "req_1",
      signature: "sig",
      displayName: "Work laptop",
    })
  })

  test("takes no workspace id, and refuses one", async () => {
    // The point of the unit. A path or body that still accepts a workspace is
    // the per-workspace design creeping back.
    const { post } = routes()

    const response = await post("/", {
      hostId: "host_1",
      publicKey: "{}",
      requestId: "req_1",
      signature: "sig",
      workspaceId: "ws_1",
    })

    expect(response.status).toBe(400)
  })

  test("audits the enrollment", async () => {
    const { api, post } = routes()

    await post("/", { hostId: "host_1", publicKey: "{}", requestId: "req_1", signature: "sig" })

    expect(api.auditAllow).toHaveBeenCalledWith(expect.anything(), {
      action: "host_enrollment.enabled",
      metadata: { hostId: "host_1" },
    })
  })

  test("does not audit when the authority rejects the signature", async () => {
    // An audit trail that records failed attempts as enrollments is worse than
    // none: it is a log that lies in the direction of "everything is fine".
    const { api, post } = routes({
      enrollHost: vi.fn(async () => {
        throw new Error("Invalid host attestation")
      }),
    })

    // Hono turns the thrown error into a 500 rather than rejecting, so the
    // status is asserted too — otherwise "no audit" would also hold if the
    // route had quietly succeeded and skipped auditing.
    const response = await post("/", { hostId: "host_1", publicKey: "{}", requestId: "req_1", signature: "sig" })

    expect(response.status).toBe(500)
    expect(api.auditAllow).not.toHaveBeenCalled()
  })
})

describe("POST /heartbeat and /pause", () => {
  test("heartbeat forwards the client signature", async () => {
    const { api, post } = routes()

    const response = await post("/heartbeat", { hostId: "host_1", signature: "sig" })

    expect(response.status).toBe(200)
    expect(api.heartbeatHostEnrollment).toHaveBeenCalledWith(expect.anything(), { hostId: "host_1", signature: "sig" })
  })

  test("pause with no host id means every machine", async () => {
    const { api, post } = routes()

    await post("/pause", { paused: true })

    expect(api.pauseHostEnrollment).toHaveBeenCalledWith(expect.anything(), { paused: true })
  })

  test("pause records which way it went", async () => {
    const { api, post } = routes()

    await post("/pause", { hostId: "host_1", paused: false })

    expect(api.auditAllow).toHaveBeenCalledWith(expect.anything(), {
      action: "host_enrollment.resumed",
      metadata: { hostId: "host_1" },
    })
  })
})

describe("GET /", () => {
  test("returns what the settings screen shows", async () => {
    const { call } = routes()

    const response = await call("/", { method: "GET" })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ active: true, host_id: "host_1" })
  })
})

describe("an authority without enrollment", () => {
  test("answers 501 rather than throwing a TypeError into a 500", async () => {
    // The port's methods are optional until the hard cut, so a control plane
    // built before this unit will not have them. "Not implemented" is a usable
    // answer; a 500 with a stack is a support ticket.
    const { post, call } = routes({
      createHostEnrollmentRequest: undefined,
      enrollHost: undefined,
      activeHostEnrollment: undefined,
    })

    expect((await post("/requests", { hostId: "host_1" })).status).toBe(501)
    expect((await post("/", { hostId: "host_1", publicKey: "{}", requestId: "r", signature: "s" })).status).toBe(501)
    expect((await call("/", { method: "GET" })).status).toBe(501)
  })
})
