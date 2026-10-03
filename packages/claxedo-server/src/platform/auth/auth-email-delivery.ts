import { ClaxedoError } from "@claxedo/server-core/platform/errors/base"
import type { OrgInvitationDelivery } from "@claxedo/server-core/platform/auth/org-access-authority"
import type { AuthEmailMessage, AuthEmailSender } from "./better-auth-configuration"

export type CloudflareEmailBinding = {
  send(message: { to: string; from: string; subject: string; html: string; text: string }): Promise<{ messageId: string }>
}

const EMAIL_FAILURES = {
  E_SENDER_NOT_VERIFIED: { code: "email_sender_not_verified", status: 503, retryable: false },
  E_SENDER_DOMAIN_NOT_AVAILABLE: { code: "email_sender_domain_unavailable", status: 503, retryable: false },
  E_RECIPIENT_NOT_ALLOWED: { code: "email_recipient_not_allowed", status: 403, retryable: false },
  E_RECIPIENT_SUPPRESSED: { code: "email_recipient_suppressed", status: 409, retryable: false },
  E_RATE_LIMIT_EXCEEDED: { code: "email_rate_limited", status: 429, retryable: true },
  E_DAILY_LIMIT_EXCEEDED: { code: "email_daily_limit_exceeded", status: 429, retryable: true },
  E_DELIVERY_FAILED: { code: "email_delivery_failed", status: 502, retryable: false },
  E_INTERNAL_SERVER_ERROR: { code: "email_service_unavailable", status: 503, retryable: true },
} as const

const EMAIL_FAILURE_BY_CODE = new Map<string, { code: string; status: number; retryable: boolean }>(Object.entries(EMAIL_FAILURES))

const INVALID_MESSAGE_CODES = new Set([
  "E_VALIDATION_ERROR", "E_FIELD_MISSING", "E_TOO_MANY_RECIPIENTS", "E_TOO_MANY_ATTACHMENTS", "E_CONTENT_TOO_LARGE",
  "E_HEADER_NOT_ALLOWED", "E_HEADER_USE_API_FIELD", "E_HEADER_VALUE_INVALID", "E_HEADER_VALUE_TOO_LONG",
  "E_HEADER_NAME_INVALID", "E_HEADERS_TOO_LARGE", "E_HEADERS_TOO_MANY",
])

function cloudflareEmailDeliveryError(cause: unknown) {
  const providerCode = cause && typeof cause === "object" && "code" in cause ? cause.code : undefined
  const known = typeof providerCode === "string" ? EMAIL_FAILURE_BY_CODE.get(providerCode) : undefined
  const failure = known ?? (typeof providerCode === "string" && INVALID_MESSAGE_CODES.has(providerCode)
    ? { code: "email_invalid_message", status: 400, retryable: false }
    : EMAIL_FAILURES.E_DELIVERY_FAILED)
  return new ClaxedoError({ ...failure, message: "Transactional email delivery failed", cause })
}

const EMAIL_ACTIONS: Record<AuthEmailMessage["kind"], string> = {
  invitation: "Join your Claxedo organization",
  verification: "Verify your Claxedo email",
  "password-reset": "Reset your Claxedo password",
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!)
}

export function cloudflareAuthEmailSender(env: { EMAIL?: CloudflareEmailBinding; CLAXEDO_EMAIL_FROM?: string }): AuthEmailSender | undefined {
  const binding = env.EMAIL
  const from = env.CLAXEDO_EMAIL_FROM?.trim()
  if (!binding || typeof binding.send !== "function" || !from) return undefined
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(from)) {
    throw new ClaxedoError({ code: "email_sender_invalid", status: 503, message: "CLAXEDO_EMAIL_FROM must be an email address" })
  }
  return {
    async send(message) {
      const subject = EMAIL_ACTIONS[message.kind]
      try {
        await binding.send({
          to: message.recipient,
          from,
          subject,
          html: `<p>${subject}</p><p><a href="${escapeHtml(message.actionUrl)}">${subject}</a></p>`,
          text: `${subject}\n\n${message.actionUrl}`,
        })
      } catch (cause) {
        throw cloudflareEmailDeliveryError(cause)
      }
    },
  }
}

export function orgInvitationEmailDelivery(input: {
  verifiedEmail: OrgInvitationDelivery["verifiedEmail"]
  appOrigin: string
  sender?: AuthEmailSender
}): OrgInvitationDelivery {
  const sender = input.sender
  return {
    ...(sender
      ? {
          sendInvitation: ({ email, token }: { email: string; token: string }) =>
            sender.send({
              kind: "invitation",
              recipient: email,
              actionUrl: new URL(`/invitations#${encodeURIComponent(token)}`, input.appOrigin).toString(),
              token,
            }),
        }
      : {}),
    verifiedEmail: input.verifiedEmail,
  }
}
