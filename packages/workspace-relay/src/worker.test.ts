import { describe, expect, test } from "bun:test"
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose"
import worker, {
  WorkspaceRelayRoom,
  workspaceRelayWorkerResolverClient,
  workspaceRelayWorkerResolverUrl,
  type WorkspaceRelayWorkerEnv,
} from "./worker"
import type { WorkspaceRelayDurableObjectNamespace } from "./cloudflare"

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

  test("resolver client caches target and revocation responses within configured TTLs", async () => {
    const requests: Request[] = []
    const client = workspaceRelayWorkerResolverClient({
      CLAXEDO_RELAY_RESOLVER_URL: "https://central.test/internal/relay",
      CLAXEDO_RELAY_RESOLVER_TOKEN: "resolver-token",
      CLAXEDO_RELAY_TARGET_CACHE_TTL_MS: "10000",
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
