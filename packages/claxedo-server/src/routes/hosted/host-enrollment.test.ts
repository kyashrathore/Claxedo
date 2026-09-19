import { describe, expect, test, vi } from "vitest"
import type { ControlPlaneTokenVerifier } from "@claxedo/server-core/platform/auth/auth"
import type { MachineEnrollmentRow } from "@claxedo/server-core/platform/auth/authority"
import {
  MACHINE_REQUEST_HEADERS,
  machineRequestPayload,
} from "@claxedo/server-core/platform/auth/host-connect-contract"
import type { HostTunnelTokenSigner } from "@claxedo/server-core/platform/auth/runtime-access-token"
import { sha256Hex } from "@claxedo/helpers/crypto"
import type { ControlPlaneServices } from "../../authority/services"
import { D1HostAccessAuthorityError } from "../../authority/adapters/d1/host-access-authority"
import { createFixedWindowConnectionRateLimiter } from "../../platform/auth/rate-limit"
import { HostEnrollmentRoutes, HostInvitationRoutes } from "./host-enrollment"

/**
 * The HTTP surface of machine-wide enrollment.
 *
 * The authority's own behaviour is pinned in
 * `authority/adapters/sqlite/host-enrollment.test.ts` and the authority policy
 * suite. What is only visible here: that these routes require a signed caller,
 * that they pass the client's signature through untouched rather than signing
 * anything themselves, that no path takes a workspace id, and that an authority
 * without enrollment answers 501 instead of throwing a TypeError into a 500.
 */

const authConfig = {
  enabled: true,
  issuer: "https://issuer.example.test",
  jwksUrl: "https://issuer.example.test/.well-known/jwks.json",
} as const

const verifier: ControlPlaneTokenVerifier = async (token, config) => ({
  mode: "signed" as const,
  user: { subject: token, tokenIdentifier: `${config.issuer}|${token}`, issuer: config.issuer },
})

function authority(overrides: Record<string, unknown> = {}): Record<string, ReturnType<typeof vi.fn>> {
  return {
    usersMe: vi.fn(async () => ({ subject: "user_1" })),
    auditAllow: vi.fn(async () => {}),
    createHostEnrollmentRequest: vi.fn(async () => ({ request_id: "req_1", nonce: "n", expires_at: 9_999 })),
    enrollHost: vi.fn(async () => ({ enrollment_id: "enr_1", host_id: "host_1", expires_at: 9_999, last_seen_at: 1, created_at: 1 })),
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
      headers: { authorization: "Bearer user_1", "content-type": "application/json", ...Object.fromEntries(new Headers(init.headers)) },
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
  test("an account credential buys no beat: the bearer reaches the machine path, never the authority", async () => {
    // Enrollment is where the owner speaks. After it the machine signs for
    // itself, so a bearer with the old client-signed body gets the machine
    // path's answer — here 501, because this authority admits no machine
    // caller at all — rather than a second, account-shaped way to renew a
    // lease. The refusal a deployment that DOES admit machines gives the same
    // request is asserted with the mixed-credential case below.
    const { api, post } = routes()

    const response = await post("/heartbeat", { hostId: "host_1", signature: "sig", workspaceIds: ["ws_1"] })

    expect(response.status).toBe(501)
    expect(await response.json()).toMatchObject({ error: { code: "machine_caller_unsupported" } })
    // The bearer was never resolved into an account caller: an account branch
    // would have had to identify the owner before it could beat.
    expect(api.usersMe).not.toHaveBeenCalled()
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

/**
 * Per-account abuse budget.
 *
 * The app-wide `defaultRequestGuard` (`hosted-core-app.ts`) is IP-keyed, so it
 * bounds one network path and says nothing about one account; these tests
 * cover the account axis.
 *
 * The shipped default budget is used rather than an injected tiny one: a test
 * that only proves "a limiter I supplied limits" would pass with the
 * production default set to a million.
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
    expect((await post("/pause", { paused: true })).status).toBe(200)
  })

  test("account traffic on the shared budget is bounded too", async () => {
    // The confirmed defect named enrollment AND renewal. 120/min per account,
    // the deployment's control-plane budget — far above any honest client of
    // these routes.
    const { api, post } = routes()

    const statuses: number[] = []
    for (let attempt = 0; attempt < 130; attempt += 1) {
      statuses.push((await post("/pause", { paused: true })).status)
    }

    expect(statuses.filter((status) => status === 200)).toHaveLength(120)
    expect(statuses.filter((status) => status === 429)).toHaveLength(10)
    expect(api.pauseHostEnrollment).toHaveBeenCalledTimes(120)
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

/**
 * The machine caller: a `claxedo connect` host with no account on the box.
 * Requests are signed with a real P-256 key over the contract's payload so
 * the route's use of `verifyMachineRequest` is exercised, not mocked.
 */
const NOW = 1_800_000_000_000

async function machineKey() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])
  return {
    publicKeyJson: JSON.stringify(await crypto.subtle.exportKey("jwk", pair.publicKey)),
    async sign(payload: string) {
      const bytes = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new TextEncoder().encode(payload))
      return Buffer.from(bytes).toString("base64url")
    },
  }
}

