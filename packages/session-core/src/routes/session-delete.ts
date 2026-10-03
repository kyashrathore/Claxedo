import type { Context } from "hono"
import { HTTPException } from "hono/http-exception"
import { asRecord, type SessionDeleteExpectation, type SessionDeleteRequest } from "@claxedo/agent-runtime-contract"
import { SessionDeleteAdmissionError } from "../host/delete-admission"
import type { RuntimeDirectory } from "../host/contracts"
import type { AgentRuntime } from "../host/runtime"
import { sessionDeleted, withDir } from "../projection/presentation-events"
import { after, readSession, requestSecretAuthority, type SessionRouteOptions } from "./session-route-options"
import { boundedTextBody, errorBody, noStoreJson } from "./http"
import { sessionOperationGuard } from "./session-operation-guard"
import { routeParam } from "@claxedo/helpers/route-param"
import { envelopeDirectory } from "../session/service"

type SessionChange = <T>(sessionId: string, change: () => Promise<T>) => Promise<T>

export async function sessionChildrenRoute(opts: SessionRouteOptions, c: Context): Promise<Response> {
  const sessionId = routeParam(c, "id")
  const guarded = await sessionOperationGuard(opts, c, sessionId, "session_meta_read")
  if (guarded) return guarded
  const directory = await opts.resolveDirectory(c, { sessionId })
  const runtime = await opts.runtime(c)
  if (!await runtime.sessions.get(sessionId, directory)) return noStoreJson(c, errorBody("session_not_found", "Session not found"), 404)
  const rows = await runtime.sessions.children(sessionId)
  for (const row of rows) {
    const denied = await sessionOperationGuard(opts, c, row.id, "session_meta_read")
    if (denied) return denied
  }
  return noStoreJson(c, rows)
}

function expectation(value: unknown): SessionDeleteExpectation | undefined {
  const record = asRecord(value)
  if (!record || typeof record.generation !== "number" || typeof record.activitySequence !== "number" || !Number.isSafeInteger(record.generation) || !Number.isSafeInteger(record.activitySequence)) return undefined
  if ((record.generation) < 1 || (record.activitySequence) < (record.generation)) return undefined
  return { generation: record.generation, activitySequence: record.activitySequence }
}

export async function readDeleteRequest(c: Context): Promise<SessionDeleteRequest | undefined> {
  const text = await boundedTextBody(c)
  if (text.length === 0) return undefined
  let body: unknown
  try { body = JSON.parse(text) } catch {
    throw new HTTPException(400, { res: c.json(errorBody("invalid_session_delete", "Session deletion body must be JSON"), 400) })
  }
  const record = asRecord(body)
  const expected = expectation(record?.expected)
  if (!record || !expected || !Array.isArray(record.descendants)) {
    throw new HTTPException(400, { res: c.json(errorBody("invalid_session_delete", "Expected activity and complete descendants are required"), 400) })
  }
  const descendants = record.descendants.map(value => {
    const entry = asRecord(value)
    const selected = expectation(value)
    if (!entry || typeof entry.sessionId !== "string" || !entry.sessionId || !selected) {
      throw new HTTPException(400, { res: c.json(errorBody("invalid_session_delete", "A descendant selection is invalid"), 400) })
    }
    return { sessionId: entry.sessionId, ...selected }
  })
  return { expected, descendants }
}

async function removeUnselectedSession(
  opts: SessionRouteOptions, c: Context, directory: RuntimeDirectory, sessionId: string, parentID?: string,
): Promise<void> {
  const start = opts.sessionStarts?.get(sessionId)?.binding
  await opts.beforeDeleteSession?.(c, directory, sessionId)
  await opts.disposeSessionDocuments?.(sessionId)
  await (await opts.runtime(c)).sessions.delete(sessionId, directory, requestSecretAuthority(c).secretAuthority)
  await after(opts.afterDeleteSession?.(c, directory, sessionId))
  if (start) opts.sessionStarts!.retire(start)
  opts.publishGlobal(withDir(envelopeDirectory(directory, sessionId), sessionDeleted(sessionId, directory ?? "", parentID)))
}

