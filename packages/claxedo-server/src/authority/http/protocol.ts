import { z } from "zod"
import {
  ControlPlaneAuthError,
  bearerToken,
  controlPlaneAuthContext,
  controlPlaneAuthErrorBody,
  type ControlPlaneTokenVerifier,
  type ControlPlaneAuthConfig,
  type ControlPlaneAuthContext,
} from "@claxedo/server-core/platform/auth/auth"
import type { Workspace } from "@claxedo/server-core/workspace/store/index"
import { verifyWorkspaceRuntimeControlToken } from "../../workspace/supervisor"
import {
  IdempotencyCapacityError,
  IdempotencyConflictError,
  IDEMPOTENCY_KEY_MAX_LENGTH,
} from "./idempotency"
import type { WorkspaceRecord } from "@claxedo/server-core/platform/auth/authority"
import type { RelayRole } from "@claxedo/workspace-relay"
import { WorkspaceRuntimeTargetError } from "../runtime-target"

export type ControlPlaneHttpOptions = {
  authConfig?: ControlPlaneAuthConfig
  verifier?: ControlPlaneTokenVerifier
  cliTokenEnv?: Record<string, string | undefined>
  runtimeFetch?: (input: {
    workspaceId: string
    ws: Workspace
    authorityWorkspace?: WorkspaceRecord
    authorityRole?: RelayRole
    auth?: ControlPlaneAuthContext
    path: string
    init?: RequestInit
  }) => Promise<Response>
}

export class ControlPlaneProtocolError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
  }
}

export const pullTriggerInput = z.object({
  idempotencyKey: z.string().min(1).max(IDEMPOTENCY_KEY_MAX_LENGTH).optional(),
  reason: z.enum(["session-created", "message-checkpoint", "repair", "session-mutated", "sse-gap"]).optional(),
  expectedEventOrdinal: z.number().int().nonnegative().optional(),
}).strict()

export const runtimeSnapshotInput = z.object({
  workspaceId: z.string().min(1),
  ok: z.boolean(),
  status: z.string(),
  healthStatus: z.enum(["ok", "degraded", "unavailable"]).optional(),
  directory: z.string(),
  profile: z.string(),
  agentType: z.string(),
  model: z.string().nullable(),
  ptyCount: z.number().int().nonnegative(),
  processCount: z.number().int().nonnegative(),
  activeProcessCount: z.number().int().nonnegative(),
  url: z.string().nullable().optional(),
  leaseId: z.string().nullable().optional(),
  sandboxId: z.string().nullable().optional(),
  epoch: z.number().int().nullable().optional(),
  controlPlane: z.object({
    enabled: z.boolean(),
    state: z.enum(["disabled", "registering", "connected", "degraded"]),
    lastRegisterAt: z.number().int().optional(),
    lastHeartbeatAt: z.number().int().optional(),
    lastSuccessAt: z.number().int().optional(),
    lastFailureAt: z.number().int().optional(),
    lastFailureOperation: z.enum(["register", "heartbeat"]).optional(),
    lastError: z.string().optional(),
    consecutiveFailures: z.number().int().nonnegative(),
    retryDelayMs: z.number().int().nonnegative().optional(),
    nextRetryAt: z.number().int().optional(),
  }).optional(),
}).strict()

export function rec(input: unknown) {
  return input && typeof input === "object" ? input as Record<string, unknown> : undefined
}

export function txt(input: unknown) {
  return typeof input === "string" && input.trim() ? input.trim() : undefined
}

export function num(input: unknown) {
  return typeof input === "number" && Number.isFinite(input) ? input : undefined
}

export async function json(req: Request) {
  return await req.json().catch(() => ({}))
}

export async function authContext(req: Request, options: ControlPlaneHttpOptions) {
  try {
    return await controlPlaneAuthContext(req, {
      config: options.authConfig,
      verifier: options.verifier,
      cliTokenEnv: options.cliTokenEnv,
    })
  } catch (err) {
    if (err instanceof ControlPlaneAuthError) {
      const runtime = runtimeAuth(req)
      if (runtime) return runtime
    }
    throw err
  }
}

export function assertRuntimeMutationAuth(
  req: Request,
  auth: ControlPlaneAuthContext,
  workspaceId: string,
) {
  if (auth.mode === "signed") {
    throw new ControlPlaneProtocolError(
      403,
      "workspace_runtime_control_token_required",
      "Workspace runtime control token is required",
    )
  }
  if (auth.reason !== "workspace-runtime-control-token") return
  if (req.headers.get("x-workspace-id")?.trim() === workspaceId) return
  throw new ControlPlaneProtocolError(
    403,
    "workspace_runtime_control_token_mismatch",
    "Workspace runtime control token does not match the request workspace",
  )
}

export function errorResponse(error: unknown) {
  if (error instanceof ControlPlaneAuthError) {
    return Response.json(controlPlaneAuthErrorBody(error), { status: error.status })
  }
  if (error instanceof ControlPlaneProtocolError) {
    return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status })
  }
  if (error instanceof WorkspaceRuntimeTargetError) {
    return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status })
  }
  if (error instanceof IdempotencyCapacityError || error instanceof IdempotencyConflictError) {
    return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status })
  }
  if (error instanceof z.ZodError) {
    return Response.json({
      error: {
        code: "invalid_control_plane_payload",
        message: "Invalid control-plane request body",
        details: error.flatten(),
      },
    }, { status: 400 })
  }
  return Response.json({
    error: {
      code: "control_plane_request_failed",
      message: error instanceof Error ? error.message : String(error),
    },
  }, { status: 500 })
}

function runtimeAuth(req: Request): ControlPlaneAuthContext | undefined {
  if (!verifyWorkspaceRuntimeControlToken(
    req.headers.get("x-workspace-id")?.trim(),
    bearerToken(req.headers.get("authorization")),
  )) return
  return {
    mode: "unsigned-local",
    reason: "workspace-runtime-control-token",
  }
}
