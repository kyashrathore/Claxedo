import { ConvexHttpClient } from "convex/browser"
import { anyApi, type FunctionReference } from "convex/server"
import { createRemoteJWKSet, importSPKI } from "jose"
import { z } from "zod"
import { ConnectionTokenError, ConnectionsUnavailableError } from "@claxedo/connections"
import { verifyRuntimeAccessToken, WorkspaceRelayAuthError, type RelayKey } from "@claxedo/workspace-relay"
import {
  WorkGraphConnectionOperationRequestSchema,
  type WorkGraphConnectionOperationRequest,
  type WorkGraphContext,
} from "@claxedo/workgraph/contracts"
import {
  SourceIssueProviderError,
  SourceIssueResponseError,
  SourceIssueTransportError,
  SourceIssueUnauthorizedError,
} from "@claxedo/workgraph/connectors"
import { clean, type HostedWorkerEnv } from "../control-plane/adapters/worker/hosted-compose"
import { hostedOrgCredentials } from "../control-plane/worker-credentials"
import {
  ConnectionOperationDeniedError,
  createConnectionOperationBroker,
  type ConnectionOperationBinding,
} from "./connection-operation-broker"
import {
  createHostedWorkGraphConnectionsPort,
  HostedConnectionCredentialUnavailableError,
  HostedConnectionReconnectRequiredError,
  type HostedConnectionMetadata,
} from "./hosted-connections"

type Query = FunctionReference<"query">
const api = anyApi as unknown as { workgraphConnections: { resolveOperationBinding: Query } }

type Executor = { query(fn: Query, args: Record<string, unknown>): Promise<unknown> }
type BindingResult = Readonly<{
  context: { ownerUserId: string; ownerPartition: string }
  attemptId: string
  sessionId: string
  workspaceId: string
  connectionIds: string[]
  tools: string[]
  connection: HostedConnectionMetadata
}>
export function createHostedConnectionOperationExecutor(input: Readonly<{
  env: HostedWorkerEnv
  executor?: Executor
}>) {
  const serviceToken = clean(input.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN)
  const url = clean(input.env.CLAXEDO_WORKGRAPH_CONVEX_URL) ?? clean(input.env.CLAXEDO_WORKSPACE_AUTHORITY_URL)
  if (!serviceToken || (!url && !input.executor)) return
  const executor = input.executor ?? convexExecutor(url!)
  return async (
    principal: Readonly<{ ownerUserId: string; orgId: string }>,
    request: WorkGraphConnectionOperationRequest,
  ) => {
    const tool = `connection_work_source_${request.operation.type}`
    const resolved = await executor.query(api.workgraphConnections.resolveOperationBinding, {
      service_token: serviceToken,
      ownerUserId: principal.ownerUserId,
      orgId: principal.orgId,
      attemptId: request.identity.attemptId,
      sessionId: request.identity.sessionId,
      workspaceId: request.identity.workspaceId,
      connectionId: request.identity.connectionId,
      tool,
    }) as BindingResult | null
    if (!resolved) throw new ConnectionOperationDeniedError("Connection operation is not bound to this Attempt")
    const context: WorkGraphContext = {
      ownerUserId: resolved.context.ownerUserId as never,
      actor: { type: "agent", id: request.identity.attemptId as never },
      requestId: crypto.randomUUID() as never,
      access: { mode: "owner" },
    }
    const binding: ConnectionOperationBinding = {
      context,
      ownerPartition: resolved.context.ownerPartition,
      attemptId: resolved.attemptId,
      sessionId: resolved.sessionId,
      workspaceId: resolved.workspaceId,
      connectionIds: resolved.connectionIds as never,
      tools: resolved.tools,
    }
    return createConnectionOperationBroker({
      bindings: { resolve: async () => binding },
      connections: createHostedWorkGraphConnectionsPort({
        resolveMetadata: async () => [{ ...resolved.connection, ownerUserId: resolved.context.ownerUserId }],
        credentials: (orgId) => hostedOrgCredentials(orgId, input.env),
      }),
    }).execute(request.identity as never, request.operation, {
      ownerUserId: principal.ownerUserId,
      ownerPartition: `org:${principal.orgId}`,
    })
  }
}

export function createHostedConnectionOperationHandler(input: Readonly<{
  env: HostedWorkerEnv
  execute: NonNullable<ReturnType<typeof createHostedConnectionOperationExecutor>>
  runtimeKey?: Promise<RelayKey>
}>) {
  let runtimeKey = input.runtimeKey
  return async (request: Request) => {
    try {
      const token = bearer(request.headers.get("authorization"))
      if (!token) return Response.json({ error: { code: "runtime_access_token_required" } }, { status: 401 })
      const declaredLength = Number(request.headers.get("content-length") ?? "0")
      if (Number.isFinite(declaredLength) && declaredLength > 64 * 1024) {
        return Response.json({ error: { code: "connection_operation_too_large" } }, { status: 413 })
      }
      const raw = await request.text()
      if (raw.length > 64 * 1024) return Response.json({ error: { code: "connection_operation_too_large" } }, { status: 413 })
      const body = WorkGraphConnectionOperationRequestSchema.parse(JSON.parse(raw))
      runtimeKey ??= loadRuntimeKey(input.env)
      const claims = await verifyRuntimeToken(token, runtimeKey, body.identity.workspaceId).catch((error) => {
        if (error instanceof RuntimeAccessTokenVerificationUnavailableError) runtimeKey = undefined
        throw error
      })
      const result = await input.execute({ ownerUserId: claims.sub, orgId: claims.org_id }, body)
      return Response.json(result)
    } catch (error) {
      const failure = operationFailure(error)
      return Response.json({
        error: {
          code: failure.code,
          message: failure.message,
          retryable: failure.retryable,
        },
      }, { status: failure.status })
    }
  }
}