function enrollmentRow(key: Awaited<ReturnType<typeof machineKey>>, overrides: Partial<MachineEnrollmentRow> = {}): MachineEnrollmentRow {
  return {
    enrollment_id: "enr_1",
    host_id: "host_1",
    owner_user_id: "usr_owner",
    owner_actor_id: "act_owner",
    public_key_json: key.publicKeyJson,
    key_version: 1,
    serving_generation: 2,
    revoked_at: null,
    paused_at: null,
    scope: { allowed_roots: ["/srv"], visibility: "owner", revision: 1 },
    ownerEligible: true,
    ...overrides,
  }
}

function machineAuthority(row: MachineEnrollmentRow | undefined, overrides: Record<string, unknown> = {}) {
  const nonces = new Set<string>()
  return authority({
    machineAuth: {
      lookupEnrollment: vi.fn(async (id: string) => (row && id === row.enrollment_id ? row : undefined)),
      consumeNonce: vi.fn(async (input: { enrollmentId: string; nonce: string }) => {
        const key = `${input.enrollmentId}:${input.nonce}`
        if (nonces.has(key)) return false
        nonces.add(key)
        return true
      }),
    },
    heartbeatHostEnrollmentByMachine: vi.fn(async () => ({
      expires_at: NOW + 8_000,
      last_seen_at: NOW,
      assignments: [
        { workspace_id: "ws_1", remote_directory: "/srv/one", revision: 3 },
        { workspace_id: "ws_2", remote_directory: "/srv/two", display_name: "Two", revision: 5 },
      ],
      scope: { allowed_roots: ["/srv"], visibility: "owner", revision: 1 },
      assigned_workspace_ids: ["ws_1", "ws_2"],
    })),
    acquireHostServingGeneration: vi.fn(async () => ({ generation: 3, generation_acquired_at: NOW })),
    ...overrides,
  })
}

const beat = (overrides: Record<string, unknown> = {}) => ({
  enrollmentId: "enr_1",
  hostId: "host_1",
  keyVersion: 1,
  generation: 2,
  acks: [{ workspaceId: "ws_1", revision: 3 }, { workspaceId: "ws_2", revision: 4 }],
  ...overrides,
})

