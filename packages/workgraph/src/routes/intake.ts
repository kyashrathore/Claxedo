import { Hono } from "hono"
import { z } from "zod"
import { zValidator } from "@hono/zod-validator"
import { Composio } from "@composio/core"
import { getWorkGraph } from "../model/registry"
import type { IConnectionStore } from "../sdk/connections"
import { normalizeGitHubWebhook } from "../connectors/github/webhook-events"

export type GitHubWebhookVerification = {
  deliveryId: string
  event?: string
  payload: unknown
}

export type GitHubWebhookVerifier = (input: {
  raw: string
  headers: Headers
}) => Promise<GitHubWebhookVerification | null>

export interface IntakeRouterOptions {
  scheduleTriage?: (intakeItemId: string) => void
  verifyGitHubWebhook?: GitHubWebhookVerifier
}

const manualSchema = z.object({
  title: z.string().nullable().optional(),
  body_md: z.string().min(1),
  repo_ref: z.string().nullable().optional(),
  triageMode: z.string().nullable().optional(),
  triage_mode: z.string().nullable().optional(),
})

export function intakeRouter(_connStore: IConnectionStore, opts: IntakeRouterOptions = {}) {
  const router = new Hono()

  router.get("/intake", (c) => {
    const repoRef = c.req.query("repoRef")
    const status = c.req.query("status")
    const items = Object.values(getWorkGraph().getState().intakeItems)
      .filter((item) => !repoRef || item.repoRef === repoRef)
      .filter((item) => !status || item.status === status)
    return c.json({ items })
  })

  router.post("/intake", zValidator("json", manualSchema), (c) => {
    const body = c.req.valid("json")
    const item = getWorkGraph().captureIntakeItem({
      kind: "manual",
      title: body.title,
      bodyMd: body.body_md,
      repoRef: body.repo_ref,
      triageModeOverride: body.triageMode ?? body.triage_mode,
    })
    opts.scheduleTriage?.(item.id)
    return c.json({ intakeItemId: item.id, sessionId: item.linkedSessionId }, 201)
  })

  router.patch("/intake/:id", zValidator("json", z.object({
    status: z.literal("archived"),
  })), (c) => {
    const item = getWorkGraph().getIntakeItem(c.req.param("id"))
    if (!item) return c.json({ error: "Intake item not found" }, 404)
    return c.json({ item: getWorkGraph().archiveIntakeItem(item.id) })
  })

  router.delete("/intake/:id", (c) => {
    const item = getWorkGraph().getIntakeItem(c.req.param("id"))
    if (!item) return c.json({ error: "Intake item not found" }, 404)
    getWorkGraph().deleteIntakeItem(item.id)
    return c.json({ ok: true })
  })

  router.post("/intake/webhooks/github", async (c) => {
    const raw = await c.req.text()
    const verified = await (opts.verifyGitHubWebhook ?? verifyComposioGitHubWebhook)({
      raw,
      headers: c.req.raw.headers,
    })
    if (!verified) return c.json({ error: "Invalid Composio webhook signature" }, 401)

    const normalized = normalizeGitHubWebhook(verified.event ?? inferGitHubEvent(verified.payload), verified.payload)
    if (!normalized) return c.json({ ignored: true })

    if (!getWorkGraph().recordExternalEventDedup({
      provider: "github",
      externalId: normalized.externalId,
      externalEventId: verified.deliveryId,
    })) {
      return c.json({ deduped: true })
    }

    const existing = getWorkGraph().getExternalReferenceByProvider("github", normalized.externalId)
    if (existing) {
      getWorkGraph().updateExternalReference(existing.id, {
        externalUrl: normalized.externalUrl,
        lastKnownState: normalized.lastKnownState,
      })
      getWorkGraph().appendIntakeActivity(existing.intakeItemId, {
        kind: normalized.activityKind,
        actor: "github",
        payload: normalized.activityPayload,
      })
      opts.scheduleTriage?.(existing.intakeItemId)
      return c.json({ intakeItemId: existing.intakeItemId, deduped: false })
    }

    const item = getWorkGraph().captureIntakeItem({
      kind: "external",
      title: normalized.title,
      bodyMd: normalized.bodyMd,
      repoRef: normalized.repoRef,
    })
    getWorkGraph().linkExternalReference({
      intakeItemId: item.id,
      provider: "github",
      externalId: normalized.externalId,
      externalUrl: normalized.externalUrl,
      lastKnownState: normalized.lastKnownState,
    })
    opts.scheduleTriage?.(item.id)
    return c.json({ intakeItemId: item.id, deduped: false })
  })

  return router
}

async function verifyComposioGitHubWebhook(input: { raw: string; headers: Headers }): Promise<GitHubWebhookVerification | null> {
  const secret = process.env.COMPOSIO_WEBHOOK_SECRET?.trim()
  const apiKey = process.env.COMPOSIO_API_KEY?.trim()
  const id = input.headers.get("webhook-id")
  const signature = input.headers.get("webhook-signature")
  const timestamp = input.headers.get("webhook-timestamp")
  if (!apiKey || !secret || !id || !signature || !timestamp) return null
  try {
    const result = await new Composio({ apiKey }).triggers.verifyWebhook({
      id,
      payload: input.raw,
      signature,
      timestamp,
      secret,
    })
    const payload = unwrapComposioPayload(result.payload)
    return {
      deliveryId: id,
      event: inferGitHubEvent(payload),
      payload,
    }
  } catch {
    return null
  }
}

function unwrapComposioPayload(value: unknown): unknown {
  const row = record(value)
  if (!row) return value
  const data = record(row.data)
  if (data?.issue && data?.repository) return data
  if (data?.payload) return data.payload
  return row.payload ?? value
}

function inferGitHubEvent(payload: unknown) {
  const row = record(payload)
  if (record(row?.comment)) return "issue_comment"
  if (record(row?.issue)) return "issues"
  return ""
}

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}











































