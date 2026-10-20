import {
  CLAXEDO_MCP_PATH,
  createClaxedoMcpRoutes,
  inProcessFetch,
  mcpAuditRecord,
  type McpServiceGrant,
  type McpToolGroup,
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
 * owner, and a call after a lapse carries none and acts as nobody. Service
 * grants are the exception and the reason they are passed in rather than
 * built here: those tools leave the workspace for the control plane, carrying
 * the capability this root was launched with. They are read per MCP session
 * because they too are renewed: a session opened after a renewal lists what
 * the renewed scope carries, and one opened after a lapse lists none of that
 * service's tools.
 */
export function firstPartyMcpRuntimeContribution(input: {
  verifyRuntimeCredential: VerifyRuntimeCredential
  /** This root's consented groups, read once at boot; the mount registers no others. */
  enabledToolGroups: readonly string[]
  /** The groups this mount serves: the core groups and those of the plugins the root is composed with. */
  registerTools: readonly McpToolGroup[]
  services?: () => Readonly<Record<string, McpServiceGrant>>
  ownerGrant?: () => string | undefined
  /** The owner grant's actor; a session is owner-driven only while every turn in its lineage is this actor's. */
  ownerActorId?: () => string | undefined
}): WorkspaceRuntimeRouteContribution {
  const { verifyRuntimeCredential, services, ownerGrant } = input
  return {
    id: FIRST_PARTY_MCP_RUNTIME_CONTRIBUTION_ID,
    mount(context) {
      const log = Log.create({ service: "claxedo-mcp", workspaceId: context.workspaceId })
      const workspace = { workspaceId: context.workspaceId, directory: context.directory }
      const mount = createClaxedoMcpRoutes({
        mount: "loopback",
        verifyRuntimeCredential,
        createClient: (credential) => {
          const sessionId = credential.kind === "runtime" ? credential.sessionId : undefined
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
            services: services?.() ?? {},
            ownerDriven: () => {
              const ownerActorId = input.ownerActorId?.()
              return !!sessionId && !!ownerActorId && context.sessionDrivenOnlyBy(sessionId, ownerActorId)
            },
          })
        },
        registerTools: input.registerTools,
        enabledToolGroups: () => input.enabledToolGroups,
        audit: (event) => log.info("mcp.audit", mcpAuditRecord(event)),
      })
      return { path: CLAXEDO_MCP_PATH, routes: mount.routes, dispose: mount.dispose }
    },
  }
}
