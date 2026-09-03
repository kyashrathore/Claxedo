import { describe, expect, test, vi } from "vitest"
import type { ControlPlaneTokenVerifier } from "@claxedo/server-core/platform/auth/auth"
import type { HostTunnelTokenSigner } from "@claxedo/server-core/platform/auth/runtime-access-token"
import type { ControlPlaneServices } from "../../authority/services"
import { createFixedWindowConnectionRateLimiter } from "../../platform/auth/rate-limit"
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

const verifier: ControlPlaneTokenVerifier = async (token, config) => ({
  mode: "signed" as const,
  user: { subject: token, tokenIdentifier: `${config.issuer}|${token}`, issuer: config.issuer },
})

function authority(overrides: Record<string, unknown> = {}) {
  return {
    usersMe: vi.fn(async () => ({ subject: "user_1" })),
    auditAllow: vi.fn(async () => {}),
    createHostEnrollmentRequest: vi.fn(async () => ({ request_id: "req_1", nonce: "n", expires_at: 9_999 })),
    enrollHost: vi.fn(async () => ({ enrollment_id: "enr_1", host_id: "host_1", expires_at: 9_999, last_seen_at: 1, created_at: 1 })),
    heartbeatHostEnrollment: vi.fn(async () => ({ expires_at: 9_999, last_seen_at: 1, assigned_workspace_ids: [] })),
    pauseHostEnrollment: vi.fn(async () => ({ paused: true })),
    activeHostEnrollment: vi.fn(async () => ({ active: true, host_id: "host_1", enrollment_id: "enr_1", expires_at: 9_999, last_seen_at: 1, created_at: 1 })),
    ...overrides,
  }
}

