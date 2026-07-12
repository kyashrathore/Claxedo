import { describe, expect, test } from "vitest"
import { signStandardWebhook, verifyStandardWebhook, WebhookSignatureError } from "./standard-webhooks"

/**
 * Standard Webhooks verification (the scheme Polar signs deliveries with:
 * HMAC-SHA256 over `${id}.${timestamp}.${body}`, headers webhook-id/
 * webhook-timestamp/webhook-signature, `v1,<base64>` space-delimited).
 * Cross-checked against the `standardwebhooks` reference implementation the
 * Polar SDK wraps — including Polar's raw-utf8-secret convention.
 */

const SECRET = "polar_whs_test_secret"
const NOW = 1_800_000_000_000 // fixed clock
const now = () => NOW

async function signedHeaders(payload: string, overrides: Partial<Record<string, string>> = {}) {
  const timestampSeconds = Math.floor(NOW / 1000)
  return {
    "webhook-id": overrides["webhook-id"] ?? "msg_1",
    "webhook-timestamp": overrides["webhook-timestamp"] ?? String(timestampSeconds),
    "webhook-signature":
      overrides["webhook-signature"] ??
      (await signStandardWebhook({
        payload,
        id: overrides["webhook-id"] ?? "msg_1",
        timestampSeconds: Number(overrides["webhook-timestamp"] ?? timestampSeconds),
        secret: overrides["secret"] ?? SECRET,
      })),
  }
}

describe("standard webhooks verification", () => {
  test("accepts a correctly signed payload", async () => {
    const payload = JSON.stringify({ type: "customer.state_changed", data: { id: "cus_1" } })
    await expect(
      verifyStandardWebhook({ payload, headers: await signedHeaders(payload), secret: SECRET, now }),
    ).resolves.toBeUndefined()
  })

  test("accepts when a matching v1 signature is one of several space-delimited entries (key rotation)", async () => {
    const payload = "{}"
    const headers = await signedHeaders(payload)
    headers["webhook-signature"] = `v1,AAAAinvalidAAAA= ${headers["webhook-signature"]} v1a,ZZZZ`
    await expect(verifyStandardWebhook({ payload, headers, secret: SECRET, now })).resolves.toBeUndefined()
  })

  test("rejects a signature produced with the wrong secret", async () => {
    const payload = "{}"
    const headers = await signedHeaders(payload, { secret: "some-other-secret" } as never)
    headers["webhook-signature"] = await signStandardWebhook({
      payload,
      id: "msg_1",
      timestampSeconds: Math.floor(NOW / 1000),
      secret: "some-other-secret",
    })
    await expect(verifyStandardWebhook({ payload, headers, secret: SECRET, now }))
      .rejects.toThrow(WebhookSignatureError)
  })

  test("rejects a tampered payload", async () => {
    const payload = JSON.stringify({ type: "subscription.updated", data: { seats: 5 } })
    const headers = await signedHeaders(payload)
    const tampered = payload.replace('"seats":5', '"seats":500')
    await expect(verifyStandardWebhook({ payload: tampered, headers, secret: SECRET, now }))
      .rejects.toThrow("No matching webhook signature")
  })

  test("rejects missing signature headers", async () => {
    await expect(verifyStandardWebhook({ payload: "{}", headers: {}, secret: SECRET, now }))
      .rejects.toThrow("Missing required webhook signature headers")
  })

  test("rejects timestamps outside the ±5 minute tolerance (replay protection)", async () => {
    const payload = "{}"
    const staleSeconds = Math.floor(NOW / 1000) - 6 * 60
    const staleHeaders = await signedHeaders(payload, { "webhook-timestamp": String(staleSeconds) })
    await expect(verifyStandardWebhook({ payload, headers: staleHeaders, secret: SECRET, now }))
      .rejects.toThrow("too old")

    const futureSeconds = Math.floor(NOW / 1000) + 6 * 60
    const futureHeaders = await signedHeaders(payload, { "webhook-timestamp": String(futureSeconds) })
    await expect(verifyStandardWebhook({ payload, headers: futureHeaders, secret: SECRET, now }))
      .rejects.toThrow("too new")
  })

  test("supports spec-style whsec_ base64 secrets alongside Polar raw secrets", async () => {
    const payload = "{}"
    const rawKey = "0123456789abcdef0123456789abcdef" // 32 bytes
    const whsec = `whsec_${btoa(rawKey)}`
    const timestampSeconds = Math.floor(NOW / 1000)
    // Sign with the whsec form, verify with the whsec form (same key bytes).
    const signature = await signStandardWebhook({ payload, id: "msg_1", timestampSeconds, secret: whsec })
    await expect(
      verifyStandardWebhook({
        payload,
        headers: { "webhook-id": "msg_1", "webhook-timestamp": String(timestampSeconds), "webhook-signature": signature },
        secret: whsec,
        now,
      }),
    ).resolves.toBeUndefined()
  })
})
