import { describe, expect, test } from "vitest"

import { transientHeartbeatFailure } from "./connector"
import { createFakeControlPlane, enrollFakeHost } from "./fake-control-plane.test-support"
import { createHostKeyPair } from "./host-identity"
import { createMachineSignedTransport, decisionCode, HostedHttpError } from "./machine-transport"

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

  test("a signature by a different key", async () => {
    const other = await createHostKeyPair()
    const { transport } = await host(undefined, { keys: other })

    expect(decisionCode(await transport.acquire().catch((e: unknown) => e))).toBe("machine_signature_invalid")
  })

  test("a key version the control plane has moved past", async () => {
    const { transport } = await host(undefined, { keyVersion: 2 })

    const error = await transport.acquire().catch((e: unknown) => e)

    expect(decisionCode(error)).toBe("enrollment_key_version_mismatch")
    expect(String(error)).toContain("HOSTED_HTTP 403")
  })

  test("a beat from a superseded generation", async () => {
    const { transport } = await host()
    const { generation } = await transport.acquire()
    await transport.acquire()

    const error = await transport.heartbeat({ generation, acks: [] }).catch((e: unknown) => e)

    expect(decisionCode(error)).toBe("enrollment_generation_superseded")
    expect(String(error)).toContain("HOSTED_HTTP 409")
    expect(transientHeartbeatFailure(error)).toBe(false)
  })

  test("a revoked enrollment", async () => {
    const { cp, enrolled, transport } = await host()
    cp.revoke(enrolled.enrollmentId)

    expect(decisionCode(await transport.acquire().catch((e: unknown) => e))).toBe("enrollment_revoked")
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
      relay: { url: `${cp.url}/relay`, jwksUrl: `${cp.url}/relay/jwks` },
      authority: { sessionAuthorityUrl: `${cp.url}/api/runtime-authority` },
      assigned_workspace_ids: ["ws_1"],
    })
    expect(first.hostTunnel, "nothing acked yet, so nothing is routable").toBeUndefined()

    const acked = await transport.heartbeat({ generation, acks: [{ workspaceId: "ws_1", revision }] })

    expect(acked.hostTunnel).toMatchObject({ workspace_ids: ["ws_1"] })
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
