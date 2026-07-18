import { ConvexHttpClient } from "convex/browser"
import { anyApi, type FunctionReference } from "convex/server"
import { createRemoteJWKSet, importSPKI } from "jose"
import { z } from "zod"
import { verifyRuntimeAccessToken, WorkspaceRelayAuthError, type RelayKey } from "@claxedo/workspace-relay"
import {
  CommandResultSchema,
  WorkGraphAttemptOperationRequestSchema,
  type CommandResult,
  type WorkGraphAttemptOperationRequest,
} from "@claxedo/workgraph/contracts"
import { clean, type HostedWorkerEnv } from "../control-plane/adapters/worker/hosted-compose"
import { HostedTranscriptRetentionError } from "./hosted-runtime"

type Mutation = FunctionReference<"mutation">
const api = anyApi as unknown as { workgraphCommands: { executeForService: Mutation } }

type Executor = { mutation(fn: Mutation, args: Record<string, unknown>): Promise<unknown> }

type TranscriptRetention = (input: Readonly<{
  organizationId: string
  ownerSubject: string
  workspaceId: string
  sessionId: string
}>) => Promise<void>

export function createHostedAttemptOperationExecutor(input: Readonly<{
  env: HostedWorkerEnv
  executor?: Executor
  /**
   * When composed, complete_attempt is accepted only after the Session
   * transcript is durably retained in the authority — a failed retention
   * rejects the completion as retryable instead of settling the Attempt
   * without its transcript.
   */
  retainTranscript?: TranscriptRetention
  notifyChanged?: (principal: Readonly<{ ownerUserId: string; orgId: string }>) => Promise<void>
}>) {
  const serviceToken = clean(input.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN)
  const url = clean(input.env.CLAXEDO_WORKGRAPH_CONVEX_URL) ?? clean(input.env.CLAXEDO_WORKSPACE_AUTHORITY_URL)
  if (!serviceToken || (!url && !input.executor)) return
  const executor = input.executor ?? convexExecutor(url!)
  return async (
    principal: Readonly<{ ownerUserId: string; orgId: string }>,
    request: WorkGraphAttemptOperationRequest,
  ): Promise<CommandResult> => {
    if (request.operation.type === "complete" && input.retainTranscript) {
      await input.retainTranscript({
        organizationId: principal.orgId,
        ownerSubject: principal.ownerUserId,
        workspaceId: request.identity.workspaceId,
        sessionId: request.identity.sessionId,
      })
    }
    const result = CommandResultSchema.parse(await executor.mutation(
      api.workgraphCommands.executeForService,
      {
        service_token: serviceToken,
        organization_id: principal.orgId,
        owner_subject: principal.ownerUserId,
        actor_type: "agent",
        actor_id: request.identity.attemptId,
        operation_id: request.operation.operationId,
        request_id: `attempt_tool_${crypto.randomUUID()}`,
        command: request.operation.type === "record_checkpoint"
          ? {
              version: 1,
              type: "record_attempt_checkpoint",
              attemptId: request.identity.attemptId,
              sessionId: request.identity.sessionId,
              workspaceId: request.identity.workspaceId,
              ...(request.identity.leaseEpoch === undefined ? {} : { leaseEpoch: request.identity.leaseEpoch }),
              level: request.operation.level,
              summary: request.operation.summary,
              evidenceIds: request.operation.evidenceIds,
            }
          : {
              version: 1,
              type: "complete_attempt",
              attemptId: request.identity.attemptId,
              sessionId: request.identity.sessionId,
              workspaceId: request.identity.workspaceId,
              ...(request.identity.leaseEpoch === undefined ? {} : { leaseEpoch: request.identity.leaseEpoch }),
              summary: request.operation.summary,
              artifacts: request.operation.artifacts,
              evidence: request.operation.evidence,
            },
      },
    ))
    if (result.ok) {
      await input.notifyChanged?.(principal).catch((error) => {
        console.error("[claxedo-server] WARN  hosted agent workgraph.changed nudge failed:", error)
      })
    }
    return result
  }
}

export function createHostedAttemptOperationHandler(input: Readonly<{
  env: HostedWorkerEnv
  execute: NonNullable<ReturnType<typeof createHostedAttemptOperationExecutor>>
  runtimeKey?: Promise<RelayKey>
}>) {
  let runtimeKey = input.runtimeKey
  return async (request: Request) => {
    try {
      const token = bearer(request.headers.get("authorization"))
      if (!token) return Response.json({ error: { code: "runtime_access_token_required" } }, { status: 401 })
      const declaredLength = Number(request.headers.get("content-length") ?? "0")
      if (Number.isFinite(declaredLength) && declaredLength > 256 * 1024) {
        return Response.json({ error: { code: "attempt_operation_too_large" } }, { status: 413 })
      }
      const raw = await request.text()
      if (raw.length > 256 * 1024) return Response.json({ error: { code: "attempt_operation_too_large" } }, { status: 413 })
      const body = WorkGraphAttemptOperationRequestSchema.parse(JSON.parse(raw))
      runtimeKey ??= loadRuntimeKey(input.env)
      const claims = await verifyRuntimeToken(token, runtimeKey, body.identity.workspaceId).catch((error) => {
        if (error instanceof RuntimeAccessTokenVerificationUnavailableError) runtimeKey = undefined
        throw error
      })
      return Response.json(await input.execute({ ownerUserId: claims.sub, orgId: claims.org_id }, body))
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
    return failure(400, "attempt_operation_invalid_request", "Attempt operation request is invalid", false)
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
  if (error instanceof HostedTranscriptRetentionError) {
    return failure(503, error.code, error.message, true)
  }
  return failure(500, "attempt_operation_failed", "Attempt operation failed", false)
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

function convexExecutor(url: string): Executor {
  const client = new ConvexHttpClient(url)
  return { mutation: (fn, args) => client.mutation(fn as never, args as never) }
}

function bearer(header: string | null) {
  return header?.match(/^Bearer\s+(\S+)$/i)?.[1]
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
