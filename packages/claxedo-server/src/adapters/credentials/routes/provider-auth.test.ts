import { describe, expect, test } from "vitest"
import type { ControlPlaneCredentials, ControlPlaneServices } from "../../../authority/services"
import { createProviderAuthService } from "../../../adapters/provider-auth/service"
import { ProviderAuthRoutes } from "./provider-auth"

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function jwt(claims: Record<string, unknown>) {
  return [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify(claims)).toString("base64url"),
    "sig",
  ].join(".")
}

function credentials() {
  const writes: Array<Parameters<ControlPlaneCredentials["putCredential"]>[0]> = []
  const deleted: string[] = []
  return {
    writes,
    deleted,
    registry: {
      listCredentials: async () => [],
      getCredentialByProvider: async () => undefined,
      putCredential: async (input) => {
        writes.push(input)
        return {
          id: "cred_1",
          provider_id: input.provider_id,
          kind: input.kind,
          source: input.source,
          label: input.label ?? null,
          account_id: input.account_id ?? null,
          secure_ref: "test:cred_1",
          status: "available",
          expires_at: input.expires_at ?? null,
          last_validated_at: 1,
          last_error: null,
          created_at: 1,
          updated_at: 1,
        }
      },
      deleteCredential: async () => false,
      deleteCredentialsByProvider: async (providerId) => {
        deleted.push(providerId)
        return 0
      },
      updateCredentialStatus: async () => {},
      syncLocalCredentials: async () => ({ synced: [], existing: [], missing: [], failed: [] }),
    } satisfies ControlPlaneCredentials,
  }
}

function services(input: ControlPlaneCredentials) {
  return { credentials: input } as unknown as ControlPlaneServices
}

describe("control-plane provider auth", () => {
  test("exposes ACP auth methods without an upstream proxy", async () => {
    const c = credentials()
    const app = ProviderAuthRoutes(services(c.registry))
    const res = await app.request("/provider/auth")

    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, Array<{ type: string; label: string }>>
    expect(body["claude-acp"]).toEqual([{ type: "api", label: "API Key" }])
    expect(body["claude-sdk"]).toEqual([{ type: "api", label: "API Key" }])
    expect(body["codex-acp"].map((item) => item.type)).toEqual(["oauth", "api"])
    expect(body["codex-app-server"]).toEqual([{ type: "api", label: "API Key" }])
    expect(body["cursor-acp"]).toEqual([{ type: "api", label: "API Key" }])
  })

  test("stores codex oauth callbacks as managed oauth_token credentials", async () => {
    const c = credentials()
    const calls: string[] = []
    const service = createProviderAuthService(c.registry, {
      now: () => 1_000,
      sleep: async () => {},
      pollingSafetyMs: 0,
      fetch: (async (input, init) => {
        const url = input.toString()
        calls.push(`${init?.method ?? "GET"} ${url}`)
        if (url.endsWith("/api/accounts/deviceauth/usercode")) {
          return json({ device_auth_id: "dev_1", user_code: "ABCD-EFGH", interval: "1" })
        }
        if (url.endsWith("/api/accounts/deviceauth/token")) {
          return json({ authorization_code: "auth_code", code_verifier: "verifier" })
        }
        if (url.endsWith("/oauth/token")) {
          return json({
            access_token: "access_token",
            refresh_token: "refresh_token",
            expires_in: 3600,
            id_token: jwt({ chatgpt_account_id: "acct_123" }),
          })
        }
        return json({ error: "unexpected" }, 404)
      }) as typeof fetch,
    })
    const app = ProviderAuthRoutes(services(c.registry), { service })

    const authorize = await app.request("/provider/codex-acp/oauth/authorize", {
      method: "POST",
      body: JSON.stringify({ method: 0 }),
      headers: { "Content-Type": "application/json" },
    })
    expect(authorize.status).toBe(200)
    expect(await authorize.json()).toEqual({
      url: "https://auth.openai.com/codex/device",
      instructions: "Enter code: ABCD-EFGH",
      method: "auto",
    })

    const callback = await app.request("/provider/codex-acp/oauth/callback", {
      method: "POST",
      body: JSON.stringify({ method: 0 }),
      headers: { "Content-Type": "application/json" },
    })
    expect(callback.status).toBe(200)
    expect(await callback.json()).toBe(true)
    expect(c.deleted).toEqual(["codex-acp"])
    expect(c.writes).toHaveLength(1)
    expect(c.writes[0]).toMatchObject({
      provider_id: "codex-acp",
      kind: "oauth_token",
      source: "managed",
      account_id: "acct_123",
      expires_at: 3_601_000,
    })
    expect(JSON.parse(c.writes[0]!.secret)).toMatchObject({
      type: "codex_auth",
      tokens: {
        access_token: "access_token",
        refresh_token: "refresh_token",
        account_id: "acct_123",
      },
      oauth: {
        access: "access_token",
        refresh: "refresh_token",
        account_id: "acct_123",
      },
    })
    expect(calls).toEqual([
      "POST https://auth.openai.com/api/accounts/deviceauth/usercode",
      "POST https://auth.openai.com/api/accounts/deviceauth/token",
      "POST https://auth.openai.com/oauth/token",
    ])
  })

  test("rejects oauth callback when authorization has not started", async () => {
    const c = credentials()
    const app = ProviderAuthRoutes(services(c.registry))
    const res = await app.request("/provider/codex-acp/oauth/callback", {
      method: "POST",
      body: JSON.stringify({ method: 0 }),
      headers: { "Content-Type": "application/json" },
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({
      error: {
        code: "provider_auth_missing_pending",
      },
    })
  })
})