function routes(overrides: Record<string, unknown> = {}, routeOptions: Record<string, unknown> = {}) {
  const api = authority(overrides)
  const services = { authority: api } as unknown as ControlPlaneServices
  const app = HostEnrollmentRoutes(services, { authConfig, verifier, ...routeOptions } as never)
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
  test("heartbeat forwards the client signature and the served set it covers", async () => {
    const { api, post } = routes()

    const response = await post("/heartbeat", { hostId: "host_1", signature: "sig", workspaceIds: ["ws_1"] })

    expect(response.status).toBe(200)
    expect(api.heartbeatHostEnrollment).toHaveBeenCalledWith(expect.anything(), {
      hostId: "host_1",
      signature: "sig",
      workspaceIds: ["ws_1"],
    })
    expect(await response.json()).toMatchObject({ assigned_workspace_ids: [] })
  })

  test("heartbeat refuses the old shape with no workspaceIds", async () => {
    // Heartbeat payload v2: the ONE signature per interval covers the served
    // set, so a body without it cannot be verified and must fail before the
    // authority is touched.
    const { api, post } = routes()

    const response = await post("/heartbeat", { hostId: "host_1", signature: "sig" })

    expect(response.status).toBe(400)
    expect(api.heartbeatHostEnrollment).not.toHaveBeenCalled()
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

describe("the serving credential rides the heartbeat ack", () => {
  const signer: HostTunnelTokenSigner = vi.fn(async (input) => ({
    hostTunnelToken: `htt-for-${input.hostId}`,
    tokenExpiresAt: 2_000_000,
    jti: "jti_htt",
  }))

  test("mints ONE Host Tunnel Token for the assigned ∩ acked set when a signer is configured", async () => {
    const { api, post } = routes(
      {
        heartbeatHostEnrollment: vi.fn(async () => ({
          expires_at: 9_999,
          last_seen_at: 1,
          // ws_3 is assigned but not in this beat's acked set; ws_2 is acked
          // but never assigned. Only ws_1 is routable, so only ws_1 may appear
          // in the credential's claim.
          assigned_workspace_ids: ["ws_1", "ws_3"],
        })),
      },
      { hostTunnelTokenSigner: signer, relayUrl: "https://relay.test" },
    )

    const response = await post("/heartbeat", {
      hostId: "host_1",
      signature: "sig",
      workspaceIds: ["ws_2", "ws_1"],
    })

    expect(response.status).toBe(200)
    expect(signer).toHaveBeenCalledWith({ subject: "user_1", hostId: "host_1", workspaceIds: ["ws_1"] })
    expect(await response.json()).toMatchObject({
      expires_at: 9_999,
      assigned_workspace_ids: ["ws_1", "ws_3"],
      hostTunnel: {
        hostTunnelToken: "htt-for-host_1",
        hostId: "host_1",
        workspaceIds: ["ws_1"],
        relayUrl: "https://relay.test",
      },
    })
    expect(api.heartbeatHostEnrollment).toHaveBeenCalledTimes(1)
  })

  test("mints nothing when the beat acks no assigned workspace", async () => {
    const localSigner = vi.fn(async () => ({ hostTunnelToken: "unused", tokenExpiresAt: 1, jti: "j" }))
    const { post } = routes({}, { hostTunnelTokenSigner: localSigner, relayUrl: "https://relay.test" })

    const response = await post("/heartbeat", { hostId: "host_1", signature: "sig", workspaceIds: ["ws_1"] })

    expect(response.status).toBe(200)
    expect(localSigner).not.toHaveBeenCalled()
    expect(await response.json()).not.toHaveProperty("hostTunnel")
  })

  test("omits the credential entirely when no signer is configured", async () => {
    const { post } = routes({
      heartbeatHostEnrollment: vi.fn(async () => ({
        expires_at: 9_999,
        last_seen_at: 1,
        assigned_workspace_ids: ["ws_1"],
      })),
    })

    const response = await post("/heartbeat", { hostId: "host_1", signature: "sig", workspaceIds: ["ws_1"] })

    expect(response.status).toBe(200)
    expect(await response.json()).not.toHaveProperty("hostTunnel")
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

/**
 * Per-account abuse budget.
 *
 * The app-wide `defaultRequestGuard` in `deployments/hosted-shared/hosted-core-app.ts`
 * already limits this route, and empirically fires on it — but it is IP-keyed
 * BY DESIGN, so it bounds one network path and says nothing about one account.
 * These tests are about the other axis, the one the plan's Unit 6 abuse-control
 * bullet asks for and this file had none of.
 *
 * The default budget is used deliberately rather than an injected tiny one: an
 * excessive-traffic test that only proves "a limiter I supplied limits" would
 * pass with the production default set to a million.
 */
describe("per-account budget", () => {
  test("excessive enrollment-request traffic from ONE account is cut off", async () => {
    const { api, post } = routes()

    const statuses: number[] = []
    for (let attempt = 0; attempt < 40; attempt += 1) {
      statuses.push((await post("/requests", { hostId: `host_${attempt}` })).status)
    }

    // Ten allowed, the rest refused — the shipped default, not a test fixture.
    expect(statuses.filter((status) => status === 200)).toHaveLength(10)
    expect(statuses.filter((status) => status === 429)).toHaveLength(30)
    expect(statuses.slice(0, 10).every((status) => status === 200)).toBe(true)
    // The budget is spent BEFORE the authority is touched: a flood must be
    // rejected while rejecting it is still cheap, and the whole point is that
    // no row is written for the refused calls.
    expect(api.createHostEnrollmentRequest).toHaveBeenCalledTimes(10)
  })

  test("the refusal names the limit rather than looking like a server fault", async () => {
    const { post } = routes()
    for (let attempt = 0; attempt < 10; attempt += 1) await post("/requests", { hostId: "host_x" })

    const response = await post("/requests", { hostId: "host_x" })

    expect(response.status).toBe(429)
    expect(await response.json()).toMatchObject({
      error: { code: "control_plane_rate_limited", retryAfterMs: expect.any(Number) },
    })
  })

  test("one account's flood does not spend another account's budget", async () => {
    // PER-ACCOUNT is the claim. A limiter keyed on anything shared — the route,
    // the deployment — would fail here, and an IP-keyed one cannot make this
    // distinction at all, which is why the global guard does not satisfy it.
    const { call } = routes()
    const requestFor = (subject: string) =>
      call("/requests", {
        method: "POST",
        body: JSON.stringify({ hostId: "host_1" }),
        headers: { authorization: `Bearer ${subject}` },
      })
    for (let attempt = 0; attempt < 20; attempt += 1) await requestFor("user_flood")

    expect((await requestFor("user_flood")).status).toBe(429)
    expect((await requestFor("user_quiet")).status).toBe(200)
  })

  test("a request flood does not consume the budget that enrolls or renews", async () => {
    // Separate buckets, the same split `routes/hosted/workspace.ts` makes: an
    // exhausted nonce budget must not lock a user out of completing the
    // enrollment they already have a nonce for, or out of keeping a live
    // machine alive.
    const { post } = routes()
    for (let attempt = 0; attempt < 20; attempt += 1) await post("/requests", { hostId: "host_1" })

    expect(
      (await post("/", { hostId: "host_1", publicKey: "{}", requestId: "req_1", signature: "sig" })).status,
    ).toBe(200)
    expect((await post("/heartbeat", { hostId: "host_1", signature: "sig", workspaceIds: [] })).status).toBe(200)
  })

  test("renewal traffic is bounded too", async () => {
    // The confirmed defect named enrollment AND renewal. 120/min per account,
    // the deployment's control-plane budget — far above any honest connector,
    // which heartbeats about once per TTL.
    const { api, post } = routes()

    const statuses: number[] = []
    for (let attempt = 0; attempt < 130; attempt += 1) {
      statuses.push((await post("/heartbeat", { hostId: "host_1", signature: "sig", workspaceIds: [] })).status)
    }

    expect(statuses.filter((status) => status === 200)).toHaveLength(120)
    expect(statuses.filter((status) => status === 429)).toHaveLength(10)
    expect(api.heartbeatHostEnrollment).toHaveBeenCalledTimes(120)
  })

  test("the budget is overridable, so a deployment can tighten it", async () => {
    const { api, post } = routes(
      {},
      { enrollmentRequestRateLimiter: createFixedWindowConnectionRateLimiter({ limit: 1, windowMs: 60_000 }) },
    )

    expect((await post("/requests", { hostId: "host_1" })).status).toBe(200)
    expect((await post("/requests", { hostId: "host_1" })).status).toBe(429)
    expect(api.createHostEnrollmentRequest).toHaveBeenCalledTimes(1)
  })
})
