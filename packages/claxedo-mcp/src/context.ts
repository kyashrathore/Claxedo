import type { ElicitRequestFormParams, ElicitRequestURLParams, ElicitResult } from "@modelcontextprotocol/sdk/types.js"
import type { ClaxedoMcpClient, TasksOperation } from "./client/contract"

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
  /** Human-only, annotated `destructiveHint`, and requires accepted host elicitation. */
  destructive?: boolean
  /** The Tasks operation this tool performs; a tool that names one exists only while the caller's grant carries it. */
  operation?: TasksOperation
  /** App plugin authoring; a tool that needs it exists only while the client carries the grant. */
  appPlugins?: true
}>

/** What the client was granted beyond the credential, read from the client rather than the credential. */
export type McpToolGrants = Readonly<{ tasks?: readonly TasksOperation[]; appPlugins?: boolean }>

export function toolGrants(client: ClaxedoMcpClient): McpToolGrants {
  return {
    ...(client.tasks ? { tasks: client.tasks.operations } : {}),
    appPlugins: client.appPlugins?.allowed() === true,
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
    readonly code: "audience" | "read-only" | "scope" | "cross-machine" | "own-children-only" | "recursion" | "tasks" | "app-plugins",
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
  const granted = grants.tasks
  if (access.operation) {
    if (!granted) throw new McpAccessDenied("tasks", `${name} needs the Tasks service, which this Claxedo deployment does not serve`)
    if (!granted.includes(access.operation)) {
      throw new McpAccessDenied("tasks", `${name} needs the ${access.operation} Tasks operation, which this session was not granted`)
    }
  }
  if (access.appPlugins && !grants.appPlugins) throw appPluginsDenied(name)
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
