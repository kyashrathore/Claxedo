import { describe, expect, test } from "bun:test"
import worker, {
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
          access: "cloud",
          backing: "cloud-vm",
        })
      }
      return Response.json({ active: true })
    })

    await expect(client.target("ws_1", "host_1")).resolves.toMatchObject({
      baseUrl: "https://runtime.test",
      access: "cloud",
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
          access: "cloud",
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
})
