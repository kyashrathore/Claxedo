/**
 * The `/api/claxedo/mcp` contribution the hosted worker and the self-hosted
 * node both mount. The two differ in who they admit and what they serve
 * in-process; everything else is this one module.
 */
import type { ControlPlaneRouteContribution } from "@claxedo/server-core/platform/http/route-contribution"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
import {
  CLAXEDO_MCP_PATH,
  createClaxedoMcpRoutes,
  fullUserCredential,
  inProcessFetch,
  mcpAuditRecord,
  type FirstPartyMcpOptions,
  type McpClientInputs,
} from "@claxedo/mcp"
import type { McpAuditEvent, McpCredential } from "@claxedo/mcp/context"

export const FIRST_PARTY_MCP_CONTRIBUTION_ID = "claxedo-mcp"

export type FirstPartyMcpContributionInput = Readonly<{
  mount: "hosted" | "node"
  /** The composed app the tools re-enter in-process. Read at request time, so it may still be under composition. */
  app: { request: (input: Request) => Response | Promise<Response> }
  authority: Pick<WorkspaceAuthority, "auditAllow"> | undefined
  options: FirstPartyMcpOptions
  /** The signed identity behind a request, or undefined when it carries none this deployment accepts. */
  signedAuth: (request: Request) => Promise<SignedControlPlaneAuth | undefined>
  /** A caller this deployment admits with no identity at all: the node's unsigned loopback. */
  anonymousCredential?: (request: Request) => McpCredential | undefined
  /** A consented OAuth access token, resolved by `resolveOAuthMcpCredential`. */
  oauthCredential?: (request: Request) => Promise<McpCredential | undefined>
  /** The runtimes this process serves, for a credential that may reach them; absent on the hosted worker. */
  local?: (credential: McpCredential) => McpClientInputs["local"]
  /**
   * This deployment's Tasks routes, as this credential may reach them. Absent
   * on a deployment that serves no Tasks, and then the tools are not listed.
   */
  tasks?: (credential: McpCredential) => Promise<McpClientInputs["tasks"]> | McpClientInputs["tasks"]
  /** Where a write is recorded when no authority can attribute it. */
  auditFallback: (record: ReturnType<typeof mcpAuditRecord>) => void
}>

/** The actor a signed control-plane identity acts as. */
export function signedActorId(auth: SignedControlPlaneAuth): string {
  return auth.principal?.actorId ?? auth.user.subject
}

export function firstPartyMcpContribution(input: FirstPartyMcpContributionInput): ControlPlaneRouteContribution {
  const auths = new WeakMap<McpCredential, SignedControlPlaneAuth>()
  const mount = createClaxedoMcpRoutes({
    mount: input.mount,
    ...(input.options.verifyRuntimeCredential ? { verifyRuntimeCredential: input.options.verifyRuntimeCredential } : {}),
    resolveUserCredential: async (request) => {
      const auth = await input.signedAuth(request)
      if (!auth) return await input.oauthCredential?.(request) ?? input.anonymousCredential?.(request)
      const credential = fullUserCredential({ actorId: signedActorId(auth), clientId: "cli" })
      auths.set(credential, auth)
      return credential
    },
    createClient: async (credential, request) => {
      const authorization = request.headers.get("authorization")
      const tasks = await input.tasks?.(credential)
      return input.options.createClient({
        deployment: input.mount,
        credential,
        request,
        ...(credential.kind === "user"
          ? {
              controlPlane: { fetch: inProcessFetch((call) => input.app.request(call), authorization ? { authorization } : {}) },
              documents: { fetch: inProcessFetch((call) => input.app.request(call), authorization ? { authorization } : {}) },
            }
          : {}),
        ...(input.local ? { local: input.local(credential) } : {}),
        ...(tasks ? { tasks } : {}),
      })
    },
    registerTools: input.options.registerTools ?? [],
    ...(input.options.enabledToolGroups ? { enabledToolGroups: input.options.enabledToolGroups } : {}),
    audit: async (event: McpAuditEvent) => {
      const record = mcpAuditRecord(event)
      const auth = auths.get(event.credential)
      if (!auth || !input.authority) {
        input.auditFallback(record)
        return
      }
      await input.authority.auditAllow(auth, {
        action: `mcp.${event.tool}`,
        ...(event.credential.kind === "runtime" ? { workspaceId: event.credential.workspaceId } : {}),
        metadata: record,
      })
    },
    ...(input.options.crossMachineWrites ? { crossMachineWrites: input.options.crossMachineWrites } : {}),
  })
  return { id: FIRST_PARTY_MCP_CONTRIBUTION_ID, path: CLAXEDO_MCP_PATH, routes: mount.routes }
}
