import { ConvexHttpClient } from "convex/browser"
import { anyApi, type FunctionReference } from "convex/server"
import { createRemoteJWKSet, importSPKI } from "jose"
import { z } from "zod"
import { ConnectionTokenError, ConnectionsUnavailableError } from "@claxedo/connections"
import { verifyRuntimeAccessToken, WorkspaceRelayAuthError, type RelayKey } from "@claxedo/workspace-relay"
import {
  WorkGraphConnectionOperationRequestSchema,
  WorkGraphConnectionOperationResponseSchema,
  type WorkGraphConnectionOperationRequest,
  type WorkGraphContext,
} from "@claxedo/workgraph/contracts"
import {
  SourceIssueConfigurationError,
  SourceIssueProviderError,
  SourceIssueResponseError,
  SourceIssueTransportError,
  SourceIssueUnauthorizedError,
  CodeHostProviderError,
  CodeHostUnauthorizedError,
} from "@claxedo/workgraph/connectors"
import { clean, type HostedWorkerEnv } from "../../control-plane/adapters/worker/hosted-compose"
import { hostedOrgCredentials } from "../../control-plane/worker-credentials"
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
type Mutation = FunctionReference<"mutation">
const api = anyApi as unknown as { workgraphConnections: {
  resolveOperationBinding: Query
  authorizePullRequest: Mutation
  claimPullRequestEffect: Mutation
  completePullRequestEffect: Mutation
  failPullRequestEffect: Mutation
} }

