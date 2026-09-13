/**
 * The `/api/claxedo/mcp` route: one streamable-HTTP MCP endpoint, mounted by
 * whichever Claxedo process is already running. The mount decides which
 * credentials it admits; the credential decides which tools exist.
 */
import { Hono } from "hono"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import {
  isJSONRPCErrorResponse,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  ListToolsRequestSchema,
  type ElicitRequestFormParams,
  type ElicitRequestURLParams,
  type RequestId,
} from "@modelcontextprotocol/sdk/types.js"
import { bearerToken } from "@claxedo/helpers/string"
import type { ClaxedoFetch, ClaxedoMcpClient, TasksGrant, WorkspaceTarget } from "./client/contract"
import { MCP_SCOPES, type McpAuditEvent, type McpCredential, type McpToolContext } from "./context"
import { createToolRegistry } from "./tools/registry"
import { isLoopbackRequest } from "./endpoint/loopback"
import { createMcpSessionStore } from "./endpoint/sessions"
import { createInFlightCounter, releaseWhenSettled } from "./endpoint/in-flight"

import type { ClaxedoMcpToolGroupDescription, ClaxedoMcpToolGroupId, McpToolGroup } from "./tools/index"
export {
  CLAXEDO_MCP_TOOL_GROUPS,
  CLAXEDO_MCP_TOOL_GROUP_IDS,
  claxedoMcpToolGroupInventory,
  claxedoMcpToolGroupsFor,
} from "./tools/index"
export type { ClaxedoMcpToolGroupDescription, ClaxedoMcpToolGroupId, McpToolGroup }
export type { TasksGrant, TasksOperation } from "./client/contract"

export const CLAXEDO_MCP_PATH = "/api/claxedo/mcp"
export const OAUTH_PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource"

/**
 * What every mount reports as `serverInfo`.
 *
 * A literal, not a read of this package's `package.json`: two of the four
 * mounts are bundled — the Cloudflare worker has no filesystem at all and the
 * desktop's server bundle sits beside the Electron app's `package.json`, not
 * this one — so a read resolves to the wrong file or to nothing, which is how
 * every mount ended up reporting `npm_package_version || "unknown"`.
 * `server.test.ts` fails when it drifts from the package version.
 */
export const CLAXEDO_MCP_SERVER_INFO = { name: "claxedo", version: "0.5.0" } as const

export type ClaxedoMcpMount = "loopback" | "hosted" | "node"

/** What the runtime that launched a session vouches for when it verifies its own bearer. */
export type RuntimeCredentialClaims = Readonly<{
  runtimeId: string
  workspaceId: string
  sessionId?: string
  userId?: string
  permissionMode?: string
  expiresAt: number
}>

export type VerifyRuntimeCredential = (
  token: string,
) => Promise<RuntimeCredentialClaims | undefined> | RuntimeCredentialClaims | undefined

/** What a mount can offer the client factory: the runtime in this process and the control plane as the caller. */
export type McpClientInputs = Readonly<{
  deployment: ClaxedoMcpMount
  credential: McpCredential
  request: Request
  local?: Readonly<{ fetch: ClaxedoFetch; workspace: WorkspaceTarget }>
  controlPlane?: Readonly<{ fetch: ClaxedoFetch }>
  documents?: Readonly<{ fetch: ClaxedoFetch }>
  tasks?: TasksGrant
}>

/** The option every mount takes from its composition root. */
export type FirstPartyMcpOptions = Readonly<{
  verifyRuntimeCredential?: VerifyRuntimeCredential
  createClient: (input: McpClientInputs) => ClaxedoMcpClient | Promise<ClaxedoMcpClient>
  registerTools?: ReadonlyArray<McpToolGroup>
  enabledToolGroups?: (credential: McpCredential) => readonly string[] | Promise<readonly string[]>
  crossMachineWrites?: (claims: RuntimeCredentialClaims) => boolean
}>

