import type { ElicitRequestFormParams, ElicitRequestURLParams, ElicitResult } from "@modelcontextprotocol/sdk/types.js"
import type { ClaxedoMcpClient } from "./client/contract"

/** OAuth scopes offered at consent; a user credential carries the subset it was granted. */
export type McpScope = "read" | "act" | "approve" | "admin"

export const MCP_SCOPES: readonly McpScope[] = ["read", "act", "approve", "admin"]

/**
 * Who is calling. The loopback mount admits only `runtime` credentials (the
 * one the runtime injected into a session it launched); the hosted and node
 * mounts admit `user` credentials (CLI JWT or an MCP OAuth token).
 */
export type McpCredential =
  | {
      kind: "runtime"
      runtimeId: string
      workspaceId: string
      /** The user the runtime serves; absent on an unsigned local desktop. */
      userId?: string
      /** Session named by the verified runtime credential. */
      sessionId?: string
      /** Account setting "agents may act on my other machines"; off by default. */
      crossMachineWrites: boolean
      readOnly: boolean
    }
  | {
      kind: "user"
      actorId: string
      scopes: ReadonlySet<McpScope>
      /** OAuth client id, or `cli` for the CLI JWT, or `loopback` on an unsigned node. */
      clientId: string
      readOnly: boolean
    }

export type McpAudience = McpCredential["kind"]

export type McpToolAccess = Readonly<{
  audiences: readonly McpAudience[]
  /** True for every tool whose runtime operation is in `WRITE_OPERATIONS`; hidden and denied in read-only. */
  write: boolean
  /** The scope a user credential must hold. */
  scope: McpScope
  /** Annotated `destructiveHint`, and runs only once the host's elicitation is accepted. */
  destructive?: boolean
  /**
   * The service this tool acts through, and the operation of it the tool
   * performs. A tool that names one exists only while the client carries that
   * service's grant, with the operation when it names one.
   */
  service?: McpToolService
  /** App plugin authoring; a tool that needs it exists only while the client carries the grant. */
  appPlugins?: true
  /**
   * Inside a session, exists only while the composition answers that only the
   * workspace's owner has driven it; a composition with no answer serves none.
   */
  ownerDriven?: true
}>

/** `label` names the service in a refusal: "<tool> needs the <label> service". */
export type McpToolService = Readonly<{ id: string; label: string; operation?: string }>

/** What the client was granted beyond the credential, read from the client rather than the credential: each service's operations. */
export type McpToolGrants = Readonly<{ services?: Readonly<Record<string, readonly string[]>>; appPlugins?: boolean; ownerDriven?: boolean }>

export function toolGrants(client: ClaxedoMcpClient): McpToolGrants {
  return {
    services: Object.fromEntries(Object.entries(client.services).map(([id, grant]) => [id, grant.operations])),
    appPlugins: client.appPlugins?.allowed() === true,
    ownerDriven: client.ownerDriven?.() === true,
  }
}

export type McpAuditEvent = Readonly<{
  tool: string
  credential: McpCredential
  args: Record<string, unknown>
  /** Session the write addressed, when the tool names one. */
  sessionId?: string
}>

export type McpToolContext = Readonly<{
  credential: McpCredential
  client: ClaxedoMcpClient
  /** Undefined when the connected client did not declare the elicitation capability. */
  elicit?: (params: ElicitRequestFormParams | ElicitRequestURLParams) => Promise<ElicitResult>
  audit: (event: McpAuditEvent) => void | Promise<void>
}>

export class McpAccessDenied extends Error {
  constructor(
    readonly code:
      | "audience"
      | "read-only"
      | "scope"
      | "cross-machine"
      | "own-workspace-only"
      | "own-children-only"
      | "owner-driven"
      | "recursion"
      | "service"
      | "app-plugins",
    message: string,
  ) {
    super(message)
    this.name = "McpAccessDenied"
  }
}

/**
 * The handler-side check; `tools/list` filtering is the courtesy, this is the
 * boundary.
 *
 * `grants` live on the client rather than the credential. Hosted, the control
 * plane mints the Tasks operations into the capability the mount presents, and
 * a composition hands app plugin authoring only to a session of the machine's
 * owner, so the credential the runtime signed for itself says nothing of either.
 */
export function assertToolAccess(
  credential: McpCredential,
  name: string,
  access: McpToolAccess,
  grants: McpToolGrants = {},
): void {
  if (!access.audiences.includes(credential.kind)) {
    throw new McpAccessDenied("audience", `${name} is not available to a ${credential.kind} credential`)
  }
  if (access.write && credential.readOnly) {
    throw new McpAccessDenied("read-only", `${name} is a write and this credential is read-only`)
  }
  if (credential.kind === "user" && !credential.scopes.has(access.scope)) {
    throw new McpAccessDenied("scope", `${name} requires the claxedo:${access.scope} scope`)
  }
  const { service } = access
  if (service) {
    const granted = grants.services?.[service.id]
    if (!granted) throw new McpAccessDenied("service", `${name} needs the ${service.label} service, which this Claxedo deployment does not serve`)
    if (service.operation && !granted.includes(service.operation)) {
      throw new McpAccessDenied("service", `${name} needs the ${service.operation} ${service.label} operation, which this session was not granted`)
    }
  }
  if (access.appPlugins && !grants.appPlugins) throw appPluginsDenied(name)
  if (access.ownerDriven && credential.kind === "runtime" && !grants.ownerDriven) {
    throw new McpAccessDenied("owner-driven", `${name} runs only in a session only its owner has driven`)
  }
}

export function appPluginsDenied(tool: string): McpAccessDenied {
  return new McpAccessDenied("app-plugins", `${tool} makes app plugins on this machine, which only its owner's sessions may do`)
}

export function toolListed(credential: McpCredential, access: McpToolAccess, grants: McpToolGrants = {}): boolean {
  try {
    assertToolAccess(credential, "", access, grants)
    return true
  } catch (error) {
    if (error instanceof McpAccessDenied) return false
    throw error
  }
}
