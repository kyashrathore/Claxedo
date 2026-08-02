import { ConvexHttpClient } from "convex/browser"
import { anyApi, type FunctionReference } from "convex/server"
import { createRemoteJWKSet, importSPKI } from "jose"
import { z } from "zod"
import { verifyRuntimeAccessToken, WorkspaceRelayAuthError, type RelayKey } from "@claxedo/workspace-relay"
import {
  CommandResultSchema,
  masterRunId,
  masterSessionId,
  WorkGraphRunOperationRequestSchema,
  type CommandResult,
  type WorkGraphRunOperationRequest,
} from "@claxedo/workgraph/contracts"
import { clean, type HostedWorkerEnv } from "../control-plane/adapters/worker/hosted-compose"
import { HostedTranscriptRetentionError, workGraphWorkspaceId } from "./hosted-runtime"

type Mutation = FunctionReference<"mutation">
const api = anyApi as unknown as { workgraphCommands: { executeForService: Mutation; readStreamVersionForService: Mutation } }

type Executor = { mutation(fn: Mutation, args: Record<string, unknown>): Promise<unknown> }

type TranscriptRetention = (input: Readonly<{
  organizationId: string
  ownerSubject: string
  workspaceId: string
  sessionId: string
}>) => Promise<void>

export function createHostedRunOperationExecutor(input: Readonly<{
  env: HostedWorkerEnv
  executor?: Executor
  /**
   * When composed, complete_run is accepted only after the Session
   * transcript is durably retained in the authority — a failed retention
   * rejects the completion as retryable instead of settling the Run
   * without its transcript.
   */
  retainTranscript?: TranscriptRetention
  notifyChanged?: (
    principal: Readonly<{ ownerUserId: string; orgId: string }>,
    change: Readonly<{ cursor: string; streamId?: string }>,
  ) => Promise<void>
  notifyOwner?: (input: Readonly<{
    ownerUserId: string
    orgId: string
    idempotencyKey: string
    text: string
  }>) => Promise<{ channel: string; reference: string; duplicate: boolean }>
}>) {
  const serviceToken = clean(input.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN)
  const url = clean(input.env.CLAXEDO_WORKGRAPH_CONVEX_URL) ?? clean(input.env.CLAXEDO_WORKSPACE_AUTHORITY_URL)
  if (!serviceToken || (!url && !input.executor)) return
  const executor = input.executor ?? convexExecutor(url!)
  return async (
    principal: Readonly<{ ownerUserId: string; orgId: string }>,
    request: WorkGraphRunOperationRequest,
  ): Promise<CommandResult> => {
    if (request.operation.type === "complete" && input.retainTranscript) {
      await input.retainTranscript({
        organizationId: principal.orgId,
        ownerSubject: principal.ownerUserId,
        workspaceId: request.identity.workspaceId,
        sessionId: request.identity.sessionId,
      })
    }
    if (request.operation.type === "notify_owner" && !input.notifyOwner) {
      throw new Error("Hosted owner channel notification is unavailable")
    }
    // Master identity is validated BEFORE any externally-visible side effect:
    // a rejected request must never have already delivered a notification.
    const masterStreamId = request.operation.type === "update_stream_notes" || request.operation.type === "notify_owner"
      ? await requireMasterIdentity(principal, request)
      : undefined
    const notification = request.operation.type === "notify_owner"
      ? await input.notifyOwner!({
          ...principal,
          idempotencyKey: request.operation.operationId,
          text: request.operation.message,
        })
      : undefined
    const result = CommandResultSchema.parse(await executor.mutation(
      api.workgraphCommands.executeForService,
      {
        service_token: serviceToken,
        organization_id: principal.orgId,
        owner_subject: principal.ownerUserId,
        actor_type: "agent",
        actor_id: request.operation.type === "update_stream_notes" || request.operation.type === "notify_owner"
          ? request.identity.sessionId
          : request.identity.runId,
        operation_id: request.operation.operationId,
        request_id: `run_tool_${crypto.randomUUID()}`,
        command: request.operation.type === "record_checkpoint"
          ? {
              version: 1,
              type: "record_run_checkpoint",
              runId: request.identity.runId,
              sessionId: request.identity.sessionId,
              workspaceId: request.identity.workspaceId,
              generation: request.identity.generation,
              level: request.operation.level,
              summary: request.operation.summary,
              evidenceIds: request.operation.evidenceIds,
            }
          : request.operation.type === "complete"
            ? {
              version: 1,
              type: "complete_run",
              runId: request.identity.runId,
              sessionId: request.identity.sessionId,
              workspaceId: request.identity.workspaceId,
              generation: request.identity.generation,
              summary: request.operation.summary,
              artifacts: request.operation.artifacts,
              evidence: request.operation.evidence,
            }
            : request.operation.type === "update_stream_notes"
              ? {
                version: 1,
                type: "update_stream_notes",
                streamId: masterStreamId!,
                expectedVersion: await readStreamVersion(executor, serviceToken, principal, masterStreamId!),
                status: request.operation.status,
                learnings: request.operation.learnings,
                externalReferences: request.operation.externalReferences,
              }
              : {
                  version: 1,
                  type: "record_evidence",
                  subject: { type: "stream", streamId: masterStreamId! },
                  evidence: {
                    kind: "integration",
                    summary: `Notified the Stream owner through ${notification!.channel}`,
                    effect: "published",
                    reference: notification!.reference,
                  },
                },
      },
    ))
    if (result.ok) {
      await input.notifyChanged?.(principal, {
        cursor: result.cursor,
        ...(masterStreamId ? { streamId: masterStreamId } : {}),
      }).catch((error) => {
        console.error("[claxedo-server] WARN  hosted agent workgraph.changed nudge failed:", error)
      })
    }
    return result
  }
}

