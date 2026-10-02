import { describe, expect, test } from "bun:test"
import { decodeProtectedHeader, exportPKCS8, exportSPKI, generateKeyPair } from "jose"
import worker, {
  WorkspaceRelayRoom,
  workspaceRelayDurableObjectOptions,
  workspaceRelayWorkerResolverClient,
  workspaceRelayWorkerResolverUrl,
  type WorkspaceRelayWorkerEnv,
} from "./worker"
import { deriveRelayHostKid, mintRuntimeAccessToken, verifyRelayHostToken } from "./auth"
import { createWorkspaceRelayDurableObjectRoom, type WorkspaceRelayDurableObjectNamespace } from "./cloudflare"

function namespace() {
  const routed: Array<{ id: string; request: Request }> = []
  const binding: WorkspaceRelayDurableObjectNamespace = {
    idFromName: (name) => name,
    get: (id) => ({
      fetch: async (request) => {
        routed.push({ id: String(id), request })
        return Response.json({ ok: true, id: String(id), path: new URL(request.url).pathname })
      },
    }),
  }
  return { binding, routed }
}

describe("workspace relay Cloudflare Worker entrypoint", () => {
  test("derives the internal relay resolver URL from the central URL", () => {
    expect(workspaceRelayWorkerResolverUrl({
      CLAXEDO_CENTRAL_URL: "https://central.test/",
    })).toBe("https://central.test/internal/relay")
  })

  test("prefers an explicit relay resolver URL", () => {
    expect(workspaceRelayWorkerResolverUrl({
      CLAXEDO_CENTRAL_URL: "https://central.test",
      CLAXEDO_RELAY_RESOLVER_URL: "https://resolver.test/internal/relay/",
    })).toBe("https://resolver.test/internal/relay")
  })

  test("routes workspace requests through the configured Durable Object namespace", async () => {
    const { binding, routed } = namespace()
    const res = await worker.fetch(
      new Request("https://relay.test/workspaces/ws_1/api/wr/health"),
      { WORKSPACE_RELAY_ROOM: binding } satisfies WorkspaceRelayWorkerEnv,
    )

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      id: "workspace:ws_1",
      path: "/workspaces/ws_1/api/wr/health",
    })
    expect(routed.map((item) => item.id)).toEqual(["workspace:ws_1"])
  })

  test("resolver client calls target and revocation endpoints with the relay bearer token", async () => {
    const requests: Request[] = []
    const client = workspaceRelayWorkerResolverClient({
      CLAXEDO_RELAY_RESOLVER_URL: "https://central.test/internal/relay",
      CLAXEDO_RELAY_RESOLVER_TOKEN: "resolver-token",
    }, async (url, init) => {
      const request = new Request(url, init)
      requests.push(request)
      if (new URL(request.url).pathname.endsWith("/target")) {
        return Response.json({
          workspaceId: "ws_1",
          hostId: "host_1",
          baseUrl: "https://runtime.test",
          backing: "cloud-vm",
        })
      }
      return Response.json({ active: true })
    })

    await expect(client.target("ws_1", "host_1")).resolves.toMatchObject({
      baseUrl: "https://runtime.test",
      backing: "cloud-vm",
    })
    await expect(client.revocation({ jti: "jti_1", workspaceId: "ws_1", hostId: "host_1" })).resolves.toEqual({ active: true })
    expect(requests.map((request) => request.headers.get("authorization"))).toEqual([
      "Bearer resolver-token",
      "Bearer resolver-token",
    ])
  })

  test("resolver client revalidates targets and caches revocation responses", async () => {
    const requests: Request[] = []
    const client = workspaceRelayWorkerResolverClient({
      CLAXEDO_RELAY_RESOLVER_URL: "https://central.test/internal/relay",
      CLAXEDO_RELAY_RESOLVER_TOKEN: "resolver-token",
      CLAXEDO_RELAY_REVOCATION_CACHE_TTL_MS: "10000",
    }, async (url, init) => {
      const request = new Request(url, init)
      requests.push(request)
      if (new URL(request.url).pathname.endsWith("/target")) {
        return Response.json({
          workspaceId: "ws_1",
          hostId: "host_1",
          baseUrl: "https://runtime.test",
          backing: "cloud-vm",
        })
      }
      return Response.json({ active: true })
    })

    await client.target("ws_1", "host_1")
    await client.target("ws_1", "host_1")
    await client.revocation({ jti: "jti_1", workspaceId: "ws_1", hostId: "host_1" })
    await client.revocation({ jti: "jti_1", workspaceId: "ws_1", hostId: "host_1" })

    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/internal/relay/target",
      "/internal/relay/target",
      "/internal/relay/revocation",
    ])
  })

  test("resolver client derives the host-generation lookup from the resolver base", async () => {
    const requests: Request[] = []
    let response = () => Response.json({ enrollmentId: "enr_1", generation: 2, revoked: false })
    const client = workspaceRelayWorkerResolverClient({
      CLAXEDO_CENTRAL_URL: "https://central.test",
      CLAXEDO_RELAY_RESOLVER_TOKEN: "resolver-token",
      CLAXEDO_RELAY_HOST_GENERATION_CACHE_TTL_MS: "10000",
    }, async (url, init) => {
      const request = new Request(url, init)
      requests.push(request)
      return response()
    })
    await expect(client.hostGeneration({ enrollmentId: "enr_1", generation: 2 }))
      .resolves.toEqual({ enrollmentId: "enr_1", generation: 2, revoked: false })
    // Cached: equal generation, inside the TTL.
    await expect(client.hostGeneration({ enrollmentId: "enr_1", generation: 2 }))
      .resolves.toEqual({ enrollmentId: "enr_1", generation: 2, revoked: false })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe("https://central.test/internal/relay/host-generation?enrollmentId=enr_1")
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer resolver-token")
    expect(requests[0]?.signal).toBeInstanceOf(AbortSignal)

    response = () => Response.json({ error: { code: "relay_resolver_enrollment_not_found", message: "Enrollment not found" } }, { status: 404 })
    await expect(client.hostGeneration({ enrollmentId: "enr_2", generation: 1 })).resolves.toBeUndefined()
    response = () => new Response("404 Not Found", { status: 404 })
    await expect(client.hostGeneration({ enrollmentId: "enr_3", generation: 1 }))
      .rejects.toThrow("relay host-generation resolver failed: 404 (no host-generation route at https://central.test/internal/relay/host-generation)")
    response = () => new Response("", { status: 503 })
    await expect(client.hostGeneration({ enrollmentId: "enr_4", generation: 1 }))
      .rejects.toThrow("relay host-generation resolver failed: 503")
  })

  test("resolver client prefers an explicit host-generation URL over the derived one", async () => {
    const requests: Request[] = []
    const client = workspaceRelayWorkerResolverClient({
      CLAXEDO_RELAY_RESOLVER_URL: "https://central.test/internal/relay",
      CLAXEDO_RELAY_RESOLVER_TOKEN: "resolver-token",
      CLAXEDO_RELAY_HOST_GENERATION_URL: "https://other.test/host-generation",
    }, async (url, init) => {
      requests.push(new Request(url, init))
      return Response.json({ enrollmentId: "enr_1", generation: 2, revoked: false })
    })
    await client.hostGeneration({ enrollmentId: "enr_1", generation: 2 })
    expect(requests.map((request) => request.url)).toEqual(["https://other.test/host-generation?enrollmentId=enr_1"])
  })

  test("a room whose first boot fails boots on the next request once the env is repaired", async () => {
    const runtime = await generateKeyPair("EdDSA", { extractable: true })
    const relayHost = await generateKeyPair("EdDSA", { extractable: true })
    const env: WorkspaceRelayWorkerEnv = {
      CLAXEDO_RELAY_RESOLVER_URL: "https://central.test/internal/relay",
      CLAXEDO_RELAY_RESOLVER_TOKEN: "resolver-token",
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: await exportSPKI(runtime.publicKey),
    }
    const room = new WorkspaceRelayRoom({}, env)
    const request = () => new Request("https://relay.test/workspaces/ws_1/api/wr/health")

    const failed = await room.fetch(request())
    expect(failed.status).toBe(503)
    await expect(failed.json()).resolves.toEqual({
      error: { code: "relay_durable_object_boot_failed", message: "CLAXEDO_RELAY_HOST_SIGNING_KEY_PEM is required" },
    })

    env.CLAXEDO_RELAY_HOST_SIGNING_KEY_PEM = await exportPKCS8(relayHost.privateKey)
    const served = await room.fetch(request())
    expect(served.status).toBe(401)
    await expect(served.json()).resolves.toMatchObject({ error: { code: "runtime_access_token_required" } })
  })
})