describe("POST /heartbeat, machine caller (v3)", () => {
  const signer: HostTunnelTokenSigner = vi.fn(async (input) => ({
    hostTunnelToken: `htt-for-${input.hostId}`,
    tokenExpiresAt: NOW + 300_000,
    jti: "jti_htt",
  }))

  test("verifies the request signature, beats as the row's owner, and answers descriptions, scope, endpoints and the credential for the ready set", async () => {
    const key = await machineKey()
    const api = machineAuthority(enrollmentRow(key))
    const { signedCall } = await mountedRoutes(api, {
      hostTunnelTokenSigner: signer,
      relayUrl: "https://relay.test/",
      sessionAuthorityUrl: "https://cp.test/api/runtime-authority/session-authorize",
    })

    const response = await signedCall(key, "/heartbeat", beat({ ttlMs: 8_000, sessionAuthority: "managed-private" }))

    expect(response.status, await response.clone().text()).toBe(200)
    expect(api.heartbeatHostEnrollmentByMachine).toHaveBeenCalledWith(
      { enrollmentId: "enr_1", hostId: "host_1", ownerUserId: "usr_owner", ownerActorId: "act_owner", scope: { allowed_roots: ["/srv"], visibility: "owner", revision: 1 }, keyVersion: 1, generation: 2 },
      { enrollmentId: "enr_1", hostId: "host_1", generation: 2, acks: [{ workspaceId: "ws_1", revision: 3 }, { workspaceId: "ws_2", revision: 4 }], ttlMs: 8_000, sessionAuthority: "managed-private" },
    )
    // ws_2 was acked at revision 4 but the description says 5: not ready, no credential for it.
    expect(signer).toHaveBeenCalledWith({
      subject: "usr_owner",
      hostId: "host_1",
      workspaceIds: ["ws_1"],
      enrollmentId: "enr_1",
      generation: 2,
    })
    expect(await response.json()).toEqual({
      expires_at: NOW + 8_000,
      last_seen_at: NOW,
      assignments: [
        { workspace_id: "ws_1", remote_directory: "/srv/one", revision: 3 },
        { workspace_id: "ws_2", remote_directory: "/srv/two", display_name: "Two", revision: 5 },
      ],
      scope: { allowed_roots: ["/srv"], visibility: "owner", revision: 1 },
      assigned_workspace_ids: ["ws_1", "ws_2"],
      relay: { url: "https://relay.test/", jwks_url: "https://relay.test/.well-known/jwks.json" },
      authority: { session_authority_url: "https://cp.test/api/runtime-authority/session-authorize" },
      serving_generation: 2,
      hostTunnel: {
        hostTunnelToken: "htt-for-host_1",
        tokenExpiresAt: NOW + 300_000,
        jti: "jti_htt",
        hostId: "host_1",
        workspaceIds: ["ws_1"],
        relayUrl: "https://relay.test/",
      },
    })
  })

  test("uses a configured relay JWKS URL over the derived one and omits endpoints it does not know", async () => {
    const key = await machineKey()
    const { signedCall } = await mountedRoutes(machineAuthority(enrollmentRow(key)), {
      relayUrl: "https://relay.test",
      relayHostJwksUrl: "https://keys.relay.test/jwks.json",
    })
    const body = await (await signedCall(key, "/heartbeat", beat({ acks: [] }))).json() as Record<string, unknown>
    expect(body.relay).toEqual({ url: "https://relay.test", jwks_url: "https://keys.relay.test/jwks.json" })
    expect(body).not.toHaveProperty("authority")
    expect(body).not.toHaveProperty("hostTunnel")
  })

  test("refuses a bad signature, a tampered body, an unknown enrollment, a replayed nonce and a stale timestamp before touching the authority", async () => {
    const key = await machineKey()
    const api = machineAuthority(enrollmentRow(key))
    const { signedCall } = await mountedRoutes(api)
    const forger = await machineKey()
    const refusals: Array<[Promise<Response>, number, string]> = [
      [signedCall(forger, "/heartbeat", beat()), 401, "machine_request_denied"],
      [signedCall(key, "/heartbeat", beat(), { tamper: (text) => text.replace('"generation":2', '"generation":9') }), 401, "machine_request_denied"],
      [signedCall(key, "/heartbeat", beat({ enrollmentId: "enr_2" }), { enrollmentId: "enr_2" }), 401, "machine_request_denied"],
      [signedCall(key, "/heartbeat", beat(), { ts: NOW - 60_001 }), 401, "machine_timestamp_skew"],
      [signedCall(key, "/heartbeat", beat(), { headers: { [MACHINE_REQUEST_HEADERS.nonce]: "short" } }), 400, "machine_headers_invalid"],
    ]
    for (const [pending, status, code] of refusals) {
      const response = await pending
      expect(response.status, code).toBe(status)
      expect(await response.json()).toMatchObject({ error: { code } })
    }
    const replayed = await signedCall(key, "/heartbeat", beat(), { nonce: "nonce_replay_0000000" })
    expect(replayed.status).toBe(200)
    const again = await signedCall(key, "/heartbeat", beat(), { nonce: "nonce_replay_0000000" })
    expect(again.status).toBe(401)
    expect(await again.json()).toMatchObject({ error: { code: "machine_nonce_replayed" } })
    expect(api.heartbeatHostEnrollmentByMachine).toHaveBeenCalledTimes(1)
  })

  test("a revoked, paused or ineligible enrollment is a 403 decision and a superseded generation a 409", async () => {
    const key = await machineKey()
    for (const [overrides, code] of [
      [{ revoked_at: 5 }, "enrollment_revoked"],
      [{ paused_at: 5 }, "enrollment_paused"],
      [{ ownerEligible: false }, "enrollment_owner_ineligible"],
      [{ key_version: 2 }, "enrollment_key_version_mismatch"],
    ] as const) {
      const { signedCall } = await mountedRoutes(machineAuthority(enrollmentRow(key, overrides)))
      const response = await signedCall(key, "/heartbeat", beat())
      expect(response.status, code).toBe(403)
      expect(await response.json()).toMatchObject({ error: { code } })
    }
    const superseded = machineAuthority(enrollmentRow(key), {
      heartbeatHostEnrollmentByMachine: vi.fn(async () => {
        throw new D1HostAccessAuthorityError("enrollment_generation_superseded", "superseded", { serving_generation: 3 })
      }),
    })
    const { signedCall } = await mountedRoutes(superseded)
    const response = await signedCall(key, "/heartbeat", beat())
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: { code: "enrollment_generation_superseded", message: "superseded", serving_generation: 3 },
    })
  })

  test("caps the body at 16 KiB and refuses a body that fails the schema after verification", async () => {
    const key = await machineKey()
    const api = machineAuthority(enrollmentRow(key))
    const { signedCall } = await mountedRoutes(api)
    const huge = await signedCall(key, "/heartbeat", beat({ acks: [], padding: "x".repeat(17 * 1024) }))
    expect(huge.status).toBe(413)
    const unknownField = await signedCall(key, "/heartbeat", beat({ extra: true }))
    expect(unknownField.status).toBe(400)
    expect(api.heartbeatHostEnrollmentByMachine).not.toHaveBeenCalled()
  })

  test("spends a per-enrollment budget only after verification, 120 a minute keyed machine:<enrollment_id>", async () => {
    const key = await machineKey()
    const api = machineAuthority(enrollmentRow(key))
    const { signedCall } = await mountedRoutes(api, {
      clientRateLimiter: createFixedWindowConnectionRateLimiter({ limit: 1_000, windowMs: 60_000 }),
    })
    const statuses: number[] = []
    for (let attempt = 0; attempt < 125; attempt += 1) statuses.push((await signedCall(key, "/heartbeat", beat({ acks: [] }))).status)
    expect(statuses.filter((status) => status === 200)).toHaveLength(120)
    expect(statuses.filter((status) => status === 429)).toHaveLength(5)
    expect(api.heartbeatHostEnrollmentByMachine).toHaveBeenCalledTimes(120)
    // A forger cannot spend the real machine's budget: their requests fail at the signature.
    const forger = await machineKey()
    const { api: fresh, signedCall: freshCall } = await mountedRoutes(machineAuthority(enrollmentRow(key)), {
      clientRateLimiter: createFixedWindowConnectionRateLimiter({ limit: 1_000, windowMs: 60_000 }),
    })
    for (let attempt = 0; attempt < 130; attempt += 1) await freshCall(forger, "/heartbeat", beat())
    expect((await freshCall(key, "/heartbeat", beat({ acks: [] }))).status).toBe(200)
    expect(fresh.heartbeatHostEnrollmentByMachine).toHaveBeenCalledTimes(1)
  })

  test("answers 501 when the authority cannot admit a machine caller, and the account routes never do", async () => {
    const key = await machineKey()
    const { signedCall } = await mountedRoutes(authority())
    const response = await signedCall(key, "/heartbeat", beat())
    expect(response.status).toBe(501)
    expect(await response.json()).toMatchObject({ error: { code: "machine_caller_unsupported" } })

    const { signedCall: real, api } = await mountedRoutes(machineAuthority(enrollmentRow(key)))
    // A machine-signed request on an account route is an unsigned account request: 401.
    expect((await real(key, "/requests", { hostId: "host_1" })).status).toBe(401)
    expect((await real(key, "/pause", { paused: true })).status).toBe(401)
    expect(api.createHostEnrollmentRequest).not.toHaveBeenCalled()
    // A bearer buys nothing on this route: with machine headers that do not
    // verify it is a refused machine request, not an account beat.
    const { app, api: mixedApi } = await mountedRoutes(machineAuthority(enrollmentRow(key)))
    const mixed = await app.request("http://control.test/api/claxedo/host/enrollments/heartbeat", {
      method: "POST",
      headers: { authorization: "Bearer user_1", "content-type": "application/json", [MACHINE_REQUEST_HEADERS.enrollmentId]: "enr_1" },
      body: JSON.stringify({ hostId: "host_1", signature: "sig", workspaceIds: [] }),
    })
    expect(mixed.status).toBe(400)
    expect(await mixed.json()).toMatchObject({ error: { code: "machine_headers_invalid" } })
    expect(mixedApi.heartbeatHostEnrollmentByMachine).not.toHaveBeenCalled()
  })
})