/** Master identity must be bound to an authenticated fact, not merely
 *  self-consistent strings. The runtime access token proves the caller's
 *  workspaceId; the hosted master for a Stream lives in the deterministic
 *  per-stream workspace, so the claimed identity must resolve to exactly that
 *  workspace. Residual risk until per-principal runtime tokens land (plan
 *  2026-07-18-005 "Decisions required": master git identity): worker Runs
 *  of the SAME Stream share this workspace and could still claim its master
 *  identity — org-wide forgery is closed, same-stream is not. */
async function requireMasterIdentity(
  principal: Readonly<{ ownerUserId: string; orgId: string }>,
  request: WorkGraphRunOperationRequest,
) {
  const streamId = request.identity.streamId
  if (!streamId || request.identity.sessionId !== masterSessionId(streamId) || request.identity.runId !== masterRunId(streamId)) {
    throw new Error("Master operation requires an exact hosted master identity")
  }
  const masterWorkspaceId = await workGraphWorkspaceId(principal.orgId, principal.ownerUserId, streamId)
  if (request.identity.workspaceId !== masterWorkspaceId) {
    throw new Error("Master operation is not bound to the Stream master workspace")
  }
  return streamId
}

async function readStreamVersion(
  executor: Executor,
  serviceToken: string,
  principal: Readonly<{ ownerUserId: string; orgId: string }>,
  streamId: string,
) {
  const value = await executor.mutation(api.workgraphCommands.readStreamVersionForService, {
    service_token: serviceToken,
    organization_id: principal.orgId,
    owner_subject: principal.ownerUserId,
    stream_id: streamId,
  }) as { version?: unknown }
  if (!Number.isInteger(value.version)) throw new Error("Hosted master Stream version is unavailable")
  return value.version as number
}

export function createHostedRunOperationHandler(input: Readonly<{
  env: HostedWorkerEnv
  execute: NonNullable<ReturnType<typeof createHostedRunOperationExecutor>>
  runtimeKey?: Promise<RelayKey>
}>) {
  let runtimeKey = input.runtimeKey
  return async (
    request: Request,
    // A successful agent-tool operation is a
    // readiness-changing mutation — nudge the per-request settlement dispatcher so
    // dependent launches drain sub-second instead of waiting for the CF cron. The
    // dispatcher is built at the route where the request `waitUntil` is available,
    // mirroring the primary command path. Advisory + fire-and-forget.
    notifySettlement?: (principal: Readonly<{ ownerUserId: string; orgId: string }>) => void,
  ) => {
    try {
      const token = bearer(request.headers.get("authorization"))
      if (!token) return Response.json({ error: { code: "runtime_access_token_required" } }, { status: 401 })
      const declaredLength = Number(request.headers.get("content-length") ?? "0")
      if (Number.isFinite(declaredLength) && declaredLength > 256 * 1024) {
        return Response.json({ error: { code: "run_operation_too_large" } }, { status: 413 })
      }
      const raw = await request.text()
      if (raw.length > 256 * 1024) return Response.json({ error: { code: "run_operation_too_large" } }, { status: 413 })
      const body = WorkGraphRunOperationRequestSchema.parse(JSON.parse(raw))
      runtimeKey ??= loadRuntimeKey(input.env)
      const claims = await verifyRuntimeToken(token, runtimeKey, body.identity.workspaceId).catch((error) => {
        if (error instanceof RuntimeAccessTokenVerificationUnavailableError) runtimeKey = undefined
        throw error
      })
      const principal = { ownerUserId: claims.sub, orgId: claims.org_id }
      const result = await input.execute(principal, body)
      if (result.ok) {
        try {
          notifySettlement?.(principal)
        } catch {
          // A settlement nudge is advisory; the durable command result owns the response.
        }
      }
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
    return failure(400, "run_operation_invalid_request", "Run operation request is invalid", false)
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
  return failure(500, "run_operation_failed", "Run operation failed", false)
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
