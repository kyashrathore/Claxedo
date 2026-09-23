import type { AgentPresentationSession, AgentSession, RecoveryOutcome, RecoveryTurnTarget } from "@claxedo/agent-runtime-contract"
import { isRecoveryOutcome, turnStopped } from "@claxedo/agent-runtime-contract"
import { ServerError, isNotFound, responseError } from "./errors"
import type { RequestId } from "./ids"
import type { StatusOwner } from "./status"
import { jsonInit, withQuery, type RuntimeRoute, type Transport } from "./transport"
import type { SessionsApi } from "./index"
import type {
  AgentRequest,
  AgentRequestReply,
  SessionCreateInput,
  SessionPage,
  SessionRef,
  SessionRow,
  SessionSnapshot,
  TranscriptEntry,
  TranscriptPage,
} from "./types"
import type { Workspaces } from "./workspaces"
import { promptBody } from "./wire/prompt"
import { isPermissionWire, isQuestionWire, permissionReplyBody, permissionRequest, questionRequest } from "./wire/requests"
import { sessionRowFromListItem, sessionRowFromSession } from "./wire/session-row"

const NATIVE_HARNESSES = new Set(["claude", "codex", "cursor", "pi", "opencode"])
const OLDER_PAGE_SIZE = 50

type MessagePage = { readonly messages?: unknown; readonly nextCursor?: unknown }

function isEntry(value: unknown): value is TranscriptEntry {
  const row = value as { info?: unknown; parts?: unknown } | null
  return !!row && !!row.info && typeof row.info === "object" && Array.isArray(row.parts ?? [])
}

function transcriptPage(body: MessagePage): TranscriptPage {
  const rows = Array.isArray(body.messages) ? body.messages : []
  const entries = rows.filter(isEntry).map((entry) => ({ info: entry.info, parts: entry.parts ?? [] }))
  return { entries, ...(typeof body.nextCursor === "string" ? { olderCursor: body.nextCursor } : {}) }
}

function sessionPath(ref: SessionRef, suffix = "") {
  return `/session/${encodeURIComponent(ref.sessionId)}${suffix}`
}

function harnessQuery(harness: string | undefined) {
  if (!harness) return {}
  return NATIVE_HARNESSES.has(harness) ? { nativeHarness: harness } : { connectionId: harness }
}

async function optional<T>(read: Promise<T>, fallback: T): Promise<T> {
  try {
    return await read
  } catch (error) {
    if (error instanceof ServerError && (error.class === "not_found" || error.status === 501)) return fallback
    throw error
  }
}