describe("POST /acquire", () => {
  test("claims the next generation for the verified machine and answers it", async () => {
    const key = await machineKey()
    const api = machineAuthority(enrollmentRow(key))
    const { signedCall } = await mountedRoutes(api)
    const response = await signedCall(key, "/acquire", { enrollmentId: "enr_1", hostId: "host_1", keyVersion: 1 })
    expect(response.status, await response.clone().text()).toBe(200)
    expect(await response.json()).toEqual({ generation: 3, generation_acquired_at: NOW })
    expect(api.acquireHostServingGeneration).toHaveBeenCalledWith(expect.objectContaining({ enrollmentId: "enr_1", generation: 2 }))
  })

  test("a body naming another host than the row is refused by the verifier as an invalid body", async () => {
    const key = await machineKey()
    const { signedCall, api } = await mountedRoutes(machineAuthority(enrollmentRow(key)))
    const response = await signedCall(key, "/acquire", { enrollmentId: "enr_1", hostId: "host_other" })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: "machine_body_invalid" } })
    expect(api.acquireHostServingGeneration).not.toHaveBeenCalled()
  })
})

describe("POST /redeem", () => {
  const redeemBody = (overrides: Record<string, unknown> = {}) => ({
    invitationId: "invitation_1",
    secret: "s3cr3t",
    hostId: "vps-1",
    publicKey: "{}",
    signature: "sig",
    ...overrides,
  })

  test("takes no auth, passes the invitation through and adds the host endpoints", async () => {
    const api = authority({
      redeemHostInvitation: vi.fn(async () => ({
        resumed: false,
        enrollment: { enrollment_id: "enr_9", host_id: "vps-1", expires_at: 1, last_seen_at: 1, created_at: 1 },
        owner_user_id: "usr_owner",
        owner_actor_id: "act_owner",
        org_id: "org_1",
        key_version: 1,
        serving_generation: 0,
        scope: { allowed_roots: ["/srv"], visibility: "owner", revision: 1 },
      })),
    })
    const { app } = await mountedRoutes(api, { relayUrl: "https://relay.test", sessionAuthorityUrl: "https://cp.test/sa" })
    const response = await app.request("http://control.test/api/claxedo/host/enrollments/redeem", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(redeemBody({ displayName: "VPS" })),
    })
    expect(response.status, await response.clone().text()).toBe(200)
    expect(api.redeemHostInvitation).toHaveBeenCalledWith({ ...redeemBody(), displayName: "VPS" })
    expect(await response.json()).toMatchObject({
      resumed: false,
      enrollment: { enrollment_id: "enr_9", host_id: "vps-1" },
      key_version: 1,
      org_id: "org_1",
      scope: { allowed_roots: ["/srv"], visibility: "owner", revision: 1 },
      relay: { url: "https://relay.test", jwks_url: "https://relay.test/.well-known/jwks.json" },
      authority: { session_authority_url: "https://cp.test/sa" },
    })
  })

  test("maps every invitation decision to its code and status, with the redeemed-by detail only where the plan allows it", async () => {
    for (const [code, status, details] of [
      ["invitation_invalid", 403, undefined],
      ["invitation_expired", 410, undefined],
      ["invitation_revoked", 410, undefined],
      ["invitation_redeemed", 409, { redeemed_host_id: "vps-0", redeemed_at: 5 }],
      ["invitation_host_conflict", 409, undefined],
      ["host_attestation_denied", 403, undefined],
    ] as const) {
      const { app } = await mountedRoutes(authority({
        redeemHostInvitation: vi.fn(async () => {
          throw new D1HostAccessAuthorityError(code, `refused: ${code}`, details)
        }),
      }))
      const response = await app.request("http://control.test/api/claxedo/host/enrollments/redeem", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(redeemBody()),
      })
      expect(response.status, code).toBe(status)
      expect(await response.json()).toEqual({ error: { code, message: `refused: ${code}`, ...details } })
    }
  })

  test("caps the body at 8 KiB, refuses an unknown field, and budgets 5 attempts a minute per invitation id", async () => {
    const api = authority({ redeemHostInvitation: vi.fn(async () => { throw new D1HostAccessAuthorityError("invitation_invalid", "no") }) })
    const { app } = await mountedRoutes(api, {
      clientRateLimiter: createFixedWindowConnectionRateLimiter({ limit: 1_000, windowMs: 60_000 }),
    })
    const post = (body: unknown) =>
      app.request("http://control.test/api/claxedo/host/enrollments/redeem", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    expect((await post(redeemBody({ publicKey: "x".repeat(9 * 1024) }))).status).toBe(413)
    expect((await post(redeemBody({ extra: 1 }))).status).toBe(400)
    const statuses: number[] = []
    for (let attempt = 0; attempt < 7; attempt += 1) statuses.push((await post(redeemBody({ secret: `guess-${attempt}` }))).status)
    expect(statuses).toEqual([403, 403, 403, 403, 403, 429, 429])
    // Another invitation id has its own budget.
    expect((await post(redeemBody({ invitationId: "invitation_2" }))).status).toBe(403)
    expect(api.redeemHostInvitation).toHaveBeenCalledTimes(6)
  })

  test("answers 501 without an invitation-capable authority", async () => {
    const { app } = await mountedRoutes(authority())
    const response = await app.request("http://control.test/api/claxedo/host/enrollments/redeem", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(redeemBody()),
    })
    expect(response.status).toBe(501)
  })
})

