import { DEFAULT_RECOVERY_BUDGETS, type SubagentObservation } from "@claxedo/agent-runtime-contract"
import type { AgentSessionStarts, SubagentUpdatedEvent } from "@claxedo/agent-runtime-contract"
import { HTTPException } from "hono/http-exception"
import type { AgentRuntime, AgentRuntimeRecovery } from "../host/runtime"
import type { RuntimeEventHub } from "../projection/runtime-event-hub"
import { SessionRoutes } from "../routes/session"
import { sessionStatusSnapshot } from "../routes/session-status-snapshot"
import type { SessionAccessPolicy } from "../session-access-policy"
import type { SessionDeliveryStore } from "../session/delivery-owner"
import type { RuntimeStore } from "../store"
import { workspaceId } from "../target"
import type { WorkspaceCheckpoint } from "./checkpoint"
import type { WorkspaceTranscriptRoutesOptions } from "./core"
import type { RuntimeRunner } from "./snapshot"

export type SessionRoutesMountInput = {
  runtime: () => Promise<AgentRuntime>
  /** The recovery owner already built, without building one: recovery answers while the host is closing. */
  recovery: () => AgentRuntimeRecovery | undefined
  store: () => RuntimeStore
  sessionStarts: AgentSessionStarts
  eventHub: RuntimeEventHub
  sessionAccessPolicy: SessionAccessPolicy
  checkpoint: WorkspaceCheckpoint
  currentRunner: () => RuntimeRunner
  transcripts?: WorkspaceTranscriptRoutesOptions
  afterCreateSession?: (input: { directory: string; session: unknown }) => Promise<void> | void
  sessionIdWorkspace?: (sessionId: string) => Promise<string | undefined> | string | undefined
  sessionToolPrompt: (sessionId: string) => string | undefined
  subagentAdmission: (parentSessionId: string, observation: SubagentObservation) => Promise<SubagentUpdatedEvent>
}

export function queuedPromptStore(store: RuntimeStore): SessionDeliveryStore {
  return {
    queuePrompt: (input) => store.deliveryQueue.queuePrompt(input),
    deleteQueuedPrompt: (sessionId, seq) => store.deliveryQueue.deleteQueuedPrompt(sessionId, seq),
    replaceQueuedPromptParts: (sessionId, seq, parts) => store.deliveryQueue.replaceQueuedPromptParts(sessionId, seq, parts),
    listQueuedPrompts: () => store.deliveryQueue.listQueuedPrompts(),
    claimQueuedPromptDelivery: (sessionId, seq, operationId, mode) => store.deliveryQueue.claimQueuedPromptDelivery(sessionId, seq, operationId, mode),
    setQueuedPromptHeld: (sessionId, seq, value) => store.deliveryQueue.setQueuedPromptHeld(sessionId, seq, value),
    completeQueuedPrompt: (sessionId, seq, operationId) => store.deliveryQueue.completeQueuedPrompt(sessionId, seq, operationId),
    retireSteeredPrompt: (sessionId, messageId) => store.deliveryQueue.retireSteeredPrompt(sessionId, messageId),
    settleQueuedPromptDelivery: (sessionId, seq, steering) => store.deliveryQueue.settleQueuedPromptDelivery(sessionId, seq, steering),
    sessionDirectory: (sessionId) => store.getSession(sessionId)?.directory,
    sessionArchived: (sessionId) => store.getSession(sessionId)?.time?.archived !== undefined,
    messageSessionId: (messageId) => store.messageSessionId(messageId),
  }
}

