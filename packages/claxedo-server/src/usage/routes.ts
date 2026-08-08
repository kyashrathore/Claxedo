import { Hono } from "hono"
import {
  ControlPlaneAuthError,
  controlPlaneAuthContext,
  controlPlaneAuthErrorBody,
  type ClerkVerifier,
  type ControlPlaneAuthConfig,
} from "@claxedo/server-core/platform/auth/auth"
import type { UsageLedger } from "../platform/telemetry/product/metering"

const dimensions = new Set(["harness", "model", "location", "session", "workspace"] as const)

export function UsageRoutes(input: {
  ledger: UsageLedger
  authConfig?: ControlPlaneAuthConfig
  verifier?: ClerkVerifier
}) {
  const app = new Hono()
  app.get("/", async (c) => {
    try {
      const auth = await controlPlaneAuthContext(c.req.raw, {
        config: input.authConfig,
        verifier: input.verifier,
      })
      if (auth.mode !== "signed" || !auth.user.orgId) {
        return c.json({ error: "signed_org_required", message: "A signed organization session is required" }, 401)
      }
      const since = Number(c.req.query("since"))
      const until = Number(c.req.query("until"))
      if (!Number.isFinite(since) || !Number.isFinite(until) || until < since) {
        return c.json({ error: "invalid_usage_range", message: "since and until must define a valid range" }, 400)
      }
      if (!input.ledger.usageDashboard) {
        return c.json({ error: "usage projection unavailable" }, 503)
      }
      const identity = { org_id: auth.user.orgId, user_id: auth.user.subject }
      const summary = await input.ledger.usageDashboard({ ...identity, since, until })
      const group = c.req.query("group")
      if (!group) return c.json({ summary })
      if (!dimensions.has(group as never)) {
        return c.json({ error: "invalid_usage_group", message: "group is invalid" }, 400)
      }
      const breakdown = input.ledger.usageBreakdown
        ? await input.ledger.usageBreakdown({
            ...identity,
            since,
            until,
            dimension: group as "harness" | "model" | "location" | "session" | "workspace",
            ...(c.req.query("after") ? { after: c.req.query("after") } : {}),
            ...(c.req.query("limit") ? { limit: Number(c.req.query("limit")) } : {}),
          })
        : undefined
      return c.json({ summary, ...(breakdown ? { breakdown } : {}) })
    } catch (error) {
      if (error instanceof ControlPlaneAuthError) {
        return c.json(controlPlaneAuthErrorBody(error), error.status as 400 | 401 | 403)
      }
      throw error
    }
  })
  return app
}