/** A loopback mount admits nothing but the runtime credential, so the verifier is not optional there. */
export type LoopbackFirstPartyMcpOptions = FirstPartyMcpOptions & Readonly<{ verifyRuntimeCredential: VerifyRuntimeCredential }>

export type ClaxedoMcpMountOptions = Readonly<{
  mount: ClaxedoMcpMount
  verifyRuntimeCredential?: VerifyRuntimeCredential
  /**
   * Returns undefined for a request that carries no valid user credential;
   * never throws for one. The object it returns is the credential handed to
   * `createClient` and `audit`, so a mount may key per-credential state on it,
   * and it carries its own `readOnly`, which for an OAuth token is decided by
   * the scopes the user consented to.
   */
  resolveUserCredential?: (request: Request) => Promise<McpCredential | undefined>
  createClient: (credential: McpCredential, request: Request) => ClaxedoMcpClient | Promise<ClaxedoMcpClient>
  registerTools: ReadonlyArray<McpToolGroup>
  /**
   * The tool groups this caller consented to, out of `registerTools`.
   *
   * A group left out is never registered, so it is absent from `tools/list`
   * and unknown to `tools/call`: consent decides the surface, and a tool asked
   * for by name outside it is refused by not existing. Absent means this mount
   * gates nothing, which a loopback mount — the one a session reaches — is not
   * allowed to be.
   */
  enabledToolGroups?: (credential: McpCredential) => readonly string[] | Promise<readonly string[]>
  audit: (event: McpAuditEvent) => void | Promise<void>
  crossMachineWrites?: (claims: RuntimeCredentialClaims) => boolean
  maxInFlightPerCredential?: number
  maxSessions?: number
  sessionIdleMs?: number
  now?: () => number
}>

const DEFAULT_MAX_IN_FLIGHT = 8
const DEFAULT_MAX_SESSIONS = 256
const DEFAULT_SESSION_IDLE_MS = 30 * 60_000

/** The CLI JWT and the node's loopback caller are the whole account: every scope, nothing read-only. */
export function fullUserCredential(input: Readonly<{ actorId: string; clientId: string }>): McpCredential {
  return { kind: "user", actorId: input.actorId, scopes: new Set(MCP_SCOPES), clientId: input.clientId, readOnly: false }
}

/** The origin in-process requests are addressed to; loopback, so an unsigned local guard admits them. */
const IN_PROCESS_ORIGIN = "http://127.0.0.1"

/** A `ClaxedoFetch` that hands each request to an app in this process, with the headers a mount stamps on every call. */
export function inProcessFetch(
  handle: (request: Request) => Promise<Response> | Response,
  headers: Readonly<Record<string, string>> = {},
): ClaxedoFetch {
  return async (path, init) => {
    const request = new Request(new URL(path, IN_PROCESS_ORIGIN), init)
    for (const [name, value] of Object.entries(headers)) request.headers.set(name, value)
    return handle(request)
  }
}

/** The one flattening of an audit event every sink writes: who acted, through which client, on which session. */
export function mcpAuditRecord(event: McpAuditEvent) {
  const { credential } = event
  return {
    tool: event.tool,
    actor: credential.kind === "runtime" ? credential.userId ?? `runtime:${credential.runtimeId}` : credential.actorId,
    client: credential.kind === "runtime" ? `runtime:${credential.runtimeId}` : credential.clientId,
    ...(credential.kind === "runtime"
      ? { workspaceId: credential.workspaceId, ...(credential.sessionId ? { callerSessionId: credential.sessionId } : {}) }
      : {}),
    ...(event.sessionId ? { sessionId: event.sessionId } : {}),
  }
}

/** A session retains its original tool context, so every authorization field must match on reuse. */
export function credentialKey(credential: McpCredential): string {
  return JSON.stringify(credential.kind === "runtime"
    ? [credential.kind, credential.runtimeId, credential.workspaceId, credential.userId, credential.sessionId,
      credential.permissionMode, credential.crossMachineWrites, credential.readOnly]
    : [credential.kind, credential.actorId, credential.clientId, credential.readOnly, [...credential.scopes].sort()])
}

