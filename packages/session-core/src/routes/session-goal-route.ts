import type { AgentGoalMutationResult } from "@claxedo/agent-runtime-contract"
import { routeParam } from "@claxedo/helpers/route-param"
import type { RuntimeDirectory } from "../host/contracts"
import { isAgentRuntimeGoalError, type AgentRuntime } from "../host/runtime"
import type { SessionAccessOperation } from "../session-access-policy"
import { errorBody } from "./error-body"
import { noStoreJson } from "./http"
import { recordReaderSend } from "./session-route-options"
import { sessionOperationGuard } from "./session-operation-guard"
import type { SessionRouteContext as Ctx, SessionRouteOptions as Opts } from "./session-route-options"

export function goalRuntimeErrorResponse(c: Ctx, error: unknown) {
  if (!isAgentRuntimeGoalError(error)) throw error
  const status = error.code === "goal_invalid_objective"
    ? 400
    : error.code === "goal_session_not_found"
    ? 404
    : 409
  return noStoreJson(c, errorBody(error.code, error.message), status)
}

export function goalMutationResponse(
  c: Ctx,
  result: AgentGoalMutationResult,
  successStatus: 200 | 201 = 200,
) {
  if (result.ok) return noStoreJson(c, result, successStatus)
  const status = result.status === "not_found"
    ? 404
    : result.status === "failed"
    ? 502
    : 409
  return noStoreJson(c, result, status)
}

export async function resolveGoalRuntime(opts: Opts, c: Ctx) {
  return await opts.runtime(c)
}

export type GoalInvocation = (input: {
  c: Ctx
  sessionId: string
  directory: RuntimeDirectory
  runtime: AgentRuntime
}) => Promise<Response> | Response

/**
 * The scaffold every Goal start or control shares, `/session/:id/goal*` and a
 * create that carries its first goal alike: admit the operation, resolve the
 * Goal runtime, and translate a thrown `AgentRuntimeGoalError` into its typed
 * HTTP response. Each caller supplies only the runtime call that makes it
 * different, so a new admission or error rule lands on every Goal endpoint at
 * once instead of being copied into each handler.
 */
export function goalRoute(opts: Opts, operation: SessionAccessOperation, invoke: GoalInvocation) {
  return async (c: Ctx): Promise<Response> => {
    const sessionId = routeParam(c, "id")
    const guarded = await sessionOperationGuard(opts, c, sessionId, operation)
    if (guarded) return guarded
    return invokeGoalRuntime(opts, c, sessionId, await opts.resolveDirectory(c, { sessionId }), invoke)
  }
}

export async function invokeGoalRuntime(opts: Opts, c: Ctx, sessionId: string, directory: RuntimeDirectory, invoke: GoalInvocation) {
  const runtime = await resolveGoalRuntime(opts, c)
  try {
    return await invoke({ c, sessionId, directory, runtime })
  } catch (error) {
    return goalRuntimeErrorResponse(c, error)
  }
}

export function goalStartInvocation(objective: string): GoalInvocation {
  return async ({ c, sessionId, directory, runtime }) => {
    const started = await runtime.goals.start({ sessionId, objective }, directory)
    await recordReaderSend(runtime, c, sessionId)
    return goalMutationResponse(c, started, 201)
  }
}