describe("PATCH /:id/scope and GET / machines", () => {
  test("scope PATCH is an owner account call carrying the roots and visibility", async () => {
    const { api, call } = routes({
      updateHostEnrollmentScope: vi.fn(async () => ({
        scope: { allowed_roots: ["/srv/web"], visibility: "owner", revision: 2 },
        retired_workspace_ids: ["ws_api"],
      })),
    })
    const response = await call("/enr_1/scope", {
      method: "PATCH",
      body: JSON.stringify({ allowed_roots: ["/srv/web"], visibility: "owner" }),
    })
    expect(response.status, await response.clone().text()).toBe(200)
    expect(api.updateHostEnrollmentScope).toHaveBeenCalledWith(expect.anything(), {
      enrollmentId: "enr_1",
      scope: { allowed_roots: ["/srv/web"], visibility: "owner" },
    })
    expect(await response.json()).toEqual({
      scope: { allowed_roots: ["/srv/web"], visibility: "owner", revision: 2 },
      retired_workspace_ids: ["ws_api"],
    })
    expect((await call("/enr_1/scope", { method: "PATCH", body: JSON.stringify({ visibility: "owner" }) })).status).toBe(400)
    expect((await call("/enr_1/scope", { method: "PATCH", headers: { authorization: "" }, body: "{}" })).status).toBe(401)
  })

  test("an unknown or foreign enrollment is 404 host_enrollment_not_found", async () => {
    const { call } = routes({
      updateHostEnrollmentScope: vi.fn(async () => {
        throw new D1HostAccessAuthorityError("host_enrollment_not_found", "Host enrollment not found")
      }),
    })
    const response = await call("/enr_x/scope", { method: "PATCH", body: JSON.stringify({ allowed_roots: [], visibility: "org" }) })
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: { code: "host_enrollment_not_found", message: "Host enrollment not found" } })
  })

  test("GET / keeps the desktop's single-row shape and adds machines, a paused one saying when", async () => {
    const machines = [
      { enrollment_id: "enr_1", host_id: "host_1", public_key_fingerprint: "fp", key_version: 1, enrolled_via: "account", last_seen_at: 1, expires_at: 9_999, serving_generation: 0, acked: [], scope: undefined },
      { enrollment_id: "enr_2", host_id: "host_2", public_key_fingerprint: "fp2", key_version: 1, enrolled_via: "invitation", last_seen_at: 1, expires_at: 9_999, serving_generation: 1, paused_at: 7, acked: [], scope: { allowed_roots: ["/srv"], visibility: "owner", revision: 1 } },
    ]
    const { call } = routes({ listHostEnrollments: vi.fn(async () => machines) })
    const response = await call("/", { method: "GET" })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      active: true,
      host_id: "host_1",
      enrollment_id: "enr_1",
      expires_at: 9_999,
      last_seen_at: 1,
      created_at: 1,
      machines: [{ ...machines[0], scope: undefined }, machines[1]],
    })
  })
})