async function removeUnselectedChildren(
  opts: SessionRouteOptions, c: Context, directory: RuntimeDirectory, sessionId: string, withSessionChange: SessionChange,
): Promise<void> {
  if (!opts.childSessions) return
  for (const child of await opts.childSessions.children(sessionId, directory)) {
    await withSessionChange(child.childSessionId, async () => {
      if (!await readSession(opts, c, directory, child.childSessionId)) return
      await removeUnselectedSession(opts, c, directory, child.childSessionId, sessionId)
    })
  }
}

/** Authorization, identity claims, selection admission and deletion share one route owner. */
export async function sessionDeleteRoute(opts: SessionRouteOptions, c: Context, withSessionChange: SessionChange): Promise<Response> {
  const sessionId = routeParam(c, "id")
  const guarded = await sessionOperationGuard(opts, c, sessionId, "delete")
  if (guarded) return guarded
  return withSessionChange(sessionId, async () => {
    const directory = await opts.resolveDirectory(c, { sessionId })
    const selected = await readDeleteRequest(c)
    if (selected) return guardedDelete(opts, c, directory, sessionId, selected, withSessionChange)
    const parentID = (await readSession(opts, c, directory, sessionId).catch(() => undefined))?.parentID
    await removeUnselectedChildren(opts, c, directory, sessionId, withSessionChange)
    await removeUnselectedSession(opts, c, directory, sessionId, parentID)
    return c.json({ ok: true })
  })
}

async function withChanges<T>(ids: string[], change: SessionChange, operation: () => Promise<T>): Promise<T> {
  const [id, ...rest] = ids
  return id === undefined ? operation() : change(id, () => withChanges(rest, change, operation))
}

async function removeSelectedSessions(
  opts: SessionRouteOptions, c: Context, runtime: AgentRuntime, directory: RuntimeDirectory, ids: string[],
): Promise<Response> {
  const removed: string[] = []
  let current = ids[0]
  try {
    for (const id of ids) {
      current = id
      const row = await runtime.sessions.get(id, directory)
      if (!row) throw new SessionDeleteAdmissionError(id, "not_found")
      if (typeof row.directory !== "string") throw new SessionDeleteAdmissionError(id, "unavailable")
      const targetDirectory = row.directory
      const start = opts.sessionStarts?.get(id)?.binding
      await opts.beforeDeleteSession?.(c, targetDirectory, id)
      await opts.disposeSessionDocuments?.(id)
      await runtime.sessions.delete(id, targetDirectory, requestSecretAuthority(c).secretAuthority)
      removed.push(id)
      await opts.afterDeleteSession?.(c, targetDirectory, id)
      if (start) opts.sessionStarts!.retire(start)
      opts.publishGlobal(withDir(targetDirectory, sessionDeleted(id, targetDirectory, row.parentID)))
    }
    return c.json({ ok: true, deletedSessionIds: removed })
  } catch (error) {
    if (error instanceof SessionDeleteAdmissionError && removed.length === 0) throw error
    return c.json(errorBody("session_delete_failed", "Session deletion stopped before all effects completed", {
      sessionId: current, deletedSessionIds: removed,
    }), 500)
  }
}

export async function guardedDelete(
  opts: SessionRouteOptions, c: Context, directory: RuntimeDirectory, sessionId: string,
  request: SessionDeleteRequest, withSessionChange: SessionChange,
): Promise<Response> {
  try {
    return await withChanges(request.descendants.map(row => row.sessionId), withSessionChange, async () => {
      const runtime = await opts.runtime(c)
      return runtime.sessions.withDeleteAdmission(sessionId, request,
        deletedSessionIds => removeSelectedSessions(opts, c, runtime, directory, deletedSessionIds))
    })
  } catch (error) {
    if (!(error instanceof SessionDeleteAdmissionError)) throw error
    const status = error.reason === "unavailable" ? 503 : error.reason === "not_found" ? 404 : 409
    return c.json(errorBody(error.code, error.message, { sessionId: error.sessionId, reason: error.reason }), status)
  }
}