test("Worker resolver transmits identity and preserves a stale-token authentication rejection", async () => {
  const requests: URL[] = []
  const resolver = workspaceRelayWorkerResolverClient({
    CLAXEDO_RELAY_RESOLVER_URL: "https://resolver.test",
    CLAXEDO_RELAY_RESOLVER_TOKEN: "secret",
  }, async (input) => {
    requests.push(new URL(String(input)))
    return Response.json({ error: { code: "runtime_access_token_invalid" } }, { status: 401 })
  })
  await expect(resolver.target("ws_1", "host_1", "old")).rejects.toMatchObject({ code: "runtime_access_token_invalid" })
  expect(requests[0]?.searchParams.get("routingId")).toBe("old")
})

describe("workspace relay Worker JWKS", () => {
  type Jwks = { keys: Array<Record<string, unknown>> }
  const jwks = (env: WorkspaceRelayWorkerEnv) => worker.fetch(new Request("https://relay.test/.well-known/jwks.json"), env)

  test("publishes the current Relay Host Token public key", async () => {
    const relayHost = await generateKeyPair("EdDSA", { extractable: true })
    const res = await jwks({ CLAXEDO_RELAY_HOST_SIGNING_KEY_PEM: await exportPKCS8(relayHost.privateKey) })

    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toBe("public, max-age=300")
    expect(res.headers.get("content-type")).toMatch(/application\/json/)
    const body = await res.json() as Jwks
    expect(body.keys).toHaveLength(1)
    const key = body.keys[0]
    expect(key.kty).toBe("OKP")
    expect(key.crv).toBe("Ed25519")
    expect(key.alg).toBe("EdDSA")
    expect(key.use).toBe("sig")
    expect(key.kid).toBe(await deriveRelayHostKid(relayHost.publicKey))
    expect(typeof key.x).toBe("string")
  })

  test("publishes the next key after the current one when configured", async () => {
    const current = await generateKeyPair("EdDSA", { extractable: true })
    const next = await generateKeyPair("EdDSA", { extractable: true })
    const res = await jwks({
      CLAXEDO_RELAY_HOST_SIGNING_KEY_PEM: await exportPKCS8(current.privateKey),
      CLAXEDO_RELAY_HOST_KID: "kid_current",
      CLAXEDO_RELAY_HOST_NEXT_PUBLIC_KEY_PEM: await exportSPKI(next.publicKey),
      CLAXEDO_RELAY_HOST_NEXT_KID: "kid_next",
    })

    expect(res.status).toBe(200)
    const body = await res.json() as Jwks
    expect(body.keys.map((key) => key.kid)).toEqual(["kid_current", "kid_next"])
  })

  test("a room minting under the Worker's options embeds the kid the Worker publishes", async () => {
    const runtime = await generateKeyPair("EdDSA", { extractable: true })
    const relayHost = await generateKeyPair("EdDSA", { extractable: true })
    const env: WorkspaceRelayWorkerEnv = {
      CLAXEDO_RELAY_RESOLVER_URL: "https://central.test/internal/relay",
      CLAXEDO_RELAY_RESOLVER_TOKEN: "resolver-token",
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: await exportSPKI(runtime.publicKey),
      CLAXEDO_RELAY_HOST_SIGNING_KEY_PEM: await exportPKCS8(relayHost.privateKey),
    }
    const forwarded: Request[] = []
    const room = createWorkspaceRelayDurableObjectRoom({
      ...await workspaceRelayDurableObjectOptions(env),
      resolveTarget: (claims) => ({
        workspaceId: claims.workspace_id,
        hostId: claims.host_id,
        baseUrl: "https://host.example.test",
        backing: "cloud-vm",
      }),
      isRuntimeAccessTokenActive: () => ({ active: true }),
      fetch: ((url, init) => {
        forwarded.push(new Request(url, init))
        return Promise.resolve(new Response("ok"))
      }) as typeof fetch,
    })
    const runtimeAccessToken = await mintRuntimeAccessToken({
      principalKind: "user",
      actorId: "user_1",
      actorKind: "human",
      orgId: "org_1",
      workspaceId: "ws_1",
      hostId: "host_1",
      role: "editor",
    }, runtime.privateKey, "EdDSA")

    const res = await room.fetch(new Request("https://relay.test/workspaces/ws_1/api/wr/health", {
      headers: { authorization: `Bearer ${runtimeAccessToken}` },
    }))
    expect(res.status).toBe(200)

    const relayHostToken = forwarded[0]?.headers.get("authorization")?.replace(/^Bearer\s+/i, "")
    expect(relayHostToken).toBeTruthy()
    const published = await (await jwks(env)).json() as Jwks
    expect(published.keys.map((key) => key.kid)).toEqual([decodeProtectedHeader(relayHostToken!).kid])
    await expect(verifyRelayHostToken(relayHostToken!, relayHost.publicKey, {
      workspaceId: "ws_1",
      hostId: "host_1",
    })).resolves.toMatchObject({ workspace_id: "ws_1", host_id: "host_1" })
  })
})
