import { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { z } from "zod"
import { deliveredDirect } from "@claxedo/server-core/credentials/reach"
import type { WorkspaceOwnerIdentity } from "@claxedo/server-core/platform/auth/authority"
import type { ControlPlaneCredentials } from "../authority/services"
import { ownerDirectRows } from "../credentials/direct-rows"
import { turnLeaseAuthority, type TurnLeaseProofs } from "../session/turn-lease-authority"

export type RuntimeCredentialRefreshOptions = {
  resolveWorkspaceOwner(workspaceId: string): Promise<WorkspaceOwnerIdentity | undefined>
  credentials(orgId: string): ControlPlaneCredentials
}

const requestSchema = z.object({
  turnLease: z.string().min(1),
  credentialProviderId: z.string().min(1),
  rejectedExpiresAt: z.number().int().positive().optional(),
}).strict()

/**
 * A cloud sandbox's harness asking for a fresh copy of a credential it was
 * handed directly, mid-turn: a ChatGPT plan whose token is about to expire or
 * was refused. Proven by the running turn's lease, it answers the workspace
 * owner's own account for that provider, renewed in the store first when it
 * is due or holds nothing newer than the refused token. Only a plan the
 * sandbox is already handed as its token can be asked for: every other
 * account reaches a sandbox behind an edge, never as its secret. The refresh
 * token stays in the store.
 */
export function RuntimeCredentialRefreshRoutes(input: RuntimeCredentialRefreshOptions & TurnLeaseProofs) {
  return new Hono().post("/:workspaceId", bodyLimit({ maxSize: 16 * 1024 }), async (c) => {
    c.header("cache-control", "no-store")
    const parsed = requestSchema.safeParse(await c.req.json().catch(() => undefined))
    if (!parsed.success) return c.json({ error: { code: "credential_refresh_request_invalid" } }, 400)
    const { credentialProviderId, rejectedExpiresAt } = parsed.data
    if (!deliveredDirect({ provider_id: credentialProviderId, kind: "oauth_token" })) return c.json({ error: { code: "credential_refresh_denied" } }, 403)
    const claims = await turnLeaseAuthority(input, parsed.data.turnLease)
    if (claims === "invalid") return c.json({ error: { code: "session_turn_lease_invalid" } }, 401)
    const workspaceId = c.req.param("workspaceId")
    const owner = claims === "denied" || claims.workspaceId !== workspaceId ? undefined : await input.resolveWorkspaceOwner(workspaceId)
    if (claims === "denied" || !owner || owner.orgId !== claims.orgId) return c.json({ error: { code: "credential_refresh_denied" } }, 403)
    const rows = await ownerDirectRows(input.credentials(owner.orgId), owner.userId, {
      providers: new Set([credentialProviderId]),
      ...(rejectedExpiresAt === undefined ? {} : { rejectedExpiresAt }),
    })
    const row = rows[credentialProviderId]
    return row?.authKind === "subscription" ? c.json(row) : c.json({ error: { code: "credential_unavailable" } }, 409)
  })
}
