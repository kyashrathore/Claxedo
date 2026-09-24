import type { AgentPresentationSession } from "@claxedo/agent-runtime-contract"
import { ServerError, isNotFound, responseError } from "./errors"
import { sessionId, type RequestId } from "./ids"
import type { SessionsApi } from "./api"
import { controlGoal, readGoalState } from "./session-goal"
import { createSessionQueue } from "./session-queue"
import { createStatusesRead, readRequests } from "./session-statuses"
import { stopTurn } from "./session-stop"
import type { StatusOwner } from "./status"
import { jsonInit, withQuery, type RuntimeRoute, type Transport } from "./transport"
import type { AgentRequestReply, SessionCreateInput, SessionPage, SessionRef, SessionRow, SessionSnapshot, TranscriptPage } from "./types"
import type { Workspaces } from "./workspaces"
import { createMessageIds } from "./wire/ascending-id"
import { harnessIdentity, harnessSelectionQuery } from "./wire/harness-selection"
import { promptBody } from "./wire/prompt"
import { permissionReplyBody } from "./wire/requests"
import { sessionRowFromListItem, sessionRowFromSession } from "./wire/session-row"
import { OLDER_CURSOR_HEADER, transcriptPageFromWire } from "./wire/transcript"

const OLDER_PAGE_SIZE = 50
const ALL_WORKSPACES_SCOPE = "workspace"

function sessionPath(ref: SessionRef, suffix = "") {
  return `/session/${encodeURIComponent(ref.sessionId)}${suffix}`
}

function createBody(input: SessionCreateInput) {
  return {
    ...(input.title ? { title: input.title } : {}),
    ...(input.harness ? { harness: harnessIdentity(input.harness) } : {}),
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
    const query = { scope: ALL_WORKSPACES_SCOPE, sort: "human_turn_desc", limit: options.limit, cursor: options.cursor }
    const body = await transport.json<{ items?: unknown; nextCursor?: unknown }>(withQuery(listPath, query))
    const rows = await rowsOf(Array.isArray(body.items) ? body.items : [])
    return { rows, ...(typeof body.nextCursor === "string" ? { nextCursor: body.nextCursor } : {}) }
  }

  const readPage = async (where: RuntimeRoute, path: string): Promise<TranscriptPage> => {
    const response = await transport.runtime(where, path)
    if (!response.ok) throw await responseError(response, "Transcript page")
    return transcriptPageFromWire(await response.json(), response.headers.get(OLDER_CURSOR_HEADER))
  }

  const snapshot = async (ref: SessionRef): Promise<SessionSnapshot> => {
    const where = await route(ref)
    const [row, transcript, requests, todos, goal] = await Promise.all([
      transport.runtimeJson<AgentPresentationSession>(where, sessionPath(ref)),
      readPage(where, withQuery(sessionPath(ref, "/message"), { view: "latest-surface" })),
      readRequests(transport, where, ref.sessionId),
      transport.runtimeJson<SessionSnapshot["todos"]>(where, sessionPath(ref, "/todo")),
      readGoalState(transport, where, ref),
    ])
    return {
      row: sessionRowFromSession(row, ref),
      status: await status.read(where, ref.sessionId, row),
      transcript,
      requests: requests.map((item) => item.request),
      todos,
      diff: row.summary?.diffs ?? [],
      goal,
    }
  }

  const older = async (ref: SessionRef, cursor: string): Promise<TranscriptPage> => {
    return readPage(await route(ref), withQuery(sessionPath(ref, "/message"), { limit: OLDER_PAGE_SIZE, before: cursor }))
  }

  const create = async (input: SessionCreateInput): Promise<SessionRow> => {
    const where = await workspaces.route(input.placementId)
    const placement = workspaces.byId(input.placementId)
    if (!placement) throw new ServerError({ class: "not_found", message: `Placement ${input.placementId} is not in the catalog` })
    const path = withQuery("/session", input.harness ? harnessSelectionQuery(input.harness) : {})
    const created = await transport.runtimeJson<AgentPresentationSession>(where, path, jsonInit("POST", createBody(input)))
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
    controlGoal: async (ref, action) => controlGoal(transport, await route(ref), ref, action),
  }
}
