import { httpRouter } from "convex/server"
import { httpAction } from "./_generated/server"
import { anyApi } from "convex/server"
import { Webhook } from "svix"

const http = httpRouter()
const api = anyApi as any

type ClerkWebhookVerifier = (payload: string, headers: Record<string, string>) => unknown

function svixVerifier(secret: string): ClerkWebhookVerifier {
  return (payload, headers) => new Webhook(secret).verify(payload, headers)
}

export function clerkWebhookEvent(input: {
  payload: string
  headers: Headers
  secret?: string
  verifier?: ClerkWebhookVerifier
}) {
  try {
    return (input.verifier ?? svixVerifier(input.secret!))(input.payload, {
      "svix-id": input.headers.get("svix-id") ?? "",
      "svix-timestamp": input.headers.get("svix-timestamp") ?? "",
      "svix-signature": input.headers.get("svix-signature") ?? "",
    }) as { type?: string; data?: unknown }
  } catch {
    return undefined
  }
}

export function clerkWebhookHandler(input: {
  secret?: string
  verifier?: ClerkWebhookVerifier
} = {}) {
  return httpAction(async (ctx, request) => {
    const secret = input.secret ?? process.env.CLERK_WEBHOOK_SECRET
    if (!input.verifier && !secret) return Response.json({ error: "missing_webhook_secret" }, { status: 503 })
    const payload = await request.text()
    const event = clerkWebhookEvent({ payload, headers: request.headers, secret, verifier: input.verifier })
    if (!event) return Response.json({ error: "invalid_webhook_signature" }, { status: 401 })
    if (!event.type) return Response.json({ error: "invalid_webhook_event" }, { status: 400 })
    await ctx.runMutation(api.orgs.applyClerkWebhook, {
      type: event.type,
      data: event.data ?? {},
    })
    return Response.json({ ok: true })
  })
}

http.route({
  path: "/api/clerk/webhook",
  method: "POST",
  handler: clerkWebhookHandler(),
})

export default http
