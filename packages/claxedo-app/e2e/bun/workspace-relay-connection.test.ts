import { describe, expect, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import {
  createWorkspaceRelayBun,
  mintRuntimeAccessToken,
} from "../../../workspace-relay/src"
import {
  createWorkspaceRelayConnection,
  runtimeAccessTokenJti,
  type WorkspaceConnectionInfo,
} from "../../src/platform/runtime/agent/workspace-relay-connection"

GlobalRegistrator.unregister()

async function generateEdDsaKeyPair() {
  return await crypto.subtle.generateKey({
    name: "Ed25519",
  }, true, ["sign", "verify"]) as CryptoKeyPair
}

async function runtimeToken(input: {
  jti: string
  key: CryptoKey
}) {
  return await mintRuntimeAccessToken({
    principalKind: "user",
    actorId: "user_1",
    actorKind: "human",
    orgId: "org_1",
    workspaceId: "ws_1",
    hostId: "host_1",
    role: "editor",
    jti: input.jti,
  }, input.key, "EdDSA")
}

function connection(input: Partial<WorkspaceConnectionInfo> = {}): WorkspaceConnectionInfo {
  return {
    access: "cloud",
    backing: "cloud-vm",
    workspaceId: "ws_1",
    role: "editor",
    relayUrl: "http://relay.test",
    runtimeAccessToken: "rat_missing",
    tokenExpiresAt: Date.now() + 10 * 60_000,
    ...input,
  }
}

describe("workspace relay connection E2E", () => {
  test("refreshes after a real relay 401 and retries with the new Runtime Access Token", async () => {
    const runtime = await generateEdDsaKeyPair()
    const relayHost = await generateEdDsaKeyPair()
    const hostAuthorizations: string[] = []
    const refreshBodies: string[] = []
    const host = Bun.serve({
      port: 0,
      fetch(request) {
        hostAuthorizations.push(request.headers.get("authorization") ?? "")
        return Response.json({
          service: "workspace-runtime",
          path: new URL(request.url).pathname,
        })
      },
    })
    const relayHandler = createWorkspaceRelayBun({
      runtimeAccessKey: runtime.publicKey,
      relayHostSigningKey: relayHost.privateKey,
      relayHostAlgorithm: "EdDSA",
      resolveTarget: (claims) => ({
        workspaceId: claims.workspace_id,
        hostId: claims.host_id,
        baseUrl: String(host.url).replace(/\/$/, ""),
        access: "cloud",
        backing: "cloud-vm",
      }),
      isRuntimeAccessTokenActive: (claims) =>
        claims.jti === "revoked"
          ? {
              active: false,
              code: "runtime_access_token_revoked",
              reason: "Runtime Access Token has been revoked",
            }
          : { active: true },
    })
    const relay = Bun.serve({
      port: 0,
      fetch: relayHandler.fetch,
      websocket: relayHandler.websocket,
    })

    try {
      const relayUrl = String(relay.url).replace(/\/$/, "")
      const refreshed = await runtimeToken({
        jti: "fresh",
        key: runtime.privateKey,
      })
      const transport = createWorkspaceRelayConnection(connection({
        relayUrl,
        runtimeAccessToken: await runtimeToken({
          jti: "revoked",
          key: runtime.privateKey,
        }),
      }), {
        serverUrl: "http://server.test",
        request: (async (url, init) => {
          const text = String(url)
          if (text === "http://server.test/api/workspace/ws_1/connection/refresh") {
            refreshBodies.push(String(init?.body ?? ""))
            return Response.json(connection({
              relayUrl,
              runtimeAccessToken: refreshed,
            }))
          }
          if (text.startsWith("http://server.test/")) {
            throw new Error(`Unexpected claxedo-server proxy request: ${text}`)
          }
          return fetch(url, init)
        }) as typeof fetch,
      })

      const response = await transport.fetch("/api/wr/health")

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({
        service: "workspace-runtime",
        path: "/api/wr/health",
      })
      expect(refreshBodies).toEqual([JSON.stringify({ previousJti: "revoked" })])
      expect(runtimeAccessTokenJti(transport.connection.runtimeAccessToken)).toBe("fresh")
      expect(hostAuthorizations).toHaveLength(1)
      expect(hostAuthorizations[0]?.startsWith("Bearer ")).toBe(true)
    } finally {
      relay.stop(true)
      host.stop(true)
    }
  })
})
