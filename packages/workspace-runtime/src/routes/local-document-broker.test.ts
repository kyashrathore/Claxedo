import { exportSPKI, generateKeyPair, SignJWT } from "jose"
import { afterEach, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"
import { LocalDocumentBrokerRoutes } from "./local-document-broker"

describe("local document broker relay bounds", () => {
  const originalFetch = globalThis.fetch
  const originalPublicKey = process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM

  afterEach(() => {
    globalThis.fetch = originalFetch
    if (originalPublicKey === undefined) delete process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM
    else process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM = originalPublicKey
  })

  test("bounds a never-resolving activation request and propagates cancellation", async () => {
    const fixture = await brokerFixture()
    const signals: AbortSignal[] = []
    globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.signal) signals.push(init.signal)
      return await new Promise<Response>(() => undefined)
    }) as typeof fetch

    const response = await fixture.app.request("/api/wr/local-documents/broker", fixture.request)
    expect(response.status).toBe(500)
    expect(signals).toHaveLength(2)
    expect(signals.every((signal) => signal.aborted)).toBe(true)
    expect(signals[0]).not.toBe(signals[1])
  })

  test("caps declared activation errors and chunked document responses", async () => {
    const fixture = await brokerFixture()
    for (const responses of [
      [new Response("too large", { status: 503, headers: { "content-length": "256" } })],
      [Response.json({ active: true }), streamedResponse(["x".repeat(128)])],
    ]) {
      globalThis.fetch = mock(async () => responses.shift() ?? Response.json({ revoked: true })) as typeof fetch
      const response = await fixture.app.request("/api/wr/local-documents/broker", fixture.request)
      expect(response.status).toBe(500)
    }
  })

  test("uses an independent deadline when revoke cleanup never resolves", async () => {
    const fixture = await brokerFixture({ requestTimeoutMs: 1_000, revokeTimeoutMs: 10 })
    const signals: AbortSignal[] = []
    let call = 0
    globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.signal) signals.push(init.signal)
      call++
      if (call === 1) return Response.json({ active: true })
      if (call === 2) return Response.json({ read: { markdown: "ok", version: "v1", modifiedAt: 1 } })
      return await new Promise<Response>(() => undefined)
    }) as typeof fetch

    const response = await fixture.app.request("/api/wr/local-documents/broker", fixture.request)
    expect(response.status).toBe(200)
    expect(signals).toHaveLength(3)
    expect(signals[2]?.aborted).toBe(true)
    expect(signals[2]).not.toBe(signals[1])
  })
})

async function brokerFixture(options: { requestTimeoutMs?: number; revokeTimeoutMs?: number } = {}) {
  const key = await generateKeyPair("EdDSA", { extractable: true })
  process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM = await exportSPKI(key.publicKey)
  const input = {
    userId: "user_1",
    orgId: "org_1",
    projectId: "project_1",
    localWorkspaceId: "local_ws",
    cloudWorkspaceId: "cloud_ws",
    sessionId: "session_1",
    documentId: "document_1",
    operation: "read",
  }
  const token = await new SignJWT({
    user_id: input.userId,
    org_id: input.orgId,
    project_id: input.projectId,
    local_workspace_id: input.localWorkspaceId,
    cloud_workspace_id: input.cloudWorkspaceId,
    session_id: input.sessionId,
    document_id: input.documentId,
    operations: [input.operation],
    job_exp: Math.floor(Date.now() / 1000) + 300,
  })
    .setProtectedHeader({ alg: "EdDSA" })
    .setIssuer("claxedo-control-plane")
    .setAudience("document-relay-job")
    .setSubject(input.userId)
    .setJti("job_1")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(key.privateKey)
  const app = new Hono().route("/", LocalDocumentBrokerRoutes({
    trustedTransport: true,
    installationToken: "installation-secret",
    localControlPlaneUrl: "http://local.test",
    requestTimeoutMs: 10,
    revokeTimeoutMs: 10,
    maxResponseBytes: 64,
    ...options,
  }))
  return {
    app,
    request: {
      method: "POST",
      headers: { "content-type": "application/json", "x-claxedo-document-capability": token },
      body: JSON.stringify(input),
    },
  }
}

function streamedResponse(chunks: string[], status = 200) {
  return new Response(new ReadableStream({
    start(controller) {
      chunks.forEach((chunk) => controller.enqueue(new TextEncoder().encode(chunk)))
      controller.close()
    },
  }), { status })
}
