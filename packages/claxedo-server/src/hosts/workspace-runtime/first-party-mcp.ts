import {
  CLAXEDO_MCP_PATH,
  CLAXEDO_MCP_TOOL_GROUPS,
  createClaxedoMcpRoutes,
  inProcessFetch,
  mcpAuditRecord,
  type TasksGrant,
  type SessionCleanupGrant,
  type VerifyRuntimeCredential,
} from "@claxedo/mcp"
import { createClaxedoMcpClient } from "@claxedo/mcp/client"
import type { WorkspaceRuntimeRouteContribution } from "@claxedo/workspace-runtime/route-contribution"
import { Log } from "@claxedo/server-core/platform/runtime/lib/log"
import { Hono } from "hono"
import { asRecord, stringField } from "@claxedo/server-core/platform/json/index"
import { bearerToken } from "@claxedo/helpers/string"

export const FIRST_PARTY_MCP_RUNTIME_CONTRIBUTION_ID = "claxedo-mcp"

/**
 * The first-party MCP endpoint for the sessions a cloud runtime launches.
 *
 * A contribution rather than an import inside the runtime: the runtime is the
 * local execution core, and a capability it imported would sit in the closure
 * of every runtime, including the desktop-local one that serves this endpoint
 * from its own process instead.
 *
 * The tools re-enter this runtime through the seam's in-process fetch, so they
 * reach exactly the routes this workspace serves and nothing outside it. Each
 * call carries the owner grant, read at the call because the grant is renewed
 * while the root runs: the runtime verifies it and acts as the workspace's
 * owner, and a call after a lapse carries none and acts as nobody. Tasks and
 * Session cleanup leave the workspace for the control plane. The Tasks grant
 * is read per MCP session as it renews. Cleanup receives the verified session
 * and its original runtime credential so the control plane can independently
 * verify origin before issuing a user-bound cleanup capability. The root's
 * cleanup issuer proof cannot read inventory or delete sessions directly.
 */
export function firstPartyMcpRuntimeContribution(input: {
  verifyRuntimeCredential: VerifyRuntimeCredential
  /** This root's consented groups, read once at boot; the mount registers no others. */
  enabledToolGroups: readonly string[]
  tasks?: () => TasksGrant | undefined
  ownerGrant?: () => string | undefined
  sessionCleanup?: (sessionId: string, credential: string) => SessionCleanupGrant | undefined
}): WorkspaceRuntimeRouteContribution {
  const { verifyRuntimeCredential, tasks, ownerGrant, sessionCleanup } = input
  return {
    id: FIRST_PARTY_MCP_RUNTIME_CONTRIBUTION_ID,
    mount(context) {
      const log = Log.create({ service: "claxedo-mcp", workspaceId: context.workspaceId })
      const workspace = { workspaceId: context.workspaceId, directory: context.directory }
      const mount = createClaxedoMcpRoutes({
        mount: "loopback",
        verifyRuntimeCredential,
        createClient: (credential, request) => {
          const grant = tasks?.()
          const proof = bearerToken(request.headers.get("authorization"))
          const cleanup = credential.kind === "runtime" && credential.sessionId && proof
            ? sessionCleanup?.(credential.sessionId, proof) : undefined
          return createClaxedoMcpClient({
            deployment: "loopback",
            local: {
              fetch: inProcessFetch((call) => {
                const grant = ownerGrant?.()
                if (grant) call.headers.set("authorization", `Bearer ${grant}`)
                return context.fetch(call)
              }),
              workspace,
            },
            ...(grant ? { tasks: grant } : {}),
            ...(cleanup ? { sessionCleanup: cleanup } : {}),
          })
        },
        registerTools: CLAXEDO_MCP_TOOL_GROUPS,
        enabledToolGroups: () => input.enabledToolGroups,
        audit: (event) => log.info("mcp.audit", mcpAuditRecord(event)),
      })
      const routes = new Hono().route(CLAXEDO_MCP_PATH, mount.routes)
      routes.post("/api/claxedo/session-cleanup/credential", async (c) => {
        const actor = asRecord(asRecord(c.var)?.relayHostAuth)
        if (actor?.role !== "owner" || actor.workspace_id !== context.workspaceId || actor.principal_kind !== "user" || actor.actor_kind !== "human" || actor.session_id !== undefined) {
          return c.json({ error: { code: "session_cleanup_proof_access_denied" } }, 403)
        }
        const token = stringField(asRecord(await c.req.json().catch(() => undefined)), "credential")
        const claims = token ? await verifyRuntimeCredential(token) : undefined
        if (!claims?.sessionId || claims.workspaceId !== context.workspaceId) return c.json({ error: { code: "session_cleanup_origin_invalid" } }, 401)
        return c.json({ runtimeId: claims.runtimeId, workspaceId: claims.workspaceId, sessionId: claims.sessionId })
      })
      return { path: "/", routes, dispose: mount.dispose }
    },
  }
}
