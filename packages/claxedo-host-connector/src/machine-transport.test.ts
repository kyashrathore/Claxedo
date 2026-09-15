import { describe, expect, test } from "vitest"

import { transientHeartbeatFailure } from "./connector"
import { createFakeControlPlane, decodeFakeTunnelToken, enrollFakeHost } from "./fake-control-plane.test-support"
import { createHostKeyPair } from "./host-identity"
import { createMachineSignedTransport, decisionCode, HostedHttpError, HostedRequestTimeoutError } from "./machine-transport"

/**
 * The transport against a control plane that enforces P1.1. Each refusal
 * below is one the fake really issues — a transport that sent a stale
 * timestamp or reused a nonce would fail here, not on a real host.
 */

async function host(cp = createFakeControlPlane(), overrides: Partial<Parameters<typeof createMachineSignedTransport>[0]> = {}) {
  const enrolled = await enrollFakeHost(cp)
  const transport = createMachineSignedTransport({
    controlPlaneUrl: cp.url,
    keys: enrolled.keys,
    enrollmentId: enrolled.enrollmentId,
    hostId: enrolled.state.host_id,
    keyVersion: enrolled.state.enrollment?.key_version ?? 1,
    fetch: cp.fetch,
    ...overrides,
  })
  return { cp, enrolled, transport }
}

describe("acquire", () => {
  test("claims the next generation with the four machine headers and a body naming the enrollment", async () => {
    const { cp, enrolled, transport } = await host()

    expect(await transport.acquire()).toEqual({ generation: 1 })
    expect(await transport.acquire()).toEqual({ generation: 2 })

    const request = cp.log.find((entry) => entry.path === "/api/claxedo/host/enrollments/acquire")
    expect(request?.headers).toMatchObject({
      "x-claxedo-enrollment-id": enrolled.enrollmentId,
      "x-claxedo-host-ts": expect.stringMatching(/^\d+$/),
      "x-claxedo-host-nonce": expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      "x-claxedo-host-signature": expect.stringMatching(/^[A-Za-z0-9_-]+$/),
    })
    expect(request?.body).toEqual({ enrollmentId: enrolled.enrollmentId, hostId: enrolled.state.host_id, keyVersion: 1 })
  })
})

describe("refusals surface as HOSTED_HTTP decisions", () => {
  test("a reused nonce", async () => {
    const { transport } = await host(undefined, { nonce: () => "fixedfixedfixedfixed" })
    await transport.acquire()

    const error = await transport.acquire().catch((e: unknown) => e)

    expect(error).toBeInstanceOf(HostedHttpError)
    expect(String(error)).toMatch(/^HostedHttpError: HOSTED_HTTP 401 /)
    expect(decisionCode(error)).toBe("machine_nonce_replayed")
    expect(transientHeartbeatFailure(error)).toBe(false)
  })

  test("a timestamp more than 60 s off the control plane's clock", async () => {
    const { transport } = await host(undefined, { now: () => Date.now() - 61_000 })

    const error = await transport.acquire().catch((e: unknown) => e)

    expect(decisionCode(error)).toBe("machine_timestamp_skew")
    expect(String(error)).toContain("HOSTED_HTTP 401")
  })

  test("a signature by a different key, and an enrollment id the control plane does not know, are one and the same 401", async () => {
    const other = await createHostKeyPair()
    const { transport } = await host(undefined, { keys: other })
    const wrongKey = await transport.acquire().catch((e: unknown) => e)
    const { transport: unknown } = await host(undefined, { enrollmentId: "enr_nobody" })
    const unknownRow = await unknown.acquire().catch((e: unknown) => e)

    expect(decisionCode(wrongKey)).toBe("machine_request_denied")
    expect(decisionCode(unknownRow)).toBe("machine_request_denied")
    expect(String(wrongKey)).toContain("HOSTED_HTTP 401")
    expect(transientHeartbeatFailure(wrongKey)).toBe(false)
  })

  test("a paused enrollment is a 403 decision the verified caller is told about", async () => {
    const { cp, enrolled, transport } = await host()
    cp.pause(enrolled.enrollmentId, true)

    const error = await transport.acquire().catch((e: unknown) => e)

    expect(decisionCode(error)).toBe("enrollment_paused")
    expect(String(error)).toContain("HOSTED_HTTP 403")
    expect(transientHeartbeatFailure(error)).toBe(false)
  })

  test("a key version the control plane has moved past", async () => {
    const { transport } = await host(undefined, { keyVersion: 2 })

    const error = await transport.acquire().catch((e: unknown) => e)

    expect(decisionCode(error)).toBe("enrollment_key_version_mismatch")
    expect(String(error)).toContain("HOSTED_HTTP 403")
  })

  test("a beat from a superseded generation, or one the control plane has not issued", async () => {
    const { transport } = await host()
    const { generation } = await transport.acquire()
    await transport.acquire()

    const error = await transport.heartbeat({ generation, acks: [] }).catch((e: unknown) => e)
    const ahead = await transport.heartbeat({ generation: generation + 5, acks: [] }).catch((e: unknown) => e)

    expect(decisionCode(error)).toBe("enrollment_generation_superseded")
    expect(String(error)).toContain("HOSTED_HTTP 409")
    expect(transientHeartbeatFailure(error)).toBe(false)
    expect(decisionCode(ahead)).toBe("invalid_input")
    expect(String(ahead)).toContain("HOSTED_HTTP 400")
  })

  test("a revoked enrollment", async () => {
    const { cp, enrolled, transport } = await host()
    cp.revoke(enrolled.enrollmentId)

    expect(decisionCode(await transport.acquire().catch((e: unknown) => e))).toBe("enrollment_revoked")
  })

  test("a control plane that never answers is abandoned at the deadline as a transport failure", async () => {
    const answered: Array<() => void> = []
    const { transport } = await host(undefined, {
      requestTimeoutMs: 20,
      fetch: (_url, init) =>
        new Promise((resolve) => {
          // A fetch that ignores its signal, so the transport's own deadline is what returns.
          answered.push(() => resolve(new Response("{}", { status: 200 })))
          expect(init.signal).toBeInstanceOf(AbortSignal)
        }),
    })

    const error = await transport.acquire().catch((e: unknown) => e)

    expect(error).toBeInstanceOf(HostedRequestTimeoutError)
    expect(String(error)).toContain("did not answer POST /api/claxedo/host/enrollments/acquire within 0.02s")
    expect(transientHeartbeatFailure(error)).toBe(true)
    expect(decisionCode(error)).toBeUndefined()
    answered.forEach((answer) => answer())
  })

  test("a body that never finishes is bounded by the same deadline", async () => {
    const { transport } = await host(undefined, {
      requestTimeoutMs: 20,
      fetch: async () => new Response(new ReadableStream({ start: () => undefined }), { status: 200 }),
    })

    await expect(transport.acquire()).rejects.toBeInstanceOf(HostedRequestTimeoutError)
  })

  test("a control plane mid-deploy is a disruption, not a decision", async () => {
    const { cp, transport } = await host()
    cp.faults.unavailable = 503

    const error = await transport.acquire().catch((e: unknown) => e)

    expect(String(error)).toContain("HOSTED_HTTP 503")
    expect(transientHeartbeatFailure(error)).toBe(true)
  })
})

