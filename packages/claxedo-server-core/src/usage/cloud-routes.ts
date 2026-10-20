import { Hono, type Context } from "hono"
import type { CredentialSpendResponse, MachineTimeResponse } from "@claxedo/usage-contract"
import { ControlPlaneAuthError, controlPlaneAuthErrorBody } from "../platform/auth/auth"
import type { UsagePricing } from "./adapters/token-tracker-pricing"
import { credentialSpend, type OrgMemberName } from "./credential-spend"
import type { CredentialSpendScope, UsageProjectionLedger } from "./ledger"
import { usageRangeRefusal, usageSinceRefusal } from "./usage-range"

/**
 * The most cloud revisions one usage answer carries. A revision serializes to
 * about 1 KB (994 bytes with ULID ids and a full quality block), so the hosted
 * answer, the desktop's IPC hop and the sidecar request stay near 10 MB.
 */
export const MAX_CLOUD_USAGE_FACTS = 10_000

export type SignedUsageIdentity = { org_id: string; user_id: string }

const SCOPES: readonly CredentialSpendScope[] = ["mine", "org"]

function cloudUsageError(c: Context, status: 400 | 401 | 403 | 422 | 503, code: string, message: string) {
  return c.json({ error: { code, message } }, status)
}

/**
 * The signed account's own cloud reads: its cloud turns, which a signed desktop hands to its sidecar, its spend per
 * credential, and its cloud workspaces' machine time. Each is keyed by the caller's organization and person, never by
 * anything in the request; the organization accounts' spend answers the organization's owners and admins alone.
 */
export function CloudUsageRoutes(input: {
  ledger: UsageProjectionLedger
  identity: (request: Request) => Promise<SignedUsageIdentity | undefined>
  orgMembers: (request: Request) => Promise<readonly OrgMemberName[]>
  now: () => number
  pricing: UsagePricing
}) {
  const app = new Hono()
  const signed = (handler: (c: Context, identity: SignedUsageIdentity) => Promise<Response>) => async (c: Context) => {
    try {
      const identity = await input.identity(c.req.raw)
      if (!identity) return cloudUsageError(c, 401, "signed_org_required", "A signed organization session is required")
      return await handler(c, identity)
    } catch (error) {
      if (error instanceof ControlPlaneAuthError) return c.json(controlPlaneAuthErrorBody(error), error.status)
      throw error
    }
  }
  app.get("/cloud-facts", signed(async (c, identity) => {
    const refused = usageRangeRefusal(c.req.query("since"), c.req.query("until"))
    if (refused) return cloudUsageError(c, 400, "invalid_usage_range", refused)
    const since = Number(c.req.query("since"))
    const until = Number(c.req.query("until"))
    if (!input.ledger.cloudUsageFacts) return cloudUsageError(c, 503, "usage_projection_unavailable", "Cloud usage is not stored here")
    const facts = await input.ledger.cloudUsageFacts({ ...identity, since, until, limit: MAX_CLOUD_USAGE_FACTS + 1 })
    if (facts.length > MAX_CLOUD_USAGE_FACTS) {
      return cloudUsageError(c, 422, "cloud_usage_range_too_large", `More than ${MAX_CLOUD_USAGE_FACTS} cloud turns fall in this range; choose a shorter one`)
    }
    return c.json({ facts })
  }))
  app.get("/credentials", signed(async (c, identity) => {
    const refused = usageRangeRefusal(c.req.query("since"), c.req.query("until"))
    if (refused) return cloudUsageError(c, 400, "invalid_usage_range", refused)
    const since = Number(c.req.query("since"))
    const until = Number(c.req.query("until"))
    const scope = SCOPES.find((name) => name === (c.req.query("scope") ?? "mine"))
    if (!scope) return cloudUsageError(c, 400, "invalid_usage_scope", "scope must be mine or org")
    if (!input.ledger.credentialSpend) return cloudUsageError(c, 503, "usage_projection_unavailable", "Cloud usage is not stored here")
    const rows = await input.ledger.credentialSpend({ ...identity, scope, since, until })
    if (!rows) return cloudUsageError(c, 403, "usage_scope_forbidden", "Only an owner or admin of the organization can see its organization accounts' spend.")
    const members = scope === "org" ? await input.orgMembers(c.req.raw) : []
    return c.json({ since, until, scope, credentials: await credentialSpend(input.pricing, rows, members) } satisfies CredentialSpendResponse)
  }))
  app.get("/machine-time", signed(async (c, identity) => {
    const until = input.now()
    const refused = usageSinceRefusal(c.req.query("since"), until)
    if (refused) return cloudUsageError(c, 400, "invalid_usage_range", refused)
    const since = Number(c.req.query("since"))
    if (!input.ledger.machineTime) return cloudUsageError(c, 503, "usage_projection_unavailable", "Cloud machine time is not stored here")
    const time = await input.ledger.machineTime({ ...identity, since, until })
    return c.json({ since, until, ...time } satisfies MachineTimeResponse)
  }))
  return app
}
