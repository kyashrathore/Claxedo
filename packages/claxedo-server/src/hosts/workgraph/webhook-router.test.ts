import { describe, expect, test, vi } from "vitest"
import { createWorkGraphWebhookRouter } from "./webhook-router"

describe("WorkGraph Connection webhook boundary", () => {
  test("rejects invalid signatures before WorkGraph receives or writes anything", async () => {
    const receive = vi.fn()
    const router = createWorkGraphWebhookRouter({
      verifier: { verify: async () => undefined },
      intake: { receive },
      resolveOrganizationId: async () => "org-a",
    })

    const response = await router.request("/webhooks/github/team_connection", {
      method: "POST",
      headers: { "x-hub-signature-256": "sha256=invalid" },
      body: JSON.stringify({ action: "opened" }),
    })

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: { code: "invalid_webhook_signature" } })
    expect(receive).not.toHaveBeenCalled()
  })

  test("passes only the verifier's normalized signal into WorkGraph", async () => {
    const receive = vi.fn(async () => ({ accepted: true, reason: "processed" as const, refreshed: 1 }))
    const router = createWorkGraphWebhookRouter({
      verifier: {
        verify: async () => ({
          connectionId: "team_connection",
          provider: "github",
          deliveryId: "delivery_1",
          event: "issues",
          attributes: { repo: "claxedo/cloud", state: "open" },
          receivedAt: 1,
        }),
      },
      intake: { receive },
      resolveOrganizationId: async () => "org-a",
    })

    const response = await router.request("/webhooks/github/team_connection", {
      method: "POST",
      headers: { authorization: "must-not-cross" },
      body: JSON.stringify({ secret: "must-not-cross", issue: { title: "Changed" } }),
    })

    expect(response.status).toBe(202)
    expect(receive).toHaveBeenCalledWith({
      organizationId: "org-a",
      connectionId: "team_connection",
      provider: "github",
      deliveryId: "delivery_1",
      event: "issues",
      attributes: { repo: "claxedo/cloud", state: "open" },
      receivedAt: 1,
    })
  })

  test("acknowledges processed Linear deliveries with the provider-required 200", async () => {
    const router = createWorkGraphWebhookRouter({
      verifier: {
        verify: async () => ({
          connectionId: "team_connection",
          provider: "linear",
          deliveryId: "delivery_1",
          event: "Issue",
          attributes: { team: ["ENG"] },
          receivedAt: 1,
        }),
      },
      intake: { receive: async () => ({ accepted: true, reason: "processed", refreshed: 1 }) },
      resolveOrganizationId: async () => "org-a",
    })

    const response = await router.request("/webhooks/linear/team_connection", { method: "POST", body: "{}" })
    expect(response.status).toBe(200)
  })

  test("returns retryable statuses for concurrent or failed processing", async () => {
    const verified = {
      connectionId: "team_connection",
      provider: "github" as const,
      deliveryId: "delivery_1",
      event: "issues",
      attributes: { repo: "claxedo/cloud" },
      receivedAt: 1,
    }
    const busy = createWorkGraphWebhookRouter({
      verifier: { verify: async () => verified },
      intake: { receive: async () => ({ accepted: false, reason: "in_progress", refreshed: 0 }) },
      resolveOrganizationId: async () => "org-a",
    })
    const busyResponse = await busy.request("/webhooks/github/team_connection", { method: "POST", body: "{}" })
    expect(busyResponse.status).toBe(503)
    expect(busyResponse.headers.get("retry-after")).toBe("1")
    expect(await busyResponse.json()).toMatchObject({ reason: "in_progress", retryable: true })

    const failed = createWorkGraphWebhookRouter({
      verifier: { verify: async () => verified },
      intake: { receive: async () => { throw new Error("temporary provider failure") } },
      resolveOrganizationId: async () => "org-a",
    })
    const failedResponse = await failed.request("/webhooks/github/team_connection", { method: "POST", body: "{}" })
    expect(failedResponse.status).toBe(503)
    expect(failedResponse.headers.get("retry-after")).toBe("60")
    expect(await failedResponse.json()).toEqual({ error: { code: "webhook_processing_failed", retryable: true } })
  })

  test("distinguishes verifier outages from invalid signatures", async () => {
    const router = createWorkGraphWebhookRouter({
      verifier: { verify: async () => { throw new Error("credential store unavailable") } },
      intake: { receive: vi.fn() },
      resolveOrganizationId: async () => "org-a",
    })
    const response = await router.request("/webhooks/github/team_connection", { method: "POST", body: "{}" })
    expect(response.status).toBe(503)
    expect(response.headers.get("retry-after")).toBe("60")
    expect(await response.json()).toEqual({ error: { code: "webhook_verification_unavailable", retryable: true } })
  })

  test("stops reading an oversized streaming body without content-length", async () => {
    const verify = vi.fn()
    let pulls = 0
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1
        controller.enqueue(new Uint8Array(pulls === 1 ? 6 : 5))
      },
      cancel() {
        cancelled = true
      },
    })
    const router = createWorkGraphWebhookRouter({
      verifier: { verify },
      intake: { receive: vi.fn() },
      resolveOrganizationId: async () => "org-a",
      maxBodyBytes: 10,
    })

    const response = await router.fetch(new Request("http://workgraph.test/webhooks/github/team_connection", {
      method: "POST",
      body,
      duplex: "half",
    } as RequestInit))

    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({ error: { code: "payload_too_large" } })
    expect(pulls).toBe(2)
    expect(cancelled).toBe(true)
    expect(verify).not.toHaveBeenCalled()
  })
})
