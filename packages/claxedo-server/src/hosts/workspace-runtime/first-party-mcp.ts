import {
  CLAXEDO_MCP_PATH,
  CLAXEDO_MCP_TOOL_GROUPS,
  createClaxedoMcpRoutes,
  inProcessFetch,
  mcpAuditRecord,
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
 * reach exactly the routes this workspace serves and nothing outside it.
 */
export function firstPartyMcpRuntimeContribution(
  verifyRuntimeCredential: VerifyRuntimeCredential,
): WorkspaceRuntimeRouteContribution {
  return {
    id: FIRST_PARTY_MCP_RUNTIME_CONTRIBUTION_ID,
    mount(context) {
      const log = Log.create({ service: "claxedo-mcp", workspaceId: context.workspaceId })
      const workspace = { workspaceId: context.workspaceId, directory: context.directory }
      const mount = createClaxedoMcpRoutes({
        mount: "loopback",
        verifyRuntimeCredential,
        createClient: () => createClaxedoMcpClient({
          deployment: "loopback",
          local: { fetch: inProcessFetch((call) => context.fetch(call)), workspace },
        }),
        registerTools: CLAXEDO_MCP_TOOL_GROUPS,
        audit: (event) => log.info("mcp.audit", mcpAuditRecord(event)),
      })
      return { path: CLAXEDO_MCP_PATH, routes: mount.routes, dispose: mount.dispose }
    },
  }
}
