import type { AgentPermission, AgentQuestion, AgentSessionStartBinding } from "@claxedo/agent-runtime-contract"
import { asRecord } from "@claxedo/helpers/guards"
import { routeParam } from "@claxedo/helpers/route-param"
import type { RuntimeDirectory } from "../host/contracts"
import { isAgentRuntimeRequestRefusedError } from "../host/runtime"
import { arr, str } from "../json-value"
import type { SessionAccessOperation } from "../session-access-policy"
import { errorBody } from "./error-body"
import { collectionSessionIds, explicitSessionId, sessionOperationGuard, sessionStartGuard } from "./session-access-guards"
import { engineRefusalResponse, unsupportedIfUnavailable } from "./session-harness-refusal"
import type { SessionRouteContext as Ctx, SessionRouteOptions as Opts } from "./session-route-options"

/** The `string[][]` a question reply must carry, or `undefined` when it does not. */
export function questionAnswers(input: unknown): string[][] | undefined {
  const rows = arr(input)
  if (!rows) return undefined
  const answers: string[][] = []
  for (const row of rows) {
    const values = arr(row)
    if (!values?.every((value) => str(value) !== undefined)) return undefined
    answers.push(values.filter((value): value is string => str(value) !== undefined))
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

export function interactionSessionMismatch(c: Ctx, kind: "permission" | "question", id: string) {
  return c.json({
    ok: false,
    error: {
      code: "interaction_session_mismatch",
      message: `Pending ${kind} ${id} does not belong to the supplied session`,
    },
  }, 409)
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

/**
 * Resolves the session a `/question/:id` request acts on, then admits it.
 *
 * Unlike every other session operation, the question routes take their session
 * from an OPTIONAL `?sessionId=` query param — a pending question already knows
 * which session asked it. Admission still has to cover the omitted-param case:
 * gating the guard on the param let any caller skip admission entirely by
 * leaving it off, reaching `replyQuestion`/`rejectQuestion` unchecked.
 *
 * The pending-question listing is authoritative. A supplied session is only a
 * consistency assertion and never selects the authorization target.
 */
export async function admitQuestionOperation(
  opts: Opts,
  c: Ctx,
): Promise<
  | { rejected: Response; id?: undefined; directory?: undefined; sessionId?: undefined }
  | { rejected?: undefined; id: string; directory: RuntimeDirectory; sessionId: string; start?: AgentSessionStartBinding }
> {
  const id = routeParam(c, "id")
  const requested = c.req.query("sessionId") ?? ""
  const directory = await opts.resolveDirectory(c)
  const runtime = await opts.runtime(c)
  const known = interactionSessionId(await runtime.questions.list(directory ?? ""), id)
  if (!known) return { rejected: interactionNotFound(c, "question", id) }
  if (requested && requested !== known) return { rejected: interactionSessionMismatch(c, "question", id) }
  const pending = opts.sessionStarts?.get(known)
  if (pending && pending.status !== "created") {
    const denied = await sessionStartGuard(opts, c, pending.binding, "question_response")
    if (denied) return { rejected: denied }
    if (pending.status !== "starting") return { rejected: interactionNotFound(c, "question", id) }
    return { id, directory, sessionId: known, start: pending.binding }
  }
  const asking = await runtime.questions.askingSession(known)
  const guarded = await sessionOperationGuard(opts, c, asking, "question_response")
  if (guarded) return { rejected: guarded }
  const unsupported = await unsupportedIfUnavailable(c, runtime, { sessionId: asking, ...(directory ? { directory } : {}) }, "questions", "question_response")
  if (unsupported) return { rejected: unsupported }
  return { id, directory, sessionId: known }
}
