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
} from "@claxedo/mcp"
import type { McpAuditEvent, McpCredential } from "@claxedo/mcp/context"
import type { SessionMcpCredentials } from "./session-mcp-credentials"

export const FIRST_PARTY_MCP_CONTRIBUTION_ID = "claxedo-mcp"

export type FirstPartyMcpContributionInput = Readonly<{
  /** The composed app the tools re-enter in-process. Read at request time, so it may still be under composition. */
  app: { request: (input: Request) => Response | Promise<Response> }
  authority: Pick<WorkspaceAuthority, "auditAllow"> | undefined
  options: FirstPartyMcpOptions
  /** The signed identity behind a request, or undefined when it carries none this deployment accepts. */
  signedAuth: (request: Request) => Promise<SignedControlPlaneAuth | undefined>
  /** A consented OAuth access token, resolved by `resolveOAuthMcpCredential`. */
  oauthCredential?: (request: Request) => Promise<McpCredential | undefined>
  /** Where a write is recorded when no authority can attribute it. */
  auditFallback: (record: ReturnType<typeof mcpAuditRecord>) => void
  /** The bearer a session served by its own host presents; absent, the endpoint admits account credentials only. */
  sessionMcp?: SessionMcpCredentials
}>

/** The actor a signed control-plane identity acts as. */
export function signedActorId(auth: SignedControlPlaneAuth): string {
  return auth.principal?.actorId ?? auth.user.subject
}

export function firstPartyMcpContribution(input: FirstPartyMcpContributionInput): ControlPlaneRouteContribution {
  const auths = new WeakMap<McpCredential, SignedControlPlaneAuth>()
  const { sessionMcp } = input
  const enabledToolGroups = input.options.enabledToolGroups
  const registered = (input.options.registerTools ?? []).map((group) => group.id)
  const mount = createClaxedoMcpRoutes({
    mount: "hosted",
    ...(sessionMcp ? { verifyRuntimeCredential: (token: string) => sessionMcp.verify(token) } : {}),
    resolveUserCredential: async (request) => {
      const auth = await input.signedAuth(request)
      if (!auth) return await input.oauthCredential?.(request)
      const credential = fullUserCredential({ actorId: signedActorId(auth), clientId: "cli" })
      auths.set(credential, auth)
      return credential
    },
    createClient: async (credential, request) => {
      if (credential.kind === "runtime" && sessionMcp) {
        return input.options.createClient({
          deployment: "hosted",
          credential,
          request,
          local: { fetch: sessionMcp.workspaceFetch(credential), workspace: { workspaceId: credential.workspaceId } },
          sessionList: (workspaceId, limit) => sessionMcp.sessionList(credential, workspaceId, limit),
          ...(credential.sessionId ? { ownSession: { sessionId: credential.sessionId, fetch: sessionMcp.sessionHostFetch(credential) } } : {}),
        })
      }
      const authorization = request.headers.get("authorization")
      return input.options.createClient({
        deployment: "hosted",
        credential,
        request,
        ...(credential.kind === "user"
          ? {
              controlPlane: { fetch: inProcessFetch((call) => input.app.request(call), authorization ? { authorization } : {}) },
              documents: { fetch: inProcessFetch((call) => input.app.request(call), authorization ? { authorization } : {}) },
            }
          : {}),
      })
    },
    registerTools: input.options.registerTools ?? [],
    enabledToolGroups: async (credential: McpCredential) => {
      if (credential.kind === "runtime") return sessionMcp ? await sessionMcp.toolGroups(credential) : []
      return enabledToolGroups ? await enabledToolGroups(credential) : registered
    },
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
