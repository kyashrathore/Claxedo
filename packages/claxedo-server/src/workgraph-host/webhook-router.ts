import type { ConnectionWebhookVerifier } from "@claxedo/connections"
import type { VerifiedWorkSourceSignal } from "@claxedo/workgraph/hosted"
import { ConnectionIDSchema } from "@claxedo/workgraph/contracts"
import { Hono } from "hono"

type WebhookIntake = Readonly<{
  receive(signal: VerifiedWorkSourceSignal): Promise<Readonly<{
    accepted: boolean
    reason: "processed" | "already_processed" | "in_progress"
    refreshed: number
  }>>
}>

export function createWorkGraphWebhookRouter(input: Readonly<{
  verifier: ConnectionWebhookVerifier
  intake: WebhookIntake
  resolveOrganizationId(connectionId: string): Promise<string | undefined>
  maxBodyBytes?: number
}>) {
  const router = new Hono()
  const maxBodyBytes = input.maxBodyBytes ?? 1_000_000

  router.post("/webhooks/:provider/:connectionId", async (context) => {
    const provider = context.req.param("provider")
    if (provider !== "github" && provider !== "linear" && provider !== "jira") {
      return context.json({ error: { code: "unsupported_provider" } }, 404)
    }
    const length = Number(context.req.header("content-length") ?? 0)
    if (length > maxBodyBytes) return context.json({ error: { code: "payload_too_large" } }, 413)
    const body = await readBody(context.req.raw, maxBodyBytes)
    if (!body) return context.json({ error: { code: "payload_too_large" } }, 413)
    const verification = await input.verifier.verify({
      connectionId: context.req.param("connectionId"),
      provider,
      headers: Object.fromEntries(context.req.raw.headers.entries()),
      body,
      receivedAt: Date.now(),
    }).then((value) => ({ value })).catch(() => ({ failed: true as const }))
    if ("failed" in verification) {
      context.header("retry-after", "60")
      return context.json({ error: { code: "webhook_verification_unavailable", retryable: true } }, 503)
    }
    const verified = verification.value
    if (!verified || verified.connectionId !== context.req.param("connectionId") || verified.provider !== provider) {
      return context.json({ error: { code: "invalid_webhook_signature" } }, 401)
    }
    const organizationId = await input.resolveOrganizationId(verified.connectionId).catch(() => undefined)
    if (!organizationId) {
      context.header("retry-after", "60")
      return context.json({ error: { code: "webhook_organization_unavailable", retryable: true } }, 503)
    }
    const result = await input.intake.receive({
      ...verified,
      organizationId,
      connectionId: ConnectionIDSchema.parse(verified.connectionId),
      provider,
    }).catch(() => undefined)
    if (!result) {
      context.header("retry-after", "60")
      return context.json({ error: { code: "webhook_processing_failed", retryable: true } }, 503)
    }
    if (result.reason === "in_progress") {
      context.header("retry-after", "1")
      return context.json({ ...result, retryable: true }, 503)
    }
    // Linear treats every status other than exactly 200 as a failed delivery.
    // Other providers accept the asynchronous 202 admission response.
    return context.json(result, result.reason === "already_processed" || provider === "linear" ? 200 : 202)
  })

  return router
}

async function readBody(request: Request, maxBodyBytes: number) {
  if (!request.body) return new Uint8Array()
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > maxBodyBytes) {
        await reader.cancel("payload_too_large").catch(() => undefined)
        return
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  const body = new Uint8Array(total)
  let offset = 0
  chunks.forEach((chunk) => {
    body.set(chunk, offset)
    offset += chunk.byteLength
  })
  return body
}
