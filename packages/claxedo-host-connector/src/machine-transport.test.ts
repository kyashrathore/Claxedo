import { describe, expect, test } from "vitest"

import { transientHeartbeatFailure } from "./connector"
import { createFakeControlPlane, decodeFakeTunnelToken, enrollFakeHost } from "./fake-control-plane.test-support"
import { createHostKeyPair } from "./host-identity"
import { createMachineSealingKeyPair } from "./machine-seal"
import { ControlPlaneUrlError, HostEndpointUrlError } from "./host-state"
import {
  createMachineSignedTransport,
  decisionCode,
  decodeEndpoints,
  decodeProviderConfig,
  HostedHttpError,
  HostedRedirectError,
  HostedRequestTimeoutError,
} from "./machine-transport"

/**
 * The transport against a control plane that enforces the machine-request
 * signature contract. Each refusal below is one the fake really issues — a transport that sent a stale
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

describe("the endpoint a machine request may reach", () => {
  test("a cleartext control plane never gets a transport, let alone a signed request", async () => {
    const cp = createFakeControlPlane()
    const enrolled = await enrollFakeHost(cp)
    const sent: URL[] = []

    expect(() =>
      createMachineSignedTransport({
        controlPlaneUrl: "http://control-plane.test",
        keys: enrolled.keys,
        enrollmentId: enrolled.enrollmentId,
        hostId: enrolled.state.host_id,
        fetch: async (url, init) => {
          sent.push(url)
          return await cp.fetch(url, init)
        },
      }),
    ).toThrow(ControlPlaneUrlError)
    expect(sent, "the refusal is at construction, before anything is signed").toEqual([])
  })

  test("a loopback control plane over http is the one cleartext case, and it works", async () => {
    const cp = createFakeControlPlane({ url: "http://127.0.0.1:2593" })
    const { transport } = await host(cp)

    expect(await transport.acquire()).toEqual({ generation: 1 })
    expect(cp.log.at(-1)?.path).toBe("/api/claxedo/host/enrollments/acquire")
  })

  test("a base written with a trailing slash signs and sends the same path", async () => {
    const cp = createFakeControlPlane()
    const { transport } = await host(cp, { controlPlaneUrl: `${cp.url}/` })

    // The fake verifies the signature over the pathname it received, so a
    // canonicalization that moved the path would fail here as a denial.
    expect(await transport.acquire()).toEqual({ generation: 1 })
    expect(cp.log.at(-1)?.path).toBe("/api/claxedo/host/enrollments/acquire")
  })
})

describe("a redirected machine request", () => {
  const redirect = (status: number) =>
    new Response(null, { status, headers: { location: "https://attacker.test/api/claxedo/host/enrollments/acquire" } })

  test("asks fetch not to follow, and refuses the 3xx rather than re-sending the signed body", async () => {
    const seen: Array<{ url: URL; redirect: RequestInit["redirect"] }> = []
    const { transport } = await host(undefined, {
      fetch: async (url, init) => {
        seen.push({ url, redirect: init.redirect })
        return redirect(307)
      },
    })

    const error = await transport.acquire().catch((e: unknown) => e)

    expect(error).toBeInstanceOf(HostedRedirectError)
    expect(String(error)).toContain("with a redirect (307)")
    expect(seen).toHaveLength(1)
    expect(seen[0]?.redirect, "the transport hands fetch the option that stops the follow").toBe("manual")
    expect(seen[0]?.url.host).toBe("control-plane.test")
  })

  test.each([301, 302, 303, 307, 308])("%s is refused the same way", async (status) => {
    const { transport } = await host(undefined, { fetch: async () => redirect(status) })

    await expect(transport.heartbeat({ generation: 1, acks: [] })).rejects.toBeInstanceOf(HostedRedirectError)
  })

  test("a same-origin location carrying a credential is refused before anything is sent to it", async () => {
    // Same origin, so nothing about the address is suspect — what makes this
    // one a refusal is that following it would put a code and a token in a
    // request line, where they reach logs and referrers. The stub records
    // every call, so the second request is absent rather than merely unread.
    const seen: URL[] = []
    const cp = createFakeControlPlane()
    const { transport } = await host(cp, {
      fetch: async (url) => {
        seen.push(url)
        return new Response(null, {
          status: 302,
          headers: { location: `${url.origin}${url.pathname}?code=abc&access_token=ghu_secret` },
        })
      },
    })

    await expect(transport.acquire()).rejects.toBeInstanceOf(HostedRedirectError)
    expect(seen.map((url) => url.href)).toEqual([`${cp.url}/api/claxedo/host/enrollments/acquire`])
  })

  test("a fetch that ignored the option and followed anyway is denied on the answer", async () => {
    // The attacker's 200, indistinguishable from the control plane's but for
    // having been redirected to. A transport that trusted it would apply the
    // scope, assignments and relay endpoints in this body.
    const followed = Response.json({ expires_at: 1, scope: { revision: 99, allowed_roots: ["/"], visibility: "owner" } })
    Object.defineProperty(followed, "redirected", { value: true })
    const { transport } = await host(undefined, { fetch: async () => followed })

    const error = await transport.heartbeat({ generation: 1, acks: [] }).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(HostedRedirectError)
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
  test("sends the signed beat body and decodes the control plane's snake_case answer", async () => {
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
    expect(beat?.body.sealingPublicKey, "a caller that declared no sealing key sends no field").toBeUndefined()
    expect(beat?.body.providerConfigRevision, "nor a revision it does not hold").toBeUndefined()
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

describe("the endpoints a control-plane body delivers", () => {
  test("separate secure service origins are approved: wss relay, https JWKS and authority on other hosts", () => {
    expect(
      decodeEndpoints({
        relay: { url: "wss://relay.example.test", jwks_url: "https://keys.example.test/.well-known/jwks.json" },
        authority: { session_authority_url: "https://authority.example.test/api/runtime-authority/session-authorize" },
      }),
    ).toEqual({
      relay: { url: "wss://relay.example.test", jwksUrl: "https://keys.example.test/.well-known/jwks.json" },
      authority: { sessionAuthorityUrl: "https://authority.example.test/api/runtime-authority/session-authorize" },
    })
  })

  test("cleartext is admitted for the exact loopback names only", () => {
    expect(
      decodeEndpoints({
        relay: { url: "http://127.0.0.1:4100", jwks_url: "http://127.0.0.1:4100/.well-known/jwks.json" },
        authority: { session_authority_url: "http://[::1]:2593/api/runtime-authority/session-authorize" },
      }),
    ).toEqual({
      relay: { url: "http://127.0.0.1:4100", jwksUrl: "http://127.0.0.1:4100/.well-known/jwks.json" },
      authority: { sessionAuthorityUrl: "http://[::1]:2593/api/runtime-authority/session-authorize" },
    })
    expect(decodeEndpoints({ relay: { url: "ws://localhost:4100", jwks_url: "https://k.test/j" } }).relay?.url).toBe(
      "ws://localhost:4100",
    )
  })

  test.each([
    ["ws://attacker.test", /wss:\/\/ or https/],
    ["http://relay.internal", /wss:\/\/ or https/],
    ["file:///etc/passwd", /wss:\/\/ or https/],
    ["javascript:fetch(1)", /wss:\/\/ or https/],
    ["wss://user:pass@relay.test", /no user or password/],
    ["wss://relay.test/?x=1", /no query or fragment/],
  ])("a heartbeat naming relay.url %s is refused with the field", (url, message) => {
    expect(() => decodeEndpoints({ relay: { url, jwks_url: "https://k.test/jwks.json" } })).toThrow(HostEndpointUrlError)
    expect(() => decodeEndpoints({ relay: { url, jwks_url: "https://k.test/jwks.json" } })).toThrow(message)
    expect(() => decodeEndpoints({ relay: { url, jwks_url: "https://k.test/jwks.json" } })).toThrow(/relay\.url/)
  })

  test.each([
    ["http://attacker.test/jwks.json", /must be https/],
    ["file:///etc/relay/jwks.json", /must be https/],
    ["https://user@keys.test/jwks.json", /no user or password/],
    ["https://keys.test/jwks.json#frag", /no query or fragment/],
  ])("a substituted JWKS address %s is refused", (jwksUrl, message) => {
    expect(() => decodeEndpoints({ relay: { url: "https://relay.test", jwks_url: jwksUrl } })).toThrow(HostEndpointUrlError)
    expect(() => decodeEndpoints({ relay: { url: "https://relay.test", jwks_url: jwksUrl } })).toThrow(message)
    expect(() => decodeEndpoints({ relay: { url: "https://relay.test", jwks_url: jwksUrl } })).toThrow(/relay\.jwks_url/)
  })

  test("a session-authority address on a non-https scheme is refused", () => {
    for (const url of ["http://authority.internal/a", "file:///etc/a", "javascript:fetch(1)"]) {
      expect(() => decodeEndpoints({ authority: { session_authority_url: url } })).toThrow(HostEndpointUrlError)
      expect(() => decodeEndpoints({ authority: { session_authority_url: url } })).toThrow(/authority\.session_authority_url/)
    }
  })

  test("a beat that carries an undialable relay fails rather than storing it", async () => {
    const cp = createFakeControlPlane()
    const { transport } = await host(cp, {
      fetch: async (url, init) => {
        const answer = await cp.fetch(url, init)
        if (!url.pathname.endsWith("/heartbeat") || !answer.ok) return answer
        const body: Record<string, unknown> = await answer.json()
        const relay = body.relay as Record<string, unknown>
        return Response.json({ ...body, relay: { ...relay, url: "ws://attacker.test" } })
      },
    })
    const { generation } = await transport.acquire()

    const error = await transport.heartbeat({ generation, acks: [] }).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(HostEndpointUrlError)
    expect(String(error)).toContain("relay.url")
    // A decode refusal is not an HTTP decision: the lease stays live and the
    // next beat retries, so a control plane that fixes its config recovers.
    expect(transientHeartbeatFailure(error)).toBe(true)
  })

  test("a redeem answer carrying an undialable relay refuses the enrollment the same way", async () => {
    const cp = createFakeControlPlane({ relayUrl: "file:///etc/passwd" })

    const error = await enrollFakeHost(cp).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(HostEndpointUrlError)
    expect(String(error)).toContain("relay.url")
  })

  test("a JWKS address swapped onto another origin mid-flight fails the beat", async () => {
    const cp = createFakeControlPlane()
    const { transport } = await host(cp, {
      fetch: async (url, init) => {
        const answer = await cp.fetch(url, init)
        if (!url.pathname.endsWith("/heartbeat") || !answer.ok) return answer
        const body: Record<string, unknown> = await answer.json()
        const relay = body.relay as Record<string, unknown>
        return Response.json({ ...body, relay: { ...relay, jwks_url: "http://attacker.test/jwks.json" } })
      },
    })
    const { generation } = await transport.acquire()

    const error = await transport.heartbeat({ generation, acks: [] }).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(HostEndpointUrlError)
    expect(String(error)).toContain("relay.jwks_url")
    expect(String(error)).toContain("must be https")
  })

  test("a loopback cleartext relay beats normally", async () => {
    const cp = createFakeControlPlane({ relayUrl: "http://127.0.0.1:4100" })
    const { transport } = await host(cp)
    const { generation } = await transport.acquire()

    const beat = await transport.heartbeat({ generation, acks: [] })

    expect(beat.relay).toEqual({ url: "http://127.0.0.1:4100", jwksUrl: "http://127.0.0.1:4100/.well-known/jwks.json" })
  })
})

describe("the provider-config revision on the wire", () => {
  test("the declared key and held revision are sent, and the answer's snake_case member is decoded", async () => {
    const { cp, enrolled, transport } = await host()
    const sealing = await createMachineSealingKeyPair()
    const { generation } = await transport.acquire()
    await transport.heartbeat({ generation, acks: [], sealingPublicKey: sealing.publicKey })
    expect(cp.sealingPublicKey(enrolled.enrollmentId)).toBe(sealing.publicKey)

    const revision = await cp.pushProviderConfig(enrolled.enrollmentId, "the sealed payload")
    const answer = await transport.heartbeat({ generation, acks: [], sealingPublicKey: sealing.publicKey })
    expect(answer.providerConfig?.revision).toBe(revision)
    expect(answer.providerConfig?.sealed).toEqual(expect.stringContaining("mseal1."))

    const held = await transport.heartbeat({
      generation,
      acks: [],
      sealingPublicKey: sealing.publicKey,
      providerConfigRevision: revision,
    })
    expect(cp.log.at(-1)?.body.providerConfigRevision).toBe(revision)
    expect(held.providerConfig, "a revision the machine holds is not restated").toBeUndefined()
  })

  test("a withdrawal decodes as a revision with a null blob", () => {
    expect(decodeProviderConfig({ revision: 3, sealed: null })).toEqual({ revision: 3, sealed: null })
  })

  test("a revision whose blob is unreadable is refused rather than read as a withdrawal", () => {
    expect(() => decodeProviderConfig({ revision: 3, sealed: 12 })).toThrow("malformed provider configuration")
    expect(() => decodeProviderConfig({ revision: 3, sealed: "" })).toThrow("malformed provider configuration")
  })

  test("a revision with no number names the field", () => {
    expect(() => decodeProviderConfig({ sealed: "mseal1.a.b.c" })).toThrow("providerConfig.revision")
  })

  test("an ack carrying no provider configuration decodes to none", () => {
    expect(decodeProviderConfig(undefined)).toBeUndefined()
  })
})
