import { createMessageIds } from "@claxedo/agent-runtime-contract"
import { productHarness, productWhere, type ProductTelemetry } from "./telemetry"
import type { SessionsApi } from "./api"
import { ServerError } from "./errors"
import { sessionId, type RequestId } from "./ids"
import { controlGoal, startGoal } from "./session-goal"
import { createSessionQueue } from "./session-queue"
import { readTurn } from "./turn"
import { listSessions } from "./session-list"
import { sendReaderWrite } from "./session-reader"
import { sessionEndpoint, type SessionContext } from "./session-context"
import { startSessionReads } from "./session-reads"
import { readPart, readTurnPageBefore } from "./transcript-reads"
import type { HostedAccount } from "./account"
import { cancelRunningTurn, stopBackgroundTask } from "./session-stop"
import type { StatusOwner } from "./status"
import { jsonInit, withQuery, type Transport } from "./transport"
import type { AgentRequestReply, PromptDelivery, PromptInput, SessionCreateInput, SessionLocation, SessionRow } from "./types"
import type { SessionProjection } from "./session-projection"
import { createSessionReservations, RESERVATION_HEADER, type SessionReservations } from "./session-reservation"
import type { WorkspaceWakes } from "./workspace-wakes"
import type { Workspaces } from "./workspaces"
import { harnessIdentity, harnessSelectionQuery } from "./wire/harness-selection"
import { PROMPT_ROUTE, promptBody, promptDeliveryFromWire } from "./wire/prompt"
import { permissionReplyBody } from "./wire/requests"
import { sessionFromWire, sessionRowFromSession } from "./wire/session-row"
import { isCheckpointFrozen, isRuntimeUnavailable } from "./wire/connection"

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

async function createSession(context: SessionContext, wakes: WorkspaceWakes, reservations: SessionReservations | undefined, input: SessionCreateInput): Promise<SessionRow> {
  await wakes.wakeIfStopped(input.placementId)
  const where = await context.workspaces.route(input.placementId)
  const placement = context.workspaces.byId(input.placementId)
  if (!placement) throw new ServerError({ class: "not_found", message: `Placement ${input.placementId} is not in the catalog` })
  const firstMessageId = input.prompt?.messageId
  const reservation = where.remote && reservations
    ? await reservations.reserve(firstMessageId, {
      workspaceId: where.workspaceId,
      ...(input.title ? { title: input.title } : {}),
      ...(input.harness ? { harness: harnessIdentity(input.harness) } : {}),
    })
    : undefined
  const hosted = reservation?.sessionHostRoot
  if (hosted) await context.transport.connectSession(where.workspaceId, hosted)
  const route = hosted ? { ...where, sessionHost: { sessionId: hosted } } : where
  const path = withQuery(hosted ? `/session/${encodeURIComponent(hosted)}` : "/session", input.harness ? harnessSelectionQuery(input.harness) : {})
  const body = { ...createBody(input), ...(reservation && !hosted ? { id: reservation.sessionId } : {}) }
  const init = jsonInit("POST", body, reservation ? { headers: { [RESERVATION_HEADER]: reservation.operationId } } : undefined)
  const created = sessionFromWire(await context.transport.runtimeJson(route, path, init))
  reservations?.created(firstMessageId)
  return sessionRowFromSession(created, { projectId: placement.projectId, placementId: input.placementId, sessionId: sessionId(created.id) })
}

async function replyToRequest(context: SessionContext, ref: SessionLocation, id: RequestId, answer: AgentRequestReply) {
  const { transport } = context
  const where = await context.workspaces.route(ref)
  const questionPath = (action: "reply" | "reject") => withQuery(`/question/${encodeURIComponent(id)}/${action}`, { sessionId: ref.sessionId })
  const permissionPath = sessionEndpoint(ref, `/permissions/${encodeURIComponent(id)}`)
  if (answer.kind === "permission") {
    await transport.runtimeJson(where, permissionPath, jsonInit("POST", permissionReplyBody(answer.reply)))
    return
  }
  if (answer.kind === "question") {
    await transport.runtimeJson(where, questionPath("reply"), jsonInit("POST", { answers: answer.answers }))
    return
  }
  await transport.runtimeJson(where, questionPath("reject"), { method: "POST" })
}

