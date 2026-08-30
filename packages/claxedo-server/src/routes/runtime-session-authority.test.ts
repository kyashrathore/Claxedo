import { describe, expect, test } from "vitest"
import { Hono } from "hono"
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose"
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
  test("rejects oversized bodies before authentication or JSON parsing", async () => {
    const app = new Hono().route("/api/runtime-authority", RuntimeSessionAuthorityRoutes())
    const response = await app.request("/api/runtime-authority/session-authorize", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(17 * 1024),
      },
      body: JSON.stringify({ sessionId: "x".repeat(17 * 1024), action: "read" }),
    })

    expect(response.status).toBe(413)
    expect(await response.json()).toMatchObject({ error: { code: "request_body_too_large" } })
  })

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

  test("renews a stream lease after RHT expiry and rejects revoked parent authority", async () => {
    const relayKey = await generateKeyPair("EdDSA", { extractable: true })
    const runtimeKey = await generateKeyPair("EdDSA", { extractable: true })
    let active = true
    const app = new Hono().route("/api/runtime-authority", RuntimeSessionAuthorityRoutes({
      authority: {
        authorizeRuntimeSession: async () => {},
        runtimeAccessTokenActive: async () => active
          ? { active: true }
          : { active: false, code: "runtime_access_token_revoked", reason: "revoked" },
      },
    } as never, {
      env: {
        CLAXEDO_RELAY_HOST_VERIFY_PEM: await exportSPKI(relayKey.publicKey),
        CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: await exportPKCS8(runtimeKey.privateKey),
        CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: await exportSPKI(runtimeKey.publicKey),
      },
    }))
    const rht = await mintRelayHostToken({ ...claims, jti: "rat_parent_1" }, relayKey.privateKey, "EdDSA")
    const initial = await app.request("/api/runtime-authority/session-authorize", {
      method: "POST",
      headers: { authorization: `Bearer ${rht}`, "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "ses_private", action: "read", stream: true }),
    })
    expect(initial.status).toBe(200)
    const first = await initial.json() as { lease: string; expiresAt: number }
    expect(first.lease).toBeTypeOf("string")
    expect(first.expiresAt).toBeGreaterThan(Date.now())

    const renew = () => app.request("/api/runtime-authority/session-authorize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "ses_private", action: "read", stream: true, lease: first.lease }),
    })
    expect((await renew()).status).toBe(200)
    active = false
    const revoked = await renew()
    expect(revoked.status).toBe(401)
    expect(await revoked.json()).toMatchObject({ error: { code: "runtime_access_token_revoked" } })
  })
})
