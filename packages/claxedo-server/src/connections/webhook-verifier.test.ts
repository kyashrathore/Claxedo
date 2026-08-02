import { createHmac } from "node:crypto"
import { describe, expect, test, vi } from "vitest"
import type { ControlPlaneCredentials } from "../authority/services"
import { createHostedConnectionWebhookVerifier } from "./webhook-verifier"

const body = new TextEncoder().encode(JSON.stringify({ repository: { full_name: "claxedo/cloud" } }))

describe("hosted Connection webhook verifier", () => {
  test("resolves only connected GitHub work-source metadata into its org credential namespace", async () => {
    const query = vi.fn(async (_fn: unknown, args: Record<string, unknown>) => args.connectionId === "connection-a" ? {
      id: "connection-a",
      integrationId: "github",
      capabilities: ["work-source"],
      status: "connected",
      orgId: "org-a",
    } : null)
    const credentials = vi.fn((orgId: string) => credentialStore(orgId === "org-a" ? "right-secret" : undefined))
    const verifier = createHostedConnectionWebhookVerifier({ env: {}, executor: { query }, serviceToken: "service-token", credentials })!

    await expect(verifier.verify(request("connection-a", "github", "right-secret"))).resolves.toMatchObject({
      connectionId: "connection-a",
      provider: "github",
      deliveryId: "delivery-1",
      event: "issues",
    })
    await expect(verifier.verify(request("connection-b", "github", "right-secret"))).resolves.toBeUndefined()
    await expect(verifier.verify(request("connection-a", "linear", "right-secret"))).resolves.toBeUndefined()
    await expect(verifier.verify(request("connection-a", "github", "wrong-secret"))).resolves.toBeUndefined()
    expect(query).toHaveBeenCalledWith(expect.anything(), { service_token: "service-token", connectionId: "connection-a" })
    expect(credentials).toHaveBeenCalledWith("org-a")
  })

  test("rotation invalidates the old signature and unavailable credential storage fails closed", async () => {
    let secret: string | undefined = "old-secret"
    const verifier = createHostedConnectionWebhookVerifier({
      env: {},
      serviceToken: "service-token",
      executor: { query: async () => ({
        id: "connection-a",
        integrationId: "github",
        capabilities: ["work-source"],
        status: "connected",
        orgId: "org-a",
      }) },
      credentials: () => credentialStore(secret),
    })!

    await expect(verifier.verify(request("connection-a", "github", "old-secret"))).resolves.toBeDefined()
    secret = "new-secret"
    await expect(verifier.verify(request("connection-a", "github", "old-secret"))).resolves.toBeUndefined()
    await expect(verifier.verify(request("connection-a", "github", "new-secret"))).resolves.toBeDefined()
    secret = undefined
    await expect(verifier.verify(request("connection-a", "github", "new-secret"))).resolves.toBeUndefined()
  })

  test("resolves Linear and Jira signing secrets through their owning org Connection", async () => {
    const receivedAt = 1_700_000_000_000
    const integrations = ["linear", "jira"] as const
    const verifier = createHostedConnectionWebhookVerifier({
      env: {},
      serviceToken: "service-token",
      executor: { query: async (_fn, args) => ({
        id: args.connectionId,
        integrationId: args.connectionId,
        capabilities: ["work-source"],
        status: "connected",
        orgId: "org-a",
      }) },
      credentials: () => credentialStore("provider-secret", "*"),
    })!

    for (const provider of integrations) {
      const body = new TextEncoder().encode(JSON.stringify(provider === "linear" ? {
        webhookTimestamp: receivedAt,
        data: { teamId: "team-a" },
      } : {
        webhookEvent: "jira:issue_updated",
        issue: { id: "10001", fields: { project: { key: "CLOUD" } } },
      }))
      const headers: Record<string, string> = provider === "linear" ? {
        "linear-delivery": "linear-delivery",
        "linear-event": "Issue",
        "linear-timestamp": String(receivedAt),
        "linear-signature": createHmac("sha256", "provider-secret").update(body).digest("hex"),
      } : {
        "x-atlassian-webhook-identifier": "jira-delivery",
        "x-hub-signature": `sha256=${createHmac("sha256", "provider-secret").update(body).digest("hex")}`,
      }
      await expect(verifier.verify({
        connectionId: provider,
        provider,
        body,
        headers,
        receivedAt,
      })).resolves.toMatchObject({ connectionId: provider, provider })
    }
  })

  test("omits the public verifier when encrypted hosted credentials are disabled", () => {
    expect(createHostedConnectionWebhookVerifier({
      env: {},
      serviceToken: "service-token",
      executor: { query: async () => { throw new Error("must not query") } },
    })).toBeUndefined()
  })
})

function request(connectionId: string, provider: string, secret: string) {
  return {
    connectionId,
    provider,
    body,
    receivedAt: 1,
    headers: {
      "x-github-delivery": "delivery-1",
      "x-github-event": "issues",
      "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
    },
  }
}

function credentialStore(secret: string | undefined, connectionId = "connection-a"): ControlPlaneCredentials {
  return {
    listCredentials: async () => [],
    getCredentialByProvider: async () => undefined,
    resolveCredentialSecret: async (providerId) =>
      (connectionId === "*"
        ? providerId.startsWith("integration:") && providerId.endsWith(":webhook-signing")
        : providerId === `integration:${connectionId}:webhook-signing`) ? secret ?? null : null,
    putCredential: async () => { throw new Error("unused") },
    deleteCredential: async () => false,
    deleteCredentialsByProvider: async () => 0,
    updateCredentialStatus: async () => undefined,
    syncLocalCredentials: async () => ({ synced: [], existing: [], missing: [], failed: [] }),
  }
}
