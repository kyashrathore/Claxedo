import {
  CLAXEDO_MCP_PATH,
  CLAXEDO_MCP_TOOL_GROUPS,
  createClaxedoMcpRoutes,
  inProcessFetch,
  mcpAuditRecord,
  type TasksGrant,
  type VerifyRuntimeCredential,
} from "@claxedo/mcp"
import { createClaxedoMcpClient } from "@claxedo/mcp/client"
import type { WorkspaceRuntimeRouteContribution } from "@claxedo/workspace-runtime/route-contribution"
import { Log } from "@claxedo/server-core/platform/runtime/lib/log"

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
 * owner, and a call after a lapse carries none and acts as nobody. The Tasks
 * grant is the exception and the reason it is passed in rather than built
 * here: those tools leave the workspace for the control plane, carrying the
 * capability this root was launched with. It is read per MCP session because
 * it too is renewed: a session opened after a renewal lists what the renewed
 * scope carries, and one opened after a lapse lists no Tasks tools at all.
 */
export function firstPartyMcpRuntimeContribution(input: {
  verifyRuntimeCredential: VerifyRuntimeCredential
  /** This root's consented groups, read once at boot; the mount registers no others. */
  enabledToolGroups: readonly string[]
  tasks?: () => TasksGrant | undefined
  ownerGrant?: () => string | undefined
}): WorkspaceRuntimeRouteContribution {
  const { verifyRuntimeCredential, tasks, ownerGrant } = input
  return {
    id: FIRST_PARTY_MCP_RUNTIME_CONTRIBUTION_ID,
    mount(context) {
      const log = Log.create({ service: "claxedo-mcp", workspaceId: context.workspaceId })
      const workspace = { workspaceId: context.workspaceId, directory: context.directory }
      const mount = createClaxedoMcpRoutes({
        mount: "loopback",
        verifyRuntimeCredential,
        createClient: () => {
          const grant = tasks?.()
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
          })
        },
        registerTools: CLAXEDO_MCP_TOOL_GROUPS,
        enabledToolGroups: () => input.enabledToolGroups,
        audit: (event) => log.info("mcp.audit", mcpAuditRecord(event)),
      })
      return { path: CLAXEDO_MCP_PATH, routes: mount.routes, dispose: mount.dispose }
    },
  }
}
