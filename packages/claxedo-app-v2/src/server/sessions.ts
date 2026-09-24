import type { AgentPresentationSession } from "@claxedo/agent-runtime-contract"
import type { SessionsApi } from "./api"
import { ServerError } from "./errors"
import { sessionId, type RequestId } from "./ids"
import { sessionPath, type SessionContext } from "./session-context"
import { controlGoal, startGoal } from "./session-goal"
import { createSessionQueue } from "./session-queue"
import { readLatestTurn } from "./latest-turn"
import { listSessions, readOlder, readSnapshot } from "./session-reads"
import { createStatusesRead } from "./session-statuses"
import { stopTurn } from "./session-stop"
import type { StatusOwner } from "./status"
import { jsonInit, withQuery, type Transport } from "./transport"
import type { AgentRequestReply, PromptDelivery, PromptInput, SessionCreateInput, SessionRef, SessionRow } from "./types"
import type { Workspaces } from "./workspaces"
import { createMessageIds } from "./wire/ascending-id"
import { harnessIdentity, harnessSelectionQuery } from "./wire/harness-selection"
import { promptBody, promptDeliveryFromWire } from "./wire/prompt"
import { permissionReplyBody } from "./wire/requests"
import { sessionRowFromSession } from "./wire/session-row"
import { subagentsFromWire } from "./wire/subagents"

function createBody(input: SessionCreateInput) {
  return {
    ...(input.title ? { title: input.title } : {}),
    ...(input.harness ? { harness: harnessIdentity(input.harness) } : {}),
    ...(input.model ? { model: { providerID: input.model.providerId, id: input.model.modelId, ...(input.model.variant ? { variant: input.model.variant } : {}) } } : {}),
  }
}

async function createSession(context: SessionContext, input: SessionCreateInput): Promise<SessionRow> {
  const where = await context.workspaces.route(input.placementId)
  const placement = context.workspaces.byId(input.placementId)
  if (!placement) throw new ServerError({ class: "not_found", message: `Placement ${input.placementId} is not in the catalog` })
  const path = withQuery("/session", input.harness ? harnessSelectionQuery(input.harness) : {})
  const created = await context.transport.runtimeJson<AgentPresentationSession>(where, path, jsonInit("POST", createBody(input)))
  return sessionRowFromSession(created, { projectId: placement.projectId, placementId: input.placementId, sessionId: sessionId(created.id) })
}

async function replyToRequest(context: SessionContext, ref: SessionRef, id: RequestId, answer: AgentRequestReply) {
  const { transport } = context
  const where = await context.workspaces.route(ref)
  const questionPath = (action: "reply" | "reject") => withQuery(`/question/${encodeURIComponent(id)}/${action}`, { sessionId: ref.sessionId })
  const permissionPath = sessionPath(ref, `/permissions/${encodeURIComponent(id)}`)
  if (answer.kind === "permission") {
    await transport.runtimeJson<unknown>(where, permissionPath, jsonInit("POST", permissionReplyBody(answer.reply)))
    return
  }
  if (answer.kind === "question") {
    await transport.runtimeJson<unknown>(where, questionPath("reply"), jsonInit("POST", { answers: answer.answers }))
    return
  }
  await transport.runtimeJson<unknown>(where, questionPath("reject"), { method: "POST" })
}

async function sendPrompt(context: SessionContext, ref: SessionRef, input: PromptInput, messageId: string): Promise<PromptDelivery> {
  const where = await context.workspaces.route(ref)
  if (input.goal) {
    await startGoal(context.transport, where, ref, input.goal.objective)
    return "start"
  }
  const answer = await context.transport.runtimeJson<unknown>(where, sessionPath(ref, "/prompt_async"), jsonInit("POST", promptBody(input, messageId)))
  return promptDeliveryFromWire(answer)
}

async function patchSession(context: SessionContext, ref: SessionRef, patch: Record<string, unknown>) {
  await context.transport.runtimeJson<unknown>(await context.workspaces.route(ref), sessionPath(ref), jsonInit("PATCH", patch))
}

export function createSessionsApi(transport: Transport, workspaces: Workspaces, status: StatusOwner): SessionsApi {
  const context: SessionContext = { transport, workspaces, status }
  const newMessageId = createMessageIds()
  return {
    list: (options) => listSessions(context, options),
    snapshot: (ref) => readSnapshot(context, ref),
    older: (ref, cursor) => readOlder(context, ref, cursor),
    latestTurn: (ref) => readLatestTurn(context, ref),
    create: (input) => createSession(context, input),
    prompt: (ref, input) => sendPrompt(context, ref, input, input.messageId ?? newMessageId()),
    stop: async (ref) => stopTurn(transport, await workspaces.route(ref), ref),
    reply: (ref, id, answer) => replyToRequest(context, ref, id, answer),
    rename: (ref, title) => patchSession(context, ref, { title }),
    archive: (ref, archived) => patchSession(context, ref, { time: { archived: archived ? Date.now() : 0 } }),
    remove: async (ref) => {
      await transport.runtimeJson<unknown>(await workspaces.route(ref), sessionPath(ref), { method: "DELETE" })
      status.forget(ref)
    },
    statuses: createStatusesRead(transport, workspaces, status),
    newMessageId,
    ...createSessionQueue(transport, workspaces),
    controlGoal: async (ref, action) => controlGoal(transport, await workspaces.route(ref), ref, action),
    subagents: async (ref) => subagentsFromWire(await transport.runtimeJson<unknown>(await workspaces.route(ref), sessionPath(ref, "/subagents"))),
  }
}
