import { describe, expect, test } from "vitest"
import { githubIntegration } from "@claxedo/connections"
import type { ControlPlaneCredentials } from "../control-plane/services"
import { createHostedConnectionsSetup } from "./hosted-connections-setup"

describe("hosted Connections setup", () => {
  test("uses the Connections flow and mirrors only secret-free metadata into Convex", async () => {
    const secrets = new Map<string, { secret: string; status: "available" | "error" }>()
    const metadata: Array<Record<string, unknown>> = []
    const mutations: Array<Record<string, unknown>> = []
    const credentials: ControlPlaneCredentials = {
      listCredentials: async () => [],
      getCredentialByProvider: async (providerId) => {
        const value = secrets.get(providerId)
        return value ? {
          id: providerId,
          provider_id: providerId,
          kind: "api_key",
          source: "managed",
          label: null,
          account_id: null,
          secure_ref: `test:${providerId}`,
          status: value.status,
          expires_at: null,
          last_validated_at: null,
          last_error: null,
          created_at: 1,
          updated_at: 1,
        } : undefined
      },
      resolveCredentialSecret: async (providerId) => secrets.get(providerId)?.secret ?? null,
      putCredential: async (value) => {
        secrets.set(value.provider_id, { secret: value.secret, status: "available" })
        return (await credentials.getCredentialByProvider(value.provider_id))!
      },
      deleteCredential: async (id) => secrets.delete(id),
      deleteCredentialsByProvider: async (providerId) => secrets.delete(providerId) ? 1 : 0,
      updateCredentialStatus: async (id, status) => {
        const value = secrets.get(id)
        if (value) secrets.set(id, { ...value, status: status === "error" ? "error" : "available" })
      },
      syncLocalCredentials: async () => ({ synced: [], existing: [], missing: [], failed: [] }),
    }
    const app = createHostedConnectionsSetup({
      env: {},
      serviceToken: "service-token",
      authConfig: { enabled: true, issuer: "https://issuer.example", jwksUrl: "https://issuer.example/jwks" },
      verifier: async () => ({
        mode: "signed",
        user: { subject: "clerk-user", orgId: "clerk-org", issuer: "https://issuer.example", tokenIdentifier: "token" },
      }),
      credentials: () => credentials,
      integrations: [githubIntegration({ fetchImpl: (async () => Response.json({ login: "octocat" })) as unknown as typeof fetch })],
      executor: {
        async query(_fn, args) {
          if ("clerk_org_id" in args) return { member: true, org_id: "org-1", user_id: "user-1", role: "admin" }
          return metadata
        },
        async mutation(_fn, args) {
          mutations.push(args)
          if (!args.integrationId) {
            const deleted = metadata.some((row) => row.id === args.connectionId)
            metadata.splice(0, metadata.length, ...metadata.filter((row) => row.id !== args.connectionId))
            return { deleted }
          }
          metadata.splice(0, metadata.length, {
            id: args.connectionId,
            integrationId: args.integrationId,
            capabilities: args.capabilities,
            status: args.status,
            accountLabel: args.accountLabel,
            tokenType: args.tokenType,
          })
          return { id: args.connectionId }
        },
      },
    })

    const response = await app.request("/github/connect", {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({ scope: "team", method: "key", secret: "github-secret" }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(mutations).toHaveLength(1)
    expect(mutations[0]).toMatchObject({
      service_token: "service-token",
      ownerUserId: "user-1",
      orgId: "org-1",
      integrationId: "github",
      capabilities: ["code-host", "work-source"],
      status: "connected",
      accountLabel: "octocat",
      tokenType: "bearer",
    })
    expect(JSON.stringify(mutations)).not.toContain("github-secret")
    expect([...secrets.values()].map((value) => value.secret)).toEqual(["github-secret"])

    const listed = await app.request("/", { headers: { authorization: "Bearer token" } })
    expect(listed.status).toBe(200)
    expect((await listed.json()).connections).toMatchObject([{ integrationId: "github", status: "connected" }])

    const connectionId = metadata[0]!.id as string
    const webhookSecret = "github-webhook-signing-secret"
    const configured = await app.request(`/connections/${connectionId}/webhook-secret`, {
      method: "PUT",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({ secret: webhookSecret }),
    })
    expect(configured.status).toBe(200)
    expect(await configured.json()).toEqual({ ok: true })
    expect(secrets.get(`integration:${connectionId}:webhook-signing`)?.secret).toBe(webhookSecret)
    expect(await (await app.request("/", { headers: { authorization: "Bearer token" } })).text()).not.toContain(webhookSecret)

    await app.request(`/connections/${connectionId}/webhook-secret`, {
      method: "PUT",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({ secret: "rotated-webhook-secret" }),
    })
    expect(secrets.get(`integration:${connectionId}:webhook-signing`)?.secret).toBe("rotated-webhook-secret")
    expect((await app.request(`/connections/${connectionId}/webhook-secret`, {
      method: "DELETE",
      headers: { authorization: "Bearer token" },
    })).status).toBe(200)
    expect(secrets.has(`integration:${connectionId}:webhook-signing`)).toBe(false)

    await app.request(`/connections/${connectionId}/webhook-secret`, {
      method: "PUT",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({ secret: webhookSecret }),
    })
    expect((await app.request(`/connections/${connectionId}`, {
      method: "DELETE",
      headers: { authorization: "Bearer token" },
    })).status).toBe(200)
    expect(secrets.has(`integration:${connectionId}`)).toBe(false)
    expect(secrets.has(`integration:${connectionId}:webhook-signing`)).toBe(false)
  })
})
