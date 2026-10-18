import { HTTPException } from "hono/http-exception"
import { asRecord, asString } from "@claxedo/helpers/guards"
import type { RuntimeDirectory } from "../host/contracts"
import { goalRuntimeErrorResponse, resolveGoalRuntime } from "./session-goal-route"
import { unsupportedOperation } from "./session-harness-refusal"
import { listPermissionRows, listQuestionRows } from "./session-requests"
import { requestSecretAuthority, type SessionRouteContext as Ctx, type SessionRouteOptions as Opts } from "./session-route-options"

export function sessionStartSettled(opts: Opts, sessionId: string) {
  const start = opts.sessionStarts?.get(sessionId)
  return !start || start.status === "created"
}

async function sessionOwnStatus(opts: Opts, c: Ctx, directory: RuntimeDirectory, sessionId: string): Promise<unknown> {
  return (await opts.getStatus?.(c, directory))?.[sessionId] ?? null
}

/**
 * A harness without todos refuses with `unsupported_operation`, the code every
 * client reads for an operation it lacks. Neither the refusal nor the read
 * attaches the session: opening an idle session never launches its harness.
 */
async function readSessionTodos(opts: Opts, c: Ctx, directory: RuntimeDirectory, sessionId: string): Promise<readonly unknown[] | Response> {
  const runtime = await opts.runtime(c)
  const caps = await runtime.reads.declaredCapabilities(sessionId, directory, requestSecretAuthority(c).secretAuthority)
  if (!caps.todos) return unsupportedOperation(c, caps.harness, "todos", { capability: "todos" })
  const replay = await opts.getTodos?.(c, directory, sessionId)
  if (replay) return replay
  return await runtime.reads.todos(sessionId) ?? []
}

export async function listSessionSubagents(opts: Opts, c: Ctx, directory: RuntimeDirectory, sessionId: string) {
  return await opts.listSubagents?.(c, directory, sessionId) ?? []
}

async function readSessionGoal(opts: Opts, c: Ctx, directory: RuntimeDirectory, sessionId: string) {
  const runtime = await resolveGoalRuntime(opts, c)
  try {
    const capabilities = await runtime.goals.capabilities(sessionId, directory)
    return { capabilities, goal: capabilities.implemented ? await runtime.goals.read(sessionId, directory) : null }
  } catch (error) {
    return goalRuntimeErrorResponse(c, error)
  }
}

type SessionFactRefusal = { status: number; code?: string; message: string }
type SessionFact<T> = { value: T } | { error: SessionFactRefusal }

/**
 * One fact of the open view. A fact that cannot be read is reported in its
 * own field, so a failed side read never costs the reader the session row,
 * the same isolation the separate reads it replaces had.
 */
async function sessionFact<T>(read: () => Promise<T | Response>): Promise<SessionFact<T>> {
  try {
    const result = await read()
    if (!(result instanceof Response)) return { value: result }
    const refusal = asRecord(asRecord(await result.json())?.error)
    const code = asString(refusal?.code)
    return { error: { status: result.status, ...(code ? { code } : {}), message: asString(refusal?.message) ?? `Refused with status ${result.status}` } }
  } catch (error) {
    if (error instanceof HTTPException) return { error: { status: error.status, message: error.message } }
    console.error(error)
    return { error: { status: 500, message: "Internal Server Error" } }
  }
}

/**
 * `GET /session/:id?view=open`: every fact a reader needs beside the row to
 * open the session, read by the producers the per-fact routes use. The session
 * read's own guard admits them all: no session access policy tells one read
 * operation from another, because each classifies an operation only by its
 * `sessionAccessWriteClass`, and a read has none. The rows are narrowed to
 * this session here rather than filtered through the policy.
 */
export async function sessionOpenView(opts: Opts, c: Ctx, directory: RuntimeDirectory, sessionId: string) {
  const own = <T extends { sessionID: string }>(rows: T[] | Response) =>
    rows instanceof Response ? rows : rows.filter((row) => row.sessionID === sessionId)
  const [status, permissions, questions, todos, goal, subagents] = await Promise.all([
    sessionFact(() => sessionOwnStatus(opts, c, directory, sessionId)),
    sessionFact(async () => own(await listPermissionRows(opts, c, directory))),
    sessionFact(async () => sessionStartSettled(opts, sessionId) ? own(await listQuestionRows(opts, c, directory)) : []),
    sessionFact(() => readSessionTodos(opts, c, directory, sessionId)),
    sessionFact(() => readSessionGoal(opts, c, directory, sessionId)),
    sessionFact(() => listSessionSubagents(opts, c, directory, sessionId)),
  ])
  return { status, permissions, questions, todos, goal, subagents }
}
