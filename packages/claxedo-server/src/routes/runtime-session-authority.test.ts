import { describe, expect, test } from "vitest"
import { Hono } from "hono"
import { exportSPKI, generateKeyPair } from "jose"
import { mintRelayHostToken } from "@claxedo/workspace-relay"
import { RuntimeSessionAuthorityRoutes } from "./runtime-session-authority"

const claims = {
  subject: "user_1",
  actorId: "actor_1",
  actorKind: "human" as const,
  orgId: "org_1",
  workspaceId: "ws_1",
  hostId: "host_1",
  role: "editor" as const,
  access: "cloud" as const,
  backing: "cloud-vm" as const,
}

describe("runtime session authority oracle", () => {
  test("accepts a current RHT and rejects the same proof after its expiry", async () => {
    const key = await generateKeyPair("EdDSA", { extractable: true })
    const calls: unknown[] = []
    const app = new Hono().route("/api/runtime-authority", RuntimeSessionAuthorityRoutes({
      authority: {
        authorizeRuntimeSession: async (input: unknown) => {
          calls.push(input)
        },
        registerRuntimeSession: async (input: unknown) => {
          calls.push(input)
        },
      },
    } as never, {
      env: { CLAXEDO_RELAY_HOST_VERIFY_PEM: await exportSPKI(key.publicKey) },
    }))
    const request = (token: string, action: "read" | "register" = "read") => app.request("/api/runtime-authority/session-authorize", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ sessionId: "ses_private", action }),
    })

    const current = await mintRelayHostToken(claims, key.privateKey, "EdDSA")
    expect((await request(current)).status).toBe(200)
    expect(calls).toEqual([{
      actorId: "actor_1",
      actorKind: "human",
      sessionId: "ses_private",
      workspaceId: "ws_1",
      action: "read",
    }])

    expect((await request(current, "register")).status).toBe(200)
    expect(calls[1]).toEqual({
      actorId: "actor_1",
      actorKind: "human",
      sessionId: "ses_private",
      workspaceId: "ws_1",
    })

    const expired = await mintRelayHostToken({
      ...claims,
      now: Date.now() - 120_000,
      ttlSeconds: 60,
    }, key.privateKey, "EdDSA")
    expect((await request(expired)).status).toBe(401)
    expect(calls).toHaveLength(2)
  })
})
