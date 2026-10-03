import { describe, expect, test, vi } from "vitest"
import { cloudflareAuthEmailSender } from "./auth-email-delivery"
import { orgInvitationEmailDelivery } from "./auth-email-delivery"

describe("Cloudflare transactional email", () => {
  test("requires both the binding and sender address", () => {
    expect(cloudflareAuthEmailSender({})).toBeUndefined()
    expect(cloudflareAuthEmailSender({ CLAXEDO_EMAIL_FROM: "invite@example.com" })).toBeUndefined()
    expect(cloudflareAuthEmailSender({ EMAIL: { send: vi.fn() } })).toBeUndefined()
  })

  test.each(["invitation", "verification", "password-reset"] as const)("sends %s with HTML and text", async (kind) => {
    const send = vi.fn(async (_message: { to: string; from: string; subject: string; html: string; text: string }) => ({ messageId: "message-1" }))
    const sender = cloudflareAuthEmailSender({ EMAIL: { send }, CLAXEDO_EMAIL_FROM: "auth@example.com" })!
    await sender.send({ kind, recipient: "person@example.com", actionUrl: "https://app.example.com/invitations#secret&test", token: "secret" })
    expect(send).toHaveBeenCalledOnce()
    expect(send.mock.calls[0][0]).toMatchObject({ to: "person@example.com", from: "auth@example.com" })
    const message = send.mock.calls[0][0] as { subject: string; html: string; text: string }
    expect(message.subject).toBeTruthy()
    expect(message.text).toContain("https://app.example.com/invitations#secret&test")
    expect(message.html).toContain('href="https://app.example.com/invitations#secret&amp;test"')
  })

  test.each([
    ["E_SENDER_NOT_VERIFIED", "email_sender_not_verified", 503, false],
    ["E_SENDER_DOMAIN_NOT_AVAILABLE", "email_sender_domain_unavailable", 503, false],
    ["E_RECIPIENT_NOT_ALLOWED", "email_recipient_not_allowed", 403, false],
    ["E_RECIPIENT_SUPPRESSED", "email_recipient_suppressed", 409, false],
    ["E_RATE_LIMIT_EXCEEDED", "email_rate_limited", 429, true],
    ["E_DAILY_LIMIT_EXCEEDED", "email_daily_limit_exceeded", 429, true],
    ["E_DELIVERY_FAILED", "email_delivery_failed", 502, false],
    ["E_VALIDATION_ERROR", "email_invalid_message", 400, false],
    ["E_INTERNAL_SERVER_ERROR", "email_service_unavailable", 503, true],
    ["UNKNOWN", "email_delivery_failed", 502, false],
  ])("maps %s without inspecting provider message text", async (providerCode, code, status, retryable) => {
    const cause = Object.assign(new Error("private provider details"), { code: providerCode })
    const sender = cloudflareAuthEmailSender({ EMAIL: { send: async () => { throw cause } }, CLAXEDO_EMAIL_FROM: "auth@example.com" })!
    await expect(sender.send({ kind: "invitation", recipient: "person@example.com", actionUrl: "https://app.example.com/invitations#secret", token: "secret" }))
      .rejects.toMatchObject({ code, status, retryable, cause, message: "Transactional email delivery failed" })
  })

  test("invitation links keep the token in the fragment", async () => {
    const send = vi.fn(async () => undefined)
    const delivery = orgInvitationEmailDelivery({ verifiedEmail: async () => undefined, appOrigin: "https://app.example.com", sender: { send } })
    await delivery.sendInvitation!({ email: "person@example.com", token: "secret" })
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ actionUrl: "https://app.example.com/invitations#secret" }))
  })
})
