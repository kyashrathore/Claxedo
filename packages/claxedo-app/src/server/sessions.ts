import { createMessageIds, type AgentPresentationSession } from "@claxedo/agent-runtime-contract"
import type { SessionsApi } from "./api"
import { ServerError } from "./errors"
import { sessionId, type RequestId } from "./ids"
import { controlGoal, startGoal } from "./session-goal"
import { createSessionQueue } from "./session-queue"
import { readTurn } from "./turn"
import { listSessions } from "./session-list"
import { readSessionInventory, writeReader } from "./session-inventory"
import { sessionEndpoint, type SessionContext } from "./session-context"
import { startSessionReads } from "./session-reads"
import { readPart, readTurnPageBefore } from "./transcript-reads"
import type { HostedAccount } from "./account"
import { cancelRunningTurn, stopBackgroundTask } from "./session-stop"
import type { StatusOwner } from "./status"
import { jsonInit, withQuery, type Transport } from "./transport"
import type { AgentRequestReply, PromptDelivery, PromptInput, SessionCreateInput, SessionLocation, SessionRow } from "./types"
import type { SessionProjection } from "./session-projection"
import { RESERVATION_HEADER, reserveSession } from "./session-reservation"
import type { WorkspaceWakes } from "./workspace-wakes"
import type { Workspaces } from "./workspaces"
import { harnessIdentity, harnessSelectionQuery } from "./wire/harness-selection"
import { PROMPT_ROUTE, promptBody, promptDeliveryFromWire } from "./wire/prompt"
import { permissionReplyBody } from "./wire/requests"
import { sessionRowFromSession } from "./wire/session-row"

function firstInputBody(prompt: SessionCreateInput["prompt"]) {
  if (!prompt) return {}
  return prompt.goal ? { goal: { objective: prompt.goal.objective } } : { prompt: promptBody(prompt, prompt.messageId) }
}

function createBody(input: SessionCreateInput) {
  return {
    ...(input.title ? { title: input.title } : {}),
    ...(input.harness ? { harness: harnessIdentity(input.harness) } : {}),
    ...(input.model ? { model: { providerID: input.model.providerId, id: input.model.modelId, ...(input.model.variant ? { variant: input.model.variant } : {}) } } : {}),
    ...firstInputBody(input.prompt),
  }
}

async function createSession(context: SessionContext, wakes: WorkspaceWakes, input: SessionCreateInput): Promise<SessionRow> {
  await wakes.wakeIfStopped(input.placementId)
  const where = await context.workspaces.route(input.placementId)
  const placement = context.workspaces.byId(input.placementId)
  if (!placement) throw new ServerError({ class: "not_found", message: `Placement ${input.placementId} is not in the catalog` })
  const path = withQuery("/session", input.harness ? harnessSelectionQuery(input.harness) : {})
  const reservation = where.remote && context.account
    ? await reserveSession(context.account, { workspaceId: where.workspaceId, ...(input.title ? { title: input.title } : {}) })
    : undefined
  const body = { ...createBody(input), ...(reservation ? { id: reservation.sessionId } : {}) }
  const init = jsonInit("POST", body, reservation ? { headers: { [RESERVATION_HEADER]: reservation.operationId } } : undefined)
  const created = await context.transport.runtimeJson<AgentPresentationSession>(where, path, init)
  return sessionRowFromSession(created, { projectId: placement.projectId, placementId: input.placementId, sessionId: sessionId(created.id) })
}

async function replyToRequest(context: SessionContext, ref: SessionLocation, id: RequestId, answer: AgentRequestReply) {
  const { transport } = context
  const where = await context.workspaces.route(ref)
  const questionPath = (action: "reply" | "reject") => withQuery(`/question/${encodeURIComponent(id)}/${action}`, { sessionId: ref.sessionId })
  const permissionPath = sessionEndpoint(ref, `/permissions/${encodeURIComponent(id)}`)
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

async function postPrompt(context: SessionContext, wakes: WorkspaceWakes, ref: SessionLocation, input: PromptInput, messageId: string): Promise<PromptDelivery> {
  await wakes.wakeIfStopped(ref.placementId)
  const where = await context.workspaces.route(ref)
  if (input.goal) {
    await startGoal(context.transport, where, ref, input.goal.objective)
    return "start"
  }
  const answer = await context.transport.runtimeJson<unknown>(where, sessionEndpoint(ref, PROMPT_ROUTE), jsonInit("POST", promptBody(input, messageId)))
  return promptDeliveryFromWire(answer)
}

async function patchSession(context: SessionContext, ref: SessionLocation, patch: Record<string, unknown>) {
  await context.transport.runtimeJson<unknown>(await context.workspaces.route(ref), sessionEndpoint(ref), jsonInit("PATCH", patch))
}

export function createSessionsApi(transport: Transport, workspaces: Workspaces, status: StatusOwner, wakes: WorkspaceWakes, projection: SessionProjection, account?: HostedAccount): SessionsApi {
  const context: SessionContext = { transport, workspaces, status, ...(account ? { account } : {}) }
  const newMessageId = createMessageIds()
  return {
    list: (options) => listSessions(context, options),
    inventory: (input) => readSessionInventory(context, input),
    reader: (ref, command) => writeReader(context, ref, command),
    read: (ref, shape, held) => startSessionReads(context, ref, shape, held),
    page: (ref, shape, before) => readTurnPageBefore(context, ref, shape, before),
    part: (ref, messageId, partId) => readPart(context, ref, messageId, partId),
    turn: (ref, turnId) => readTurn(context, ref, turnId),
    create: async (input) => {
      const row = await createSession(context, wakes, input)
      void projection.created(row.ref)
      return row
    },
    prompt: (ref, input) => postPrompt(context, wakes, ref, input, input.messageId ?? newMessageId()),
    stop: async (ref) => cancelRunningTurn(transport, await workspaces.route(ref), ref),
    stopBackgroundTask: async (ref, toolCallId) => stopBackgroundTask(transport, await workspaces.route(ref), ref, toolCallId),
    reply: (ref, id, answer) => replyToRequest(context, ref, id, answer),
    rename: (ref, title) => patchSession(context, ref, { title }),
    archive: (ref, archived) => patchSession(context, ref, { time: { archived: archived ? Date.now() : 0 } }),
    remove: async (ref) => {
      await transport.runtimeJson<unknown>(await workspaces.route(ref), sessionEndpoint(ref), { method: "DELETE" })
      status.forget(ref)
    },
    newMessageId,
    ...createSessionQueue(context),
    controlGoal: async (ref, action) => controlGoal(transport, await workspaces.route(ref), ref, action),
  }
}
