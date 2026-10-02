import type { AgentPermission, AgentQuestion, AgentSessionStartBinding } from "@claxedo/agent-runtime-contract"
import { asRecord, asArrayOrUndefined, asString } from "@claxedo/helpers/guards"
import { routeParam } from "@claxedo/helpers/route-param"
import type { RuntimeDirectory } from "../host/contracts"
import { isAgentRuntimeRequestRefusedError, type AgentRuntime } from "../host/runtime"
import { sessionAccessContext, type SessionAccessOperation } from "../session-access-policy"
import { errorBody } from "./error-body"
import { collectionSessionIds, explicitSessionId, sessionStartGuard } from "./session-access-guards"
import { sessionOperationGuard } from "./session-operation-guard"
import { engineRefusalResponse, unsupportedIfUnavailable } from "./session-harness-refusal"
import type { SessionRouteContext as Ctx, SessionRouteOptions as Opts } from "./session-route-options"

/** The `string[][]` a question reply must carry, or `undefined` when it does not. */
export function questionAnswers(input: unknown): string[][] | undefined {
  const rows = asArrayOrUndefined(input)
  if (!rows) return undefined
  const answers: string[][] = []
  for (const row of rows) {
    const values = asArrayOrUndefined(row)
    if (!values?.every((value) => asString(value) !== undefined)) return undefined
    answers.push(values.filter((value): value is string => asString(value) !== undefined))
  }
  return answers
}

export function interactionSessionId(rows: readonly unknown[], interactionId: string) {
  return explicitSessionId(rows.find((item) => asRecord(item)?.id === interactionId))
}

export function interactionNotFound(c: Ctx, kind: "permission" | "question", id: string) {
  return c.json({
    ok: false,
    error: {
      code: "interaction_not_found",
      message: `Pending ${kind} ${id} was not found`,
    },
  }, 404)
}

/** A request filed on a subagent's child session is listed and answered under the session whose harness asked it. */
export async function filterRequestRows<T extends { sessionID: string }>(opts: Opts, c: Ctx, operation: SessionAccessOperation, rows: T[],
  askingSession: (sessionId: string) => Promise<string>) {
  const asking = new Map<string, string>()
  for (const row of rows) if (!asking.has(row.sessionID)) asking.set(row.sessionID, await askingSession(row.sessionID))
  const allowed = await collectionSessionIds(opts, c, operation, [...asking.values()])
  return rows.filter((row) => allowed.has(asking.get(row.sessionID) ?? row.sessionID))
}

export async function listPermissionRows(opts: Opts, c: Ctx, directory: RuntimeDirectory): Promise<AgentPermission[] | Response> {
  try {
    return await (await opts.runtime(c)).permissions.list(directory ?? "")
  } catch (error) {
    return engineRefusalResponse(c, error)
  }
}

export async function listQuestionRows(opts: Opts, c: Ctx, directory: RuntimeDirectory): Promise<AgentQuestion[] | Response> {
  try {
    return await (await opts.runtime(c)).questions.list(directory ?? "")
  } catch (error) {
    return engineRefusalResponse(c, error)
  }
}

/** A request answer the broker refused, in the refusal's own words and status. */
export function requestRefusedResponse(c: Ctx, error: unknown) {
  if (!isAgentRuntimeRequestRefusedError(error)) throw error
  const status = error.refusal === "stale" ? 404 : error.refusal === "persistence" ? 503 : 409
  return c.json(errorBody(`request_${error.refusal}`, error.message, { retryable: error.retryable }), status)
}

type QuestionAdmission =
  | { rejected: Response; start?: undefined }
  | { rejected?: undefined; start?: AgentSessionStartBinding }

/** Admits the caller on one session's questions: by its start binding while it is starting, otherwise on the session whose harness asks. */
async function admitQuestionSession(opts: Opts, c: Ctx, runtime: AgentRuntime, sessionId: string, id: string): Promise<QuestionAdmission> {
  const pending = opts.sessionStarts?.get(sessionId)
  if (pending && pending.status !== "created") {
    const denied = await sessionStartGuard(opts, c, pending.binding, "question_response")
    if (denied) return { rejected: denied }
    if (pending.status !== "starting") return { rejected: interactionNotFound(c, "question", id) }
    return { start: pending.binding }
  }
  const guarded = await sessionOperationGuard(opts, c, await runtime.questions.askingSession(sessionId), "question_response")
  return guarded ? { rejected: guarded } : {}
}

/**
 * Resolves the session a `/question/:id` request acts on, then admits it.
 *
 * The question routes take their session from an OPTIONAL `?sessionId=`, and a
 * token scoped to one session names that session whether or not the param
 * does. A named session is admitted before the id is resolved, and the id is
 * then found only among that session's questions, so a question the caller may
 * not answer is refused exactly as one that does not exist. Only a caller who
 * names no session and holds no scope, the workspace's own, is admitted on the
 * session the pending-question listing says asked it.
 */
export async function admitQuestionOperation(
  opts: Opts,
  c: Ctx,
): Promise<
  | { rejected: Response; id?: undefined; directory?: undefined; sessionId?: undefined }
  | { rejected?: undefined; id: string; directory: RuntimeDirectory; sessionId: string; start?: AgentSessionStartBinding }
> {
  const id = routeParam(c, "id")
  const requested = c.req.query("sessionId") || undefined
  const scope = sessionAccessContext(c).authority?.sessionId
  const directory = await opts.resolveDirectory(c)
  const runtime = await opts.runtime(c)
  const named = requested ?? scope
  const early = named === undefined ? undefined : await admitQuestionSession(opts, c, runtime, named, id)
  if (early?.rejected) return early
  const known = interactionSessionId(await runtime.questions.list(directory ?? ""), id)
  const outside = !known
    || (requested !== undefined && known !== requested)
    || (requested === undefined && scope !== undefined && await runtime.questions.askingSession(known) !== scope)
  if (outside) return { rejected: interactionNotFound(c, "question", id) }
  const admitted = early ?? await admitQuestionSession(opts, c, runtime, known, id)
  if (admitted.rejected) return admitted
  if (admitted.start) return { id, directory, sessionId: known, start: admitted.start }
  const asking = await runtime.questions.askingSession(known)
  const unsupported = await unsupportedIfUnavailable(c, runtime, { sessionId: asking, ...(directory ? { directory } : {}) }, "questions", "question_response")
  if (unsupported) return { rejected: unsupported }
  return { id, directory, sessionId: known }
}
