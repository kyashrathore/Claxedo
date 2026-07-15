import { createHmac } from "node:crypto"
import { describe, expect, test } from "bun:test"
import {
  createConnectionWebhookVerifier,
  githubConnectionWebhookVerifier,
  jiraConnectionWebhookVerifier,
  linearConnectionWebhookVerifier,
} from "./webhooks"

describe("Connection-owned webhook verification", () => {
  test("authenticates and normalizes GitHub without exposing the secret or raw body", async () => {
    const body = new TextEncoder().encode(JSON.stringify({
      repository: { full_name: "claxedo/cloud" },
      issue: { state: "open", labels: [{ name: "cloud" }] },
    }))
    const secret = "connection-owned-webhook-secret"
    const verifier = createConnectionWebhookVerifier({
      resolve: async () => ({ provider: "github", secret }),
      providers: { github: githubConnectionWebhookVerifier() },
    })
    const request = {
      connectionId: "connection_1",
      provider: "github",
      body,
      receivedAt: 1,
      headers: {
        "x-github-delivery": "delivery_1",
        "x-github-event": "issues",
        "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
      },
    }

    const verified = await verifier.verify(request)
    expect(verified).toEqual({
      connectionId: "connection_1",
      provider: "github",
      deliveryId: "delivery_1",
      event: "issues",
      attributes: { repo: "claxedo/cloud", state: "open", labels: ["cloud"] },
      receivedAt: 1,
    })
    expect(JSON.stringify(verified)).not.toContain(secret)
    expect(JSON.stringify(verified)).not.toContain("repository")
  })

  test("fails closed on an invalid signature", async () => {
    const verifier = createConnectionWebhookVerifier({
      resolve: async () => ({ provider: "github", secret: "right-secret" }),
      providers: { github: githubConnectionWebhookVerifier() },
    })
    await expect(verifier.verify({
      connectionId: "connection_1",
      provider: "github",
      body: new TextEncoder().encode("{}"),
      receivedAt: 1,
      headers: { "x-github-delivery": "delivery_1", "x-github-event": "issues", "x-hub-signature-256": "sha256=00" },
    })).resolves.toBeUndefined()
  })

  test("authenticates Linear, enforces its replay window, and normalizes team routing", async () => {
    const receivedAt = 1_700_000_000_000
    const body = new TextEncoder().encode(JSON.stringify({
      type: "Issue",
      organizationId: "linear-org",
      webhookTimestamp: receivedAt - 1_000,
      data: { id: "issue-1", teamId: "team-id", identifier: "ENG-42" },
    }))
    const secret = "linear-webhook-secret"
    const verifier = createConnectionWebhookVerifier({
      resolve: async () => ({ provider: "linear", secret }),
      providers: { linear: linearConnectionWebhookVerifier() },
    })
    const headers = {
      "linear-delivery": "linear-delivery-1",
      "linear-event": "Issue",
      "linear-timestamp": String(receivedAt - 1_000),
      "linear-signature": createHmac("sha256", secret).update(body).digest("hex"),
    }

    await expect(verifier.verify({ connectionId: "connection-1", provider: "linear", body, receivedAt, headers }))
      .resolves.toEqual({
        connectionId: "connection-1",
        provider: "linear",
        deliveryId: "linear-delivery-1",
        event: "Issue",
        attributes: { team: ["team-id", "ENG"], organization: "linear-org", issue: "issue-1" },
        receivedAt,
      })
    await expect(verifier.verify({
      connectionId: "connection-1",
      provider: "linear",
      body,
      receivedAt: receivedAt + 61_001,
      headers,
    })).resolves.toBeUndefined()
    await expect(verifier.verify({
      connectionId: "connection-1",
      provider: "linear",
      body,
      receivedAt,
      headers: { ...headers, "linear-signature": "00".repeat(32) },
    })).resolves.toBeUndefined()
  })

  test("authenticates Jira and normalizes its retry-stable delivery identity", async () => {
    const body = new TextEncoder().encode(JSON.stringify({
      webhookEvent: "jira:issue_updated",
      issue: { id: "10001", key: "CLOUD-7", fields: { project: { id: "10000", key: "CLOUD", name: "Cloud" } } },
      changelog: { items: [{ field: "project", from: "9999", fromString: "LEGACY", to: "10000", toString: "CLOUD" }] },
    }))
    const secret = "jira-webhook-secret"
    const verifier = createConnectionWebhookVerifier({
      resolve: async () => ({ provider: "jira", secret }),
      providers: { jira: jiraConnectionWebhookVerifier() },
    })
    const request = {
      connectionId: "connection-1",
      provider: "jira",
      body,
      receivedAt: 2,
      headers: {
        "x-atlassian-webhook-identifier": "jira-delivery-1",
        "x-hub-signature": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
      },
    }

    await expect(verifier.verify(request)).resolves.toEqual({
      connectionId: "connection-1",
      provider: "jira",
      deliveryId: "jira-delivery-1",
      event: "jira:issue_updated",
      attributes: { project: ["10000", "CLOUD", "Cloud", "9999", "LEGACY"], issue: "10001", issueKey: "CLOUD-7" },
      receivedAt: 2,
    })
    await expect(verifier.verify({ ...request, headers: { ...request.headers, "x-hub-signature": "sha1=bad" } }))
      .resolves.toBeUndefined()
    await expect(verifier.verify({ ...request, headers: { "x-hub-signature": request.headers["x-hub-signature"] } }))
      .resolves.toBeUndefined()
  })
})