function operationFailure(error: unknown) {
  if (error instanceof SyntaxError || error instanceof z.ZodError) {
    return failure(400, "connection_operation_invalid_request", "Connection operation request is invalid", false)
  }
  if (error instanceof WorkspaceRelayAuthError) {
    const mismatch = error.code === "relay_token_workspace_mismatch" || error.code === "relay_token_host_mismatch"
    return failure(mismatch ? 403 : 401, error.code, mismatch
      ? "Runtime access token is not authorized for this workspace"
      : "Runtime access token is invalid", false)
  }
  if (error instanceof RuntimeAccessTokenVerificationUnavailableError) {
    return failure(503, error.code, "Runtime access token verification is unavailable", true)
  }
  if (error instanceof ConnectionOperationDeniedError) {
    return failure(403, error.code, "Connection operation is not authorized", false)
  }
  if (error instanceof HostedConnectionReconnectRequiredError) {
    return failure(409, error.code, "Connection requires reconnect", false)
  }
  if (error instanceof HostedConnectionCredentialUnavailableError) {
    return failure(503, error.code, "Connection credential is unavailable", true)
  }
  if (error instanceof ConnectionsUnavailableError) {
    return failure(503, "connections_unavailable", "Connections service is unavailable", true)
  }
  if (error instanceof ConnectionTokenError) {
    return failure(error.status, error.code, "Connection token is unavailable", error.status === 503)
  }
  if (error instanceof SourceIssueUnauthorizedError) {
    return failure(error.status, "connection_provider_unauthorized", "Connection provider authorization failed", false)
  }
  if (error instanceof SourceIssueResponseError) {
    return failure(502, "connection_provider_invalid_response", "Connection provider returned an invalid response", true)
  }
  if (error instanceof SourceIssueTransportError) {
    return failure(503, "connection_provider_unavailable", "Connection provider is unavailable", true)
  }
  if (error instanceof SourceIssueProviderError) {
    return failure(error.status, providerErrorCode(error.status), providerErrorMessage(error.status), error.retryable)
  }
  return failure(500, "connection_operation_failed", "Connection operation failed", false)
}

class RuntimeAccessTokenVerificationUnavailableError extends Error {
  readonly code = "runtime_access_token_verification_unavailable"
}

async function verifyRuntimeToken(token: string, key: Promise<RelayKey>, workspaceId: string) {
  let resolved: RelayKey
  try {
    resolved = await key
  } catch {
    throw new RuntimeAccessTokenVerificationUnavailableError()
  }
  try {
    return await verifyRuntimeAccessToken(token, resolved, { workspaceId })
  } catch (error) {
    if (error instanceof WorkspaceRelayAuthError) throw error
    throw new RuntimeAccessTokenVerificationUnavailableError()
  }
}

function failure(status: number, code: string, message: string, retryable: boolean) {
  return { status, code, message, retryable }
}

function providerErrorCode(status: number) {
  if (status === 401) return "connection_provider_unauthorized"
  if (status === 429) return "connection_provider_rate_limited"
  if (status >= 500) return "connection_provider_unavailable"
  return "connection_provider_rejected"
}

function providerErrorMessage(status: number) {
  if (status === 401) return "Connection provider authorization failed"
  if (status === 429) return "Connection provider rate limit was reached"
  if (status >= 500) return "Connection provider is unavailable"
  return "Connection provider rejected the operation"
}

function convexExecutor(url: string): Executor {
  const client = new ConvexHttpClient(url)
  return { query: (fn, args) => client.query(fn as never, args as never) }
}

function bearer(header: string | null) {
  const match = header?.match(/^Bearer\s+(\S+)$/i)
  return match?.[1]
}

function pem(input?: string) {
  return clean(input)?.replaceAll("\\n", "\n")
}

async function loadRuntimeKey(env: HostedWorkerEnv): Promise<RelayKey> {
  const jwks = clean(env.CLAXEDO_CONTROL_PLANE_JWKS_URL)
  if (jwks) return createRemoteJWKSet(new URL(jwks))
  const publicKey = pem(env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM)
  if (!publicKey) throw new Error("Runtime Access Token verification key is unavailable")
  return importSPKI(publicKey, "EdDSA")
}
