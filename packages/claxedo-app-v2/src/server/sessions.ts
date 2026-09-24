import type { AgentPresentationSession } from "@claxedo/agent-runtime-contract"
import { ServerError, isNotFound } from "./errors"
import { sessionId, type RequestId } from "./ids"
import type { SessionsApi } from "./index"
import { createSessionQueue } from "./session-queue"
import { createStatusesRead, readRequests } from "./session-statuses"
import { stopTurn } from "./session-stop"
import type { StatusOwner } from "./status"
import { jsonInit, withQuery, type Transport } from "./transport"
import type { AgentRequestReply, SessionCreateInput, SessionPage, SessionRef, SessionRow, SessionSnapshot, TranscriptEntry, TranscriptPage } from "./types"
import type { Workspaces } from "./workspaces"
import { createMessageIds } from "./wire/ascending-id"
import { promptBody } from "./wire/prompt"
import { permissionReplyBody } from "./wire/requests"
import { sessionRowFromListItem, sessionRowFromSession } from "./wire/session-row"

const NATIVE_HARNESSES: ReadonlySet<string> = new Set(["claude", "codex", "cursor", "pi", "opencode"])
const OLDER_PAGE_SIZE = 50

type MessagePage = { readonly messages?: unknown; readonly nextCursor?: unknown }

function isEntry(value: unknown): value is TranscriptEntry {
  const row = value as { info?: unknown; parts?: unknown } | null
  return !!row && !!row.info && typeof row.info === "object" && Array.isArray(row.parts)
}

function transcriptPage(body: MessagePage): TranscriptPage {
  const rows = Array.isArray(body.messages) ? body.messages : []
  return { entries: rows.filter(isEntry), ...(typeof body.nextCursor === "string" ? { olderCursor: body.nextCursor } : {}) }
}

function sessionPath(ref: SessionRef, suffix = "") {
  return `/session/${encodeURIComponent(ref.sessionId)}${suffix}`
}

function harnessQuery(harness: string | undefined) {
  if (!harness) return {}
  return NATIVE_HARNESSES.has(harness) ? { nativeHarness: harness } : { connectionId: harness }
}

function createBody(input: SessionCreateInput) {
  return {
    ...(input.title ? { title: input.title } : {}),
    ...(input.model ? { model: { providerID: input.model.providerId, id: input.model.modelId, ...(input.model.variant ? { variant: input.model.variant } : {}) } } : {}),
  }
}

export function createSessionsApi(transport: Transport, workspaces: Workspaces, status: StatusOwner): SessionsApi {
  const route = (ref: SessionRef) => workspaces.route(ref)
  const newMessageId = createMessageIds()
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
    await workspaces.load()
    const query = { scope: "global", sort: "human_turn_desc", limit: options.limit, cursor: options.cursor }
    const body = await transport.json<{ items?: unknown; nextCursor?: unknown }>(withQuery(listPath, query))
    const rows = await rowsOf(Array.isArray(body.items) ? body.items : [])
    return { rows, ...(typeof body.nextCursor === "string" ? { nextCursor: body.nextCursor } : {}) }
  }

  const snapshot = async (ref: SessionRef): Promise<SessionSnapshot> => {
    const where = await route(ref)
    const [row, page, requests, todos] = await Promise.all([
      transport.runtimeJson<AgentPresentationSession>(where, sessionPath(ref)),
      transport.runtimeJson<MessagePage>(where, withQuery(sessionPath(ref, "/message"), { view: "latest-surface" })),
      readRequests(transport, where, ref.sessionId),
      transport.runtimeJson<SessionSnapshot["todos"]>(where, sessionPath(ref, "/todo")),
    ])
    return {
      row: sessionRowFromSession(row, ref),
      status: await status.read(where, ref.sessionId, row),
      transcript: transcriptPage(page),
      requests: requests.map((item) => item.request),
      todos,
      diff: row.summary?.diffs ?? [],
    }
  }

  const older = async (ref: SessionRef, cursor: string): Promise<TranscriptPage> => {
    const path = withQuery(sessionPath(ref, "/message"), { limit: OLDER_PAGE_SIZE, before: cursor })
    return transcriptPage(await transport.runtimeJson<MessagePage>(await route(ref), path))
  }

  const create = async (input: SessionCreateInput): Promise<SessionRow> => {
    const where = await workspaces.route(input.placementId)
    const placement = workspaces.byId(input.placementId)
    if (!placement) throw new ServerError({ class: "not_found", message: `Placement ${input.placementId} is not in the catalog` })
    const created = await transport.runtimeJson<AgentPresentationSession>(where, withQuery("/session", harnessQuery(input.harness)), jsonInit("POST", createBody(input)))
    return sessionRowFromSession(created, { projectId: placement.projectId, placementId: input.placementId, sessionId: sessionId(created.id) })
  }

  const reply = async (ref: SessionRef, id: RequestId, answer: AgentRequestReply) => {
    const where = await route(ref)
    const questionPath = (action: "reply" | "reject") => withQuery(`/question/${encodeURIComponent(id)}/${action}`, { sessionId: ref.sessionId })
    const permissionPath = sessionPath(ref, `/permissions/${encodeURIComponent(id)}`)
    if (answer.kind === "question") {
      await transport.runtimeJson<unknown>(where, questionPath("reply"), jsonInit("POST", { answers: answer.answers }))
      return
    }
    if (answer.kind === "permission" || answer.request === "permission") {
      await transport.runtimeJson<unknown>(where, permissionPath, jsonInit("POST", permissionReplyBody(answer)))
      return
    }
    try {
      await transport.runtimeJson<unknown>(where, questionPath("reject"), { method: "POST" })
    } catch (error) {
      if (!isNotFound(error)) throw error
      await transport.runtimeJson<unknown>(where, permissionPath, jsonInit("POST", permissionReplyBody(answer)))
    }
  }

  return {
    list,
    snapshot,
    older,
    create,
    prompt: async (ref, input) => {
      const body = promptBody(input, input.messageId ?? newMessageId())
      await transport.runtimeJson<unknown>(await route(ref), sessionPath(ref, "/prompt_async"), jsonInit("POST", body))
    },
    stop: async (ref) => stopTurn(transport, await route(ref), ref),
    reply,
    rename: async (ref, title) => {
      await transport.runtimeJson<unknown>(await route(ref), sessionPath(ref), jsonInit("PATCH", { title }))
    },
    archive: async (ref, archived) => {
      await transport.runtimeJson<unknown>(await route(ref), sessionPath(ref), jsonInit("PATCH", { time: { archived: archived ? Date.now() : 0 } }))
    },
    remove: async (ref) => {
      await transport.runtimeJson<unknown>(await route(ref), sessionPath(ref), { method: "DELETE" })
      status.forget(ref)
    },
    statuses: createStatusesRead(transport, workspaces, status),
    newMessageId,
    ...createSessionQueue(transport, workspaces),
  }
}