/** The session routes of one workspace host, reading the store and driving the runtime host. */
export function mountSessionRoutes(input: SessionRoutesMountInput) {
  const { store, checkpoint } = input
  return SessionRoutes(input.runtime, {
    eventHub: input.eventHub,
    sessionAccessPolicy: input.sessionAccessPolicy,
    sessionStarts: input.sessionStarts,
    requestedSessionHarness: (requested) => requested ?? input.currentRunner(),
    resolveRecoveryOwner: () => input.recovery(),
    listSessions: async (_c, directory) => store().listSessions(directory),
    getStatus: (_c, directory) => sessionStatusSnapshot(store().listSessions(directory)),
    listSubagents: ({ parentSessionId }) => store().listSubagents(parentSessionId),
    childSessions: {
      admit: input.subagentAdmission,
      secret: () => store().runtimeSecret("child-session"),
      pendingWakes: () => store().listPendingSubagentWakes(),
      origins: {
        record: (parentSessionId, subagentKey, origin) => store().recordSubagentOrigin(parentSessionId, subagentKey, origin),
        read: (parentSessionId, subagentKey) => store().subagentOrigin(parentSessionId, subagentKey),
      },
    },
    queuedPrompts: () => queuedPromptStore(store()),
    createActiveTurnScope: ({ directory, sessionId }) => checkpoint.createActiveTurnScope({ directory, sessionId }),
    transformPromptBody: ({ sessionId, body }) => {
      const prompt = input.sessionToolPrompt(sessionId)
      if (!prompt) return body
      return { ...body, parts: [...(body.parts ?? []), { type: "text", text: prompt }] }
    },
    getMessages: async ({ sessionId }) => {
      if (!store().getSession(sessionId)) throw new HTTPException(404, { message: "Session not found" })
      return store().getMessages(sessionId)
    },
    getMessagePage: async ({ sessionId, page }) => {
      const runtimeStore = store()
      if (!runtimeStore.getSession(sessionId)) throw new HTTPException(404, { message: "Session not found" })
      return { ...runtimeStore.getMessagePage(sessionId, page) ?? { messages: [] }, maxEventOrdinal: runtimeStore.getSessionMaxSeq(sessionId) }
    },
    getPart: async ({ sessionId, messageId, partId }) => {
      const runtimeStore = store()
      if (!runtimeStore.getSession(sessionId)) throw new HTTPException(404, { message: "Session not found" })
      return runtimeStore.getPart(sessionId, messageId, partId)
    },
    getTurnOutline: async ({ sessionId }) => store().turnOutline(sessionId),
    turnCoverage: async ({ sessionId, turnId }) => {
      const runtimeStore = store()
      if (!runtimeStore.getSession(sessionId)) throw new HTTPException(404, { message: "Session not found" })
      return runtimeStore.turnCoverage(sessionId, turnId)
    },
    getMessageSnapshot: async ({ sessionId }) => {
      if (!store().getSession(sessionId)) throw new HTTPException(404, { message: "Session not found" })
      const messages = store().getMessages(sessionId)
      const fencingToken = store().getSessionFencingToken(sessionId) ?? 0
      return { messages, maxEventOrdinal: store().getSessionMaxSeq(sessionId), ...(fencingToken === 0 ? {} : { fencingToken }) }
    },
    getSession: async ({ directory, sessionId }) => {
      const stored = store().getSession(sessionId)
      if (!stored) return null
      return (stored.directory ?? "") === (directory ?? "") ? stored : null
    },
    getTodos: async ({ sessionId }) => {
      if (!store().getSession(sessionId)) return undefined
      return store().getTodos(sessionId)
    },
    getSessionConfig: async ({ sessionId }) => {
      const config = store().getSessionConfig(sessionId)
      if (!config) throw new HTTPException(404, { message: "Session not found" })
      return config
    },
    afterCreateSession: input.afterCreateSession,
    sessionIdWorkspace: input.sessionIdWorkspace,
    afterUpdateSession: ({ sessionId, updates }) => {
      store().updateSession(sessionId, updates)
    },
    beforeDeleteSession: async ({ sessionId }) => {
      // Stop only this session's host readers while their execution binding
      // still exists. Deleting first can fence out the terminal frame that
      // those readers need to release their residency pins.
      const deadlineAt = Date.now() + DEFAULT_RECOVERY_BUDGETS.gracefulCancelMs
      const results = await Promise.all(checkpoint.turnsOf(sessionId).map((turn) => checkpoint.cancelActiveTurn(turn, deadlineAt)))
      const stuck = results.filter((result) => !result.drained)
      if (stuck.length > 0) {
        throw new HTTPException(409, { message: `Session ${sessionId} still has running work: ${stuck.map((result) => result.reason).join(", ")}` })
      }
    },
    afterDeleteSession: ({ sessionId }) => {
      input.transcripts?.resolver.invalidateParent?.(input.transcripts.workspaceId, sessionId)
    },
    resolveWorkspaceId: () => workspaceId(),
  })
}