describe("host invitations", () => {
  function invitationRoutes(overrides: Record<string, unknown> = {}) {
    const api = authority({
      createHostInvitation: vi.fn(async () => ({ invitationId: "invitation_1", token: "chx_inv_1.invitation_1.secret", expiresAt: 9_999 })),
      listHostInvitations: vi.fn(async () => [{ invitation_id: "invitation_1", scope: { allowed_roots: ["/srv"], visibility: "owner" }, org_id: "org_1", created_at: 1, expires_at: 9_999 }]),
      revokeHostInvitation: vi.fn(async () => ({ revoked: true })),
      ...overrides,
    })
    const services = { authority: api } as unknown as ControlPlaneServices
    const app = HostInvitationRoutes(services, { authConfig, verifier } as never)
    const call = (path: string, init: RequestInit = {}) =>
      app.request(`http://control.test${path}`, {
        headers: { authorization: "Bearer user_1", "content-type": "application/json", ...Object.fromEntries(new Headers(init.headers)) },
        ...init,
      })
    return { api, call }
  }

  test("creates an invitation for the signed owner and returns the one-time token", async () => {
    const { api, call } = invitationRoutes()
    const response = await call("/", {
      method: "POST",
      body: JSON.stringify({ scope: { allowed_roots: ["/srv"], visibility: "owner" }, displayName: "VPS", expiresInMs: 600_000 }),
    })
    expect(response.status, await response.clone().text()).toBe(200)
    expect(api.createHostInvitation).toHaveBeenCalledWith(expect.anything(), {
      scope: { allowed_roots: ["/srv"], visibility: "owner" },
      displayName: "VPS",
      expiresInMs: 600_000,
    })
    expect(await response.json()).toEqual({ invitation_id: "invitation_1", token: "chx_inv_1.invitation_1.secret", expires_at: 9_999 })
    expect(api.auditAllow).toHaveBeenCalledWith(expect.anything(), {
      action: "host_invitation.created",
      metadata: { invitationId: "invitation_1", expiresAt: 9_999 },
    })
    expect((await call("/", { method: "POST", body: JSON.stringify({ scope: { allowed_roots: ["/srv"] } }) })).status).toBe(400)
  })

  test("lists and revokes the owner's invitations, auditing a revocation that happened", async () => {
    const { api, call } = invitationRoutes()
    expect(await (await call("/", { method: "GET" })).json()).toEqual({
      invitations: [{ invitation_id: "invitation_1", scope: { allowed_roots: ["/srv"], visibility: "owner" }, org_id: "org_1", created_at: 1, expires_at: 9_999 }],
    })
    const revoked = await call("/invitation_1", { method: "DELETE" })
    expect(await revoked.json()).toEqual({ revoked: true })
    expect(api.revokeHostInvitation).toHaveBeenCalledWith(expect.anything(), { invitationId: "invitation_1" })
    expect(api.auditAllow).toHaveBeenCalledWith(expect.anything(), { action: "host_invitation.revoked", metadata: { invitationId: "invitation_1" } })
  })

  test("every invitation route requires a signed account, and creation shares the ten-a-minute row budget", async () => {
    const { api, call } = invitationRoutes()
    for (const [path, method] of [["/", "POST"], ["/", "GET"], ["/invitation_1", "DELETE"]] as const) {
      const response = await call(path, { method, headers: { authorization: "" }, ...(method === "POST" ? { body: "{}" } : {}) })
      expect(response.status, `${method} ${path}`).toBe(401)
    }
    const statuses: number[] = []
    for (let attempt = 0; attempt < 12; attempt += 1) {
      statuses.push((await call("/", { method: "POST", body: JSON.stringify({ scope: { allowed_roots: [], visibility: "org" } }) })).status)
    }
    expect(statuses.filter((status) => status === 200)).toHaveLength(10)
    expect(statuses.filter((status) => status === 429)).toHaveLength(2)
    expect(api.createHostInvitation).toHaveBeenCalledTimes(10)
  })
})