describe("heartbeat", () => {
  test("sends body v3 and decodes the control plane's snake_case answer", async () => {
    const { cp, enrolled, transport } = await host()
    const { generation } = await transport.acquire()
    const revision = cp.assign({
      enrollmentId: enrolled.enrollmentId,
      workspaceId: "ws_1",
      remoteDirectory: "/srv/api",
      displayName: "API",
    })

    const first = await transport.heartbeat({ generation, acks: [], ttlMs: 30_000, sessionAuthority: "managed-private" })

    const beat = cp.log.at(-1)
    expect(beat?.body).toEqual({
      enrollmentId: enrolled.enrollmentId,
      hostId: enrolled.state.host_id,
      keyVersion: 1,
      generation,
      acks: [],
      ttlMs: 30_000,
      sessionAuthority: "managed-private",
    })
    expect(first).toMatchObject({
      expires_at: expect.any(Number),
      assignments: [{ workspaceId: "ws_1", remoteDirectory: "/srv/api", displayName: "API", revision }],
      scope: { revision: 1, allowed_roots: ["/srv"], visibility: "owner" },
      relay: { url: cp.relayUrl, jwksUrl: `${cp.relayUrl}/.well-known/jwks.json` },
      authority: { sessionAuthorityUrl: `${cp.url}/api/runtime-authority/session-authorize` },
      assigned_workspace_ids: ["ws_1"],
    })
    expect(first.hostTunnel, "nothing acked yet, so nothing is routable").toBeUndefined()

    const acked = await transport.heartbeat({ generation, acks: [{ workspaceId: "ws_1", revision }] })

    expect(acked.hostTunnel).toMatchObject({ hostId: enrolled.state.host_id, workspaceIds: ["ws_1"], relayUrl: cp.relayUrl })
    expect(decodeFakeTunnelToken(String(acked.hostTunnel?.hostTunnelToken))).toEqual({
      workspace_ids: ["ws_1"],
      enrollment_id: enrolled.enrollmentId,
      generation,
    })
  })

  test("a stale ack revision earns no credential", async () => {
    const { cp, enrolled, transport } = await host()
    const { generation } = await transport.acquire()
    cp.assign({ enrollmentId: enrolled.enrollmentId, workspaceId: "ws_1", remoteDirectory: "/srv/api" })
    cp.assign({ enrollmentId: enrolled.enrollmentId, workspaceId: "ws_1", remoteDirectory: "/srv/api-v2" })

    const result = await transport.heartbeat({ generation, acks: [{ workspaceId: "ws_1", revision: 1 }] })

    expect(result.hostTunnel).toBeUndefined()
    expect(cp.routable(enrolled.enrollmentId)).toEqual([])
    expect(result.assignments).toEqual([{ workspaceId: "ws_1", remoteDirectory: "/srv/api-v2", revision: 2 }])
  })

  test("every request carries a fresh nonce and timestamp", async () => {
    const { cp, transport } = await host()
    const { generation } = await transport.acquire()
    await transport.heartbeat({ generation, acks: [] })
    await transport.heartbeat({ generation, acks: [] })

    const nonces = cp.log.filter((entry) => entry.headers["x-claxedo-host-nonce"]).map((entry) => entry.headers["x-claxedo-host-nonce"])
    expect(new Set(nonces).size).toBe(nonces.length)
  })
})

test("createRequest and enroll are not part of a machine's protocol", async () => {
  const { transport } = await host()

  await expect(transport.createRequest({ hostId: "h" })).rejects.toThrow(/already enrolled/)
  await expect(
    transport.enroll({ hostId: "h", publicKey: "{}", requestId: "r", signature: "s" }),
  ).rejects.toThrow(/already enrolled/)
})