const CHECKPOINT_SETTLE_ATTEMPTS = 60

async function postPrompt(context: SessionContext, wakes: WorkspaceWakes, ref: SessionLocation, input: PromptInput, messageId: string): Promise<PromptDelivery> {
  await wakes.wakeIfStopped(ref.placementId)
  let woke = false
  for (let attempt = 1; ; attempt++) {
    try {
      return await deliverPrompt(context, ref, input, messageId)
    } catch (error) {
      if (isCheckpointFrozen(error) && attempt < CHECKPOINT_SETTLE_ATTEMPTS) {
        await wakes.settle(ref.placementId)
        continue
      }
      if (woke || !isRuntimeUnavailable(error)) throw error
      await context.workspaces.refresh()
      woke = await wakes.wakeIfStopped(ref.placementId)
      if (!woke) throw error
    }
  }
}

async function deliverPrompt(context: SessionContext, ref: SessionLocation, input: PromptInput, messageId: string): Promise<PromptDelivery> {
  const where = await context.workspaces.route(ref)
  if (input.goal) {
    await startGoal(context.transport, where, ref, input.goal.objective)
    return "start"
  }
  const answer = await context.transport.runtimeJson(where, sessionEndpoint(ref, PROMPT_ROUTE), jsonInit("POST", promptBody(input, messageId)))
  return promptDeliveryFromWire(answer)
}

async function patchSession(context: SessionContext, ref: SessionLocation, patch: Record<string, unknown>) {
  await context.transport.runtimeJson(await context.workspaces.route(ref), sessionEndpoint(ref), jsonInit("PATCH", patch))
}

export function createSessionsApi(transport: Transport, workspaces: Workspaces, status: StatusOwner, wakes: WorkspaceWakes, projection: SessionProjection, telemetry: ProductTelemetry, account?: HostedAccount): SessionsApi {
  const context: SessionContext = { transport, workspaces, status, ...(account ? { account } : {}) }
  const reservations = account ? createSessionReservations(account) : undefined
  const newMessageId = createMessageIds()
  return {
    list: (options) => listSessions(context, options),
    markSeen: (ref, completedAt) => sendReaderWrite(context, ref, { kind: "seen", completedAt }),
    settle: (ref, write) => sendReaderWrite(context, ref, { kind: "settle", ...write }),
    read: (ref, shape, held) => startSessionReads(context, ref, shape, held),
    page: (ref, shape, before) => readTurnPageBefore(context, ref, shape, before),
    part: (ref, messageId, partId) => readPart(context, ref, messageId, partId),
    turn: (ref, turnId) => readTurn(context, ref, turnId),
    create: async (input) => {
      const row = await createSession(context, wakes, reservations, input)
      void projection.created(row.ref)
      telemetry.record({ event: "session_started", properties: { harness: productHarness(input.harness), where: productWhere(workspaces.byId(input.placementId)?.kind) } })
      return row
    },
    prompt: (ref, input) => postPrompt(context, wakes, ref, input, input.messageId ?? newMessageId()),
    stop: async (ref) => cancelRunningTurn(transport, await workspaces.route(ref), ref),
    stopBackgroundTask: async (ref, toolCallId) => stopBackgroundTask(transport, await workspaces.route(ref), ref, toolCallId),
    reply: (ref, id, answer) => replyToRequest(context, ref, id, answer),
    rename: (ref, title) => patchSession(context, ref, { title }),
    newMessageId,
    ...createSessionQueue(context),
    controlGoal: async (ref, action) => controlGoal(transport, await workspaces.route(ref), ref, action),
  }
}
