import { createHmac } from "node:crypto"
import { describe, expect, test } from "bun:test"
import { createConnectionWebhookVerifier, githubConnectionWebhookVerifier } from "./webhooks"

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
})