type McpSession = {
  transport: WebStandardStreamableHTTPServerTransport
  close: () => Promise<void>
}

function mcpMountRefusal(status: number, code: string, message: string, headers: Record<string, string> = {}) {
  return Response.json({ error: { code, message } }, { status, headers })
}

function jsonRpcError(status: number, code: number, message: string) {
  return Response.json({ jsonrpc: "2.0", error: { code, message }, id: null }, { status })
}

/** A mounted endpoint and the way to release the streamable-HTTP sessions it holds open. */
export type ClaxedoMcpMountHandle = Readonly<{ routes: Hono; dispose(): void }>

export function createClaxedoMcpRoutes(options: ClaxedoMcpMountOptions): ClaxedoMcpMountHandle {
  if (options.mount === "loopback" && !options.verifyRuntimeCredential) {
    throw new Error("A loopback MCP mount admits only runtime credentials and was given no verifier")
  }
  if (options.mount === "loopback" && !options.enabledToolGroups) {
    throw new Error("A loopback MCP mount serves a session's consented tool groups and was given no resolver")
  }
  if (!options.verifyRuntimeCredential && !options.resolveUserCredential) {
    throw new Error(`A ${options.mount} MCP mount was given no way to resolve a credential`)
  }
  const now = options.now ?? Date.now
  const sessions = createMcpSessionStore<McpSession>({
    maxSessions: options.maxSessions ?? DEFAULT_MAX_SESSIONS,
    idleMs: options.sessionIdleMs ?? DEFAULT_SESSION_IDLE_MS,
    now,
  })
  const inFlight = createInFlightCounter(options.maxInFlightPerCredential ?? DEFAULT_MAX_IN_FLIGHT)

  const runtimeCredential = async (token: string, request: Request): Promise<McpCredential | undefined> => {
    const claims = await options.verifyRuntimeCredential?.(token)
    if (!claims || claims.expiresAt <= now()) return undefined
    const requestedSession = new URL(request.url).searchParams.get("session")?.trim()
    if (requestedSession && requestedSession !== claims.sessionId) return undefined
    const sessionId = claims.sessionId
    const credential: McpCredential = {
      kind: "runtime",
      runtimeId: claims.runtimeId,
      workspaceId: claims.workspaceId,
      ...(claims.userId ? { userId: claims.userId } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(claims.permissionMode ? { permissionMode: claims.permissionMode } : {}),
      crossMachineWrites: options.crossMachineWrites?.(claims) ?? false,
      readOnly: false,
    }
    return credential
  }

  const resolveCredential = async (request: Request): Promise<McpCredential | undefined> => {
    const token = bearerToken(request.headers.get("authorization"))
    if (options.mount === "loopback") return token ? runtimeCredential(token, request) : undefined
    const user = await options.resolveUserCredential?.(request)
    if (user) return user
    return token && options.verifyRuntimeCredential ? runtimeCredential(token, request) : undefined
  }

  const unauthorized = (request: Request) => {
    const challenge = options.mount === "loopback"
      ? 'Bearer realm="claxedo-mcp"'
      : `Bearer realm="claxedo-mcp", resource_metadata="${new URL(request.url).origin}${OAUTH_PROTECTED_RESOURCE_PATH}"`
    return mcpMountRefusal(401, "mcp_unauthorized", "A bearer credential this mount accepts is required", {
      "www-authenticate": challenge,
    })
  }

  const createSession = async (
    credential: McpCredential,
    request: Request,
    key: string,
    enabled: readonly string[] | undefined,
  ): Promise<McpSession> => {
    const client = await options.createClient(credential, request)
    const server = new McpServer(CLAXEDO_MCP_SERVER_INFO)
    const inFlightCalls = new Set<RequestId>()
    const elicit = (params: ElicitRequestFormParams | ElicitRequestURLParams) => {
      const [only] = inFlightCalls
      return server.server.elicitInput(params, inFlightCalls.size === 1 && only !== undefined ? { relatedRequestId: only } : undefined)
    }
    const ctx: McpToolContext = {
      credential,
      client,
      audit: options.audit,
      // Known only once `initialize` has been handled, which is after this
      // context is built and after every tool is registered against it.
      get elicit() {
        return server.server.getClientCapabilities()?.elicitation ? elicit : undefined
      },
    }
    const registry = createToolRegistry(server, ctx)
    const groups = enabled
      ? options.registerTools.filter((group) => enabled.includes(group.id))
      : options.registerTools
    for (const group of groups) group.register(registry)
    if (registry.listed.length === 0) {
      server.server.registerCapabilities({ tools: {} })
      server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }))
    }
    const session: McpSession = {
      transport: new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (id) => sessions.add(id, { session, credentialKey: key, close: session.close }),
        onsessionclosed: (id) => sessions.remove(id),
      }),
      close: () => session.transport.close(),
    }
    await server.connect(session.transport)
    // A server-initiated request rides the SSE stream of the tool call that
    // made it whenever exactly one call is open; the SDK otherwise routes it
    // to the standalone GET stream, which not every host opens.
    const { transport } = session
    const onmessage = transport.onmessage
    transport.onmessage = (message, extra) => {
      if (isJSONRPCRequest(message) && message.method === "tools/call") inFlightCalls.add(message.id)
      onmessage?.(message, extra)
    }
    const send = transport.send.bind(transport)
    transport.send = async (message, sendOptions) => {
      try {
        await send(message, sendOptions)
      } finally {
        if ((isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) && message.id != null) {
          inFlightCalls.delete(message.id)
        }
      }
    }
    return session
  }

  const dispatch = async (
    request: Request,
    credential: McpCredential,
    key: string,
    enabled: readonly string[] | undefined,
  ): Promise<Response> => {
    const sessionId = request.headers.get("mcp-session-id")
    if (sessionId) {
      const session = sessions.get(sessionId, key)
      if (!session) return jsonRpcError(404, -32001, "Session not found")
      return session.transport.handleRequest(request)
    }
    const session = await createSession(credential, request, key, enabled)
    const response = await session.transport.handleRequest(request)
    if (!session.transport.sessionId) await session.close()
    return response
  }

  const handle = async (request: Request): Promise<Response> => {
    if (options.mount === "loopback" && !isLoopbackRequest(request)) {
      return mcpMountRefusal(403, "mcp_loopback_only", "The loopback MCP mount answers only loopback hosts and origins")
    }
    const credential = await resolveCredential(request)
    if (!credential) return unauthorized(request)
    // Resolved per request, not per session: the enabled set is a live consent
    // read, so a group turned off reaches the next request rather than waiting
    // for the client to reconnect. It is part of the session key for the same
    // reason — a session built under the old set is not this caller's session.
    const enabled = await options.enabledToolGroups?.(credential)
    const key = `${credentialKey(credential)}:${enabled ? enabled.join(",") : "*"}`
    const release = request.method === "POST" ? inFlight.acquire(key) : () => undefined
    if (!release) {
      return mcpMountRefusal(429, "mcp_too_many_requests", "This credential already has the maximum number of requests open", {
        "retry-after": "1",
      })
    }
    try {
      // The client captures the original bearer for downstream requests. A refreshed token must initialize a new client.
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(request.headers.get("authorization") ?? ""))
      const tokenKey = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
      return releaseWhenSettled(await dispatch(request, credential, `${key}:${tokenKey}`, enabled), release)
    } catch (error) {
      release()
      throw error
    }
  }

  return { routes: new Hono().all("/", (c) => handle(c.req.raw)), dispose: () => sessions.closeAll() }
}
