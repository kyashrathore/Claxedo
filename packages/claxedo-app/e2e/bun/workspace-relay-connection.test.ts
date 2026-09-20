import { describe, expect, test } from "bun:test"
import { mintRuntimeAccessToken } from "../../../workspace-relay/src"
import { createWorkspaceRelayBun } from "../../../workspace-relay/src/bun"
import { requestBodyText, requestUrl } from "../../src/lib/url"
import {
  createWorkspaceRelayConnection,
  runtimeAccessTokenJti,
  type WorkspaceConnectionInfo,
} from "../../src/platform/runtime/agent/workspace-relay-connection"

async function generateEdDsaKeyPair() {
  return await crypto.subtle.generateKey({
    name: "Ed25519",
  }, true, ["sign", "verify"])
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
    host: "provisioner",
    sessionAuthority: "managed-private",
    workspaceId: "ws_1",
    role: "editor",
    relayUrl: "http://relay.test",
    runtimeAccessToken: "rat_missing",
    tokenExpiresAt: Date.now() + 10 * 60_000,
    ...input,
  }
}

/**
 * The mint as the CONTROL PLANE writes it. The client reads `backing` and
 * derives the host from it, so a refresh body built from the parsed shape
 * would hand the parser a field the real route never sends.
 */
function connectionBody(input: { relayUrl: string; runtimeAccessToken: string }) {
  const parsed = connection(input)
  return {
    backing: "cloud-vm",
    sessionAuthority: parsed.sessionAuthority,
    workspaceId: parsed.workspaceId,
    role: parsed.role,
    relayUrl: parsed.relayUrl,
    runtimeAccessToken: parsed.runtimeAccessToken,
    tokenExpiresAt: parsed.tokenExpiresAt,
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
          const text = requestUrl(url)
          if (text === "http://server.test/api/workspace/ws_1/connection/refresh") {
            refreshBodies.push(requestBodyText(init?.body))
            return Response.json(connectionBody({
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
      await relay.stop(true)
      await host.stop(true)
    }
  })
})