/** The routes mounted at their real prefix, so a signed pathname is the one the host signs. */
async function mountedRoutes(api: ReturnType<typeof authority>, routeOptions: Record<string, unknown> = {}) {
  const { Hono } = await import("hono")
  const services = { authority: api } as unknown as ControlPlaneServices
  const app = new Hono()
  app.route("/api/claxedo/host/enrollments", HostEnrollmentRoutes(services, { authConfig, verifier, now: () => NOW, ...routeOptions } as never))
  const signedCall = async (
    key: Awaited<ReturnType<typeof machineKey>>,
    path: string,
    body: unknown,
    options: { enrollmentId?: string; ts?: number; nonce?: string; headers?: Record<string, string>; tamper?: (text: string) => string } = {},
  ) => {
    const enrollmentId = options.enrollmentId ?? "enr_1"
    const ts = options.ts ?? NOW
    const nonce = options.nonce ?? `nonce_${Math.random().toString(36).slice(2).padEnd(16, "x")}`
    const bodyText = JSON.stringify(body)
    const signature = await key.sign(machineRequestPayload({
      method: "POST",
      pathname: `/api/claxedo/host/enrollments${path}`,
      bodySha256Hex: await sha256Hex(bodyText),
      ts,
      nonce,
      enrollmentId,
    }))
    return app.request(`http://control.test/api/claxedo/host/enrollments${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [MACHINE_REQUEST_HEADERS.enrollmentId]: enrollmentId,
        [MACHINE_REQUEST_HEADERS.ts]: String(ts),
        [MACHINE_REQUEST_HEADERS.nonce]: nonce,
        [MACHINE_REQUEST_HEADERS.signature]: signature,
        ...options.headers,
      },
      body: options.tamper ? options.tamper(bodyText) : bodyText,
    })
  }
  return { api, signedCall, app }
}