export function createSessionsApi(input: {
  readonly transport: Transport
  readonly workspaces: Workspaces
  readonly status: StatusOwner
}): SessionsApi {
  const { transport, workspaces, status } = input
  const route = (ref: SessionRef) => workspaces.routeFor(ref)

  const listPath = transport.loopback ? "/api/claxedo/session-list" : "/api/control/session-list"

  const rowsOf = async (items: readonly unknown[]): Promise<SessionRow[]> => {
    const rows: SessionRow[] = []
    for (const item of items) {
      let row = sessionRowFromListItem(item, workspaces.address)
      const directory = (item as { directory?: unknown }).directory
      if (!row && typeof directory === "string") {
        await workspaces.learn(directory)
        row = sessionRowFromListItem(item, workspaces.address)
      }
      if (row) rows.push(row)
    }
    return rows
  }

  const list = async (options: { readonly cursor?: string; readonly limit: number }): Promise<SessionPage> => {
    const body = await transport.json<{ items?: unknown; nextCursor?: unknown }>(withQuery(listPath, {
      scope: "global",
      sort: "human_turn_desc",
      limit: options.limit,
      cursor: options.cursor,
    }))
    const rows = await rowsOf(Array.isArray(body.items) ? body.items : [])
    return { rows, ...(typeof body.nextCursor === "string" ? { nextCursor: body.nextCursor } : {}) }
  }

  const readRow = (ref: SessionRef) => transport.runtimeJson<AgentPresentationSession>(route(ref), sessionPath(ref))

  const readRequests = async (where: RuntimeRoute, ref: SessionRef): Promise<AgentRequest[]> => {
    const [permissions, questions] = await Promise.all([
      optional(transport.runtimeJson<unknown[]>(where, "/permission"), []),
      optional(transport.runtimeJson<unknown[]>(where, withQuery("/question", { sessionId: ref.sessionId })), []),
    ])
    return [
      ...permissions.filter(isPermissionWire).filter((row) => row.sessionID === ref.sessionId).map(permissionRequest),
      ...questions.filter(isQuestionWire).filter((row) => row.sessionID === ref.sessionId).map(questionRequest),
    ]
  }

  const snapshot = async (ref: SessionRef): Promise<SessionSnapshot> => {
    const where = route(ref)
    const [row, page, requests, todos] = await Promise.all([
      readRow(ref),
      transport.runtimeJson<MessagePage>(where, withQuery(sessionPath(ref, "/message"), { view: "latest-surface" })),
      readRequests(where, ref),
      optional(transport.runtimeJson<unknown[]>(where, sessionPath(ref, "/todo")), []),
    ])
    const current = await status.read(where, ref.sessionId, row)
    return {
      row: sessionRowFromSession(row, ref),
      status: current,
      transcript: transcriptPage(page),
      requests,
      todos: todos as SessionSnapshot["todos"],
      diff: row.summary?.diffs ?? [],
    }
  }

  const older = async (ref: SessionRef, cursor: string): Promise<TranscriptPage> => {
    const body = await transport.runtimeJson<MessagePage>(route(ref), withQuery(sessionPath(ref, "/message"), { limit: OLDER_PAGE_SIZE, before: cursor }))
    return transcriptPage(body)
  }

  const create = async (options: SessionCreateInput): Promise<SessionRow> => {
    const where = workspaces.routeFor(options.placementId)
    const placement = workspaces.byId(options.placementId)
    if (!placement) throw new ServerError({ class: "not_found", message: `Placement ${options.placementId} is not in the catalog` })
    const body = {
      agent: "build",
      ...(options.model ? { model: { providerID: options.model.providerId, modelID: options.model.modelId } } : {}),
      ...(options.model?.variant ? { variant: options.model.variant } : {}),
    }
    const created = await transport.runtimeJson<{ id: string }>(where, withQuery("/session", harnessQuery(options.harness)), jsonInit("POST", body))
    const ref: SessionRef = { projectId: placement.projectId, placementId: options.placementId, sessionId: created.id as SessionRef["sessionId"] }
    if (options.title) await transport.runtimeJson<unknown>(where, sessionPath(ref), jsonInit("PATCH", { title: options.title }))
    return sessionRowFromSession(await readRow(ref), ref)
  }

  const prompt = async (ref: SessionRef, options: Parameters<SessionsApi["prompt"]>[1]) => {
    const response = await transport.runtime(route(ref), sessionPath(ref, "/prompt_async"), jsonInit("POST", promptBody(options)))
    if (!response.ok) throw await responseError(response, "Prompt")
  }

  const stop = async (ref: SessionRef) => {
    const where = route(ref)
    const inspected = await transport.runtimeJson<{ target?: RecoveryTurnTarget } | RecoveryOutcome>(where, sessionPath(ref, "/recovery"))
    if (isRecoveryOutcome(inspected)) throw stopRefused(inspected)
    const target = inspected.target
    if (!target) return
    const outcome = await transport.runtimeJson<RecoveryOutcome>(where, sessionPath(ref, "/recovery"), jsonInit("POST", {
      requestId: `stop:${crypto.randomUUID()}`,
      action: "cancel_turn",
      target,
      scopeRevision: target.ownerGeneration,
      attempt: 1,
    }))
    if (!turnStopped(outcome)) throw stopRefused(outcome)
  }

  const reply = async (ref: SessionRef, id: RequestId, answer: AgentRequestReply) => {
    const where = route(ref)
    const questionPath = (action: "reply" | "reject") => withQuery(`/question/${encodeURIComponent(id)}/${action}`, { sessionId: ref.sessionId })
    if (answer.kind === "question") {
      await transport.runtimeJson<unknown>(where, questionPath("reply"), jsonInit("POST", { answers: answer.answers }))
      return
    }
    if (answer.kind === "permission" || answer.request === "permission") {
      await transport.runtimeJson<unknown>(where, sessionPath(ref, `/permissions/${encodeURIComponent(id)}`), jsonInit("POST", permissionReplyBody(answer)))
      return
    }
    try {
      await transport.runtimeJson<unknown>(where, questionPath("reject"), { method: "POST" })
    } catch (error) {
      if (!isNotFound(error)) throw error
      await transport.runtimeJson<unknown>(where, sessionPath(ref, `/permissions/${encodeURIComponent(id)}`), jsonInit("POST", { response: "reject" }))
    }
  }

  return {
    list,
    snapshot,
    older,
    create,
    prompt,
    stop,
    reply,
    rename: async (ref, title) => {
      await transport.runtimeJson<unknown>(route(ref), sessionPath(ref), jsonInit("PATCH", { title }))
    },
    archive: async (ref, archived) => {
      await transport.runtimeJson<unknown>(route(ref), sessionPath(ref), jsonInit("PATCH", { time: { archived: archived ? Date.now() : 0 } }))
    },
    remove: async (ref) => {
      await transport.runtimeJson<unknown>(route(ref), sessionPath(ref), { method: "DELETE" })
      status.forget(ref)
    },
  }
}

function stopRefused(outcome: RecoveryOutcome): ServerError {
  if (outcome.kind === "refused") {
    const conflict = outcome.refusal.kind === "generation_conflict" || outcome.refusal.kind === "intent_conflict" || outcome.refusal.kind === "scope_changed"
    return new ServerError({ class: conflict ? "conflict" : outcome.refusal.kind === "unauthorized" ? "auth" : "internal", message: outcome.refusal.message, code: outcome.refusal.kind })
  }
  const error = outcome.operation.initiatingError ?? outcome.operation.cleanupErrors[0]
  return new ServerError({
    class: "internal",
    message: error?.message ?? `The turn did not stop (${outcome.operation.state})`,
    code: error?.code ?? outcome.operation.state,
  })
}

export type { AgentSession }