type Executor = {
  query(fn: Query, args: Record<string, unknown>): Promise<unknown>
  mutation?(fn: Mutation, args: Record<string, unknown>): Promise<unknown>
}
type BindingResult = Readonly<{
  context: { ownerUserId: string; ownerPartition: string }
  runId: string
  sessionId: string
  workspaceId: string
  connectionIds: string[]
  tools: string[]
  streamId: string
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
    const tool = request.operation.type === "open_pull_request"
      ? "connection_code_host_open_pr"
      : `connection_work_source_${request.operation.type}`
    const resolved = await executor.query(api.workgraphConnections.resolveOperationBinding, {
      service_token: serviceToken,
      ownerUserId: principal.ownerUserId,
      orgId: principal.orgId,
      runId: request.identity.runId,
      sessionId: request.identity.sessionId,
      workspaceId: request.identity.workspaceId,
      connectionId: request.identity.connectionId,
      tool,
    }) as BindingResult | null
    if (!resolved) throw new ConnectionOperationDeniedError("Connection operation is not bound to this Run")
    const context: WorkGraphContext = {
      organizationId: principal.orgId as never,
      ownerUserId: resolved.context.ownerUserId as never,
      actor: { type: "agent", id: request.identity.runId as never },
      requestId: crypto.randomUUID() as never,
      access: { mode: "owner" },
    }
    const binding: ConnectionOperationBinding = {
      context,
      ownerPartition: resolved.context.ownerPartition,
      runId: resolved.runId,
      sessionId: resolved.sessionId,
      workspaceId: resolved.workspaceId,
      connectionIds: resolved.connectionIds as never,
      tools: resolved.tools,
    }
    const pullRequest = request.operation.type === "open_pull_request" ? request.operation : undefined
    const workerId = pullRequest ? `connection-pr-${crypto.randomUUID()}` : undefined
    const broker = createConnectionOperationBroker({
      bindings: { resolve: async () => binding },
      connections: createHostedWorkGraphConnectionsPort({
        resolveMetadata: async () => [{ ...resolved.connection, ownerUserId: resolved.context.ownerUserId }],
        credentials: (orgId) => hostedOrgCredentials(orgId, input.env),
      }),
    })
    const brokerPrincipal = { ownerUserId: principal.ownerUserId, ownerPartition: `org:${principal.orgId}` }
    let pullRequestClaim: { state: "claimed"; outboxId: string } | { state: "completed"; result: unknown } | { state: "busy" } | undefined
    if (pullRequest) {
      if (!executor.mutation) throw new Error("Pull request authorization is unavailable")
      // The confirmation gate keys on provider-verified visibility, never the
      // agent-supplied flag. Drafts skip the lookup; lookup failure reads as
      // public, which forces confirmation.
      const verifiedPublicRepository = pullRequest.draft
        ? false
        : await broker
            .repositoryVisibility(request.identity as never, pullRequest.repository, brokerPrincipal)
            .then((visibility) => visibility === "public")
            .catch(() => true)
      const authorization = await executor.mutation(api.workgraphConnections.authorizePullRequest, {
        service_token: serviceToken,
        ownerUserId: principal.ownerUserId,
        orgId: principal.orgId,
        streamId: resolved.streamId,
        runId: resolved.runId,
        repository: pullRequest.repository,
        title: pullRequest.title,
        draft: pullRequest.draft,
        publicRepository: verifiedPublicRepository,
      }) as { allowed?: boolean }
      if (!authorization.allowed) {
        throw new ConnectionOperationDeniedError("The first non-draft public pull request requires owner confirmation")
      }
      pullRequestClaim = await executor.mutation(api.workgraphConnections.claimPullRequestEffect, {
        service_token: serviceToken,
        ownerUserId: principal.ownerUserId,
        orgId: principal.orgId,
        streamId: resolved.streamId,
        runId: resolved.runId,
        workerId,
        idempotencyKey: pullRequest.idempotencyKey,
        repository: pullRequest.repository,
        head: pullRequest.head,
        base: pullRequest.base,
        title: pullRequest.title,
        ...(pullRequest.body === undefined ? {} : { body: pullRequest.body }),
        draft: pullRequest.draft,
        publicRepository: verifiedPublicRepository,
        now: Date.now(),
      }) as typeof pullRequestClaim
      if (pullRequestClaim?.state === "completed") {
        return WorkGraphConnectionOperationResponseSchema.parse(pullRequestClaim.result)
      }
      if (pullRequestClaim?.state !== "claimed") throw new PullRequestEffectBusyError()
    }
    const result = await broker.execute(request.identity as never, request.operation, brokerPrincipal).catch(async (error) => {
      if (pullRequestClaim?.state === "claimed" && executor.mutation && workerId) {
        await executor.mutation(api.workgraphConnections.failPullRequestEffect, {
          service_token: serviceToken,
          ownerUserId: principal.ownerUserId,
          orgId: principal.orgId,
          outboxId: pullRequestClaim.outboxId,
          workerId,
          now: Date.now(),
        })
      }
      throw error
    })
    if (result.type !== "open_pull_request" || !pullRequest) return result
    if (!executor.mutation) throw new Error("Pull request receipt persistence is unavailable")
    if (pullRequestClaim?.state !== "claimed" || !workerId) throw new Error("Pull request effect lease is unavailable")
    return WorkGraphConnectionOperationResponseSchema.parse(await executor.mutation(api.workgraphConnections.completePullRequestEffect, {
      service_token: serviceToken,
      ownerUserId: principal.ownerUserId,
      orgId: principal.orgId,
      outboxId: pullRequestClaim.outboxId,
      workerId,
      pullRequestId: result.pullRequestId,
      url: result.url,
      draft: result.draft,
      now: Date.now(),
    }))
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
  if (error instanceof PullRequestEffectBusyError) {
    return failure(503, error.code, "Pull request delivery is already in progress", true)
  }
  if (error instanceof ConnectionTokenError) {
    return failure(error.status, error.code, "Connection token is unavailable", error.status === 503)
  }
  if (error instanceof SourceIssueConfigurationError) {
    return failure(409, "connection_provider_configuration_required", "Connection provider configuration is required", false)
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
  if (error instanceof CodeHostUnauthorizedError) {
    return failure(401, error.code, "Connection provider authorization failed", false)
  }
  if (error instanceof CodeHostProviderError) {
    return failure(error.status, providerErrorCode(error.status), providerErrorMessage(error.status), error.status >= 500 || error.status === 429)
  }
  return failure(500, "connection_operation_failed", "Connection operation failed", false)
}

class RuntimeAccessTokenVerificationUnavailableError extends Error {
  readonly code = "runtime_access_token_verification_unavailable"
}

class PullRequestEffectBusyError extends Error {
  readonly code = "pull_request_effect_busy"
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
  return {
    query: (fn, args) => client.query(fn as never, args as never),
    mutation: (fn, args) => client.mutation(fn as never, args as never),
  }
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
