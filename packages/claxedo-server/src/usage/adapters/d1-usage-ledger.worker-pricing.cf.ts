import type { D1Database } from "@cloudflare/workers-types"
import { tokenTrackerPricing } from "@claxedo/server-core/usage/adapters/token-tracker-pricing"
import { readTurnUsageRevision } from "@claxedo/server-core/usage/contracts"
import { UsageRoutes } from "@claxedo/server-core/usage/routes"
import { createD1UsageLedger } from "./d1-usage-ledger"

const OWNER = { org_id: "org_acme", user_id: "user_alice" }

/**
 * The hosted usage view over the D1 ledger, priced from the catalog the hosted
 * composition chooses, with a door the test seeds revisions through.
 */
export default {
  async fetch(request: Request, env: { CONTROL_PLANE_DB: D1Database }) {
    const ledger = createD1UsageLedger({ database: env.CONTROL_PLANE_DB })
    if (new URL(request.url).pathname === "/seed") {
      const fact = readTurnUsageRevision(await request.json())
      if (!fact) return new Response("not a usage revision", { status: 400 })
      return Response.json(await ledger.writeRevision(fact, { owner: OWNER, turnId: "msg_user_seed" }))
    }
    return await UsageRoutes({ ledger, identity: async () => OWNER, pricing: tokenTrackerPricing("bundled") }).fetch(request)
  },
}
