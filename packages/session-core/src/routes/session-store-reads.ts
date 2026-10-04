import type { BackgroundWork, SubagentObservation, SubagentUpdatedEvent } from "@claxedo/agent-runtime-contract"
import { HTTPException } from "hono/http-exception"
import type { SessionDeliveryStore } from "../session/delivery-owner"
import type { RuntimeStore } from "../store"
import type { ChildSessionHost } from "./session-children"
import type { SessionRoutesOptions } from "./session"
import { sessionStatusSnapshot } from "./session-status-snapshot"

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

export type StoreSessionRoutesInput = {
  store: () => RuntimeStore
  /** The host's harness admission for an observed subagent. */
  subagentAdmission: (parentSessionId: string, observation: SubagentObservation) => Promise<SubagentUpdatedEvent>
  /** The host's keyed child-session identity; a machine derives it with HMAC, a Durable Object with Web Crypto. */
  deriveChildSessionId: ChildSessionHost["deriveSessionId"]
  /** The work a session's turn left running in the background, which keeps its status busy. */
  backgroundWork: (sessionId: string) => BackgroundWork | undefined
}

/**
 * The session route options every host answers from its own store: listings,
 * transcripts, turn coverage, configuration, the durable prompt queue and the
 * child-session records. A host adds what only it can supply.
 */
export function storeSessionRoutes(input: StoreSessionRoutesInput) {
  const { store } = input
  return {
    listSessions: async (_c, directory) => store().listSessions(directory),
    getStatus: (_c, directory) => sessionStatusSnapshot(store().listSessions(directory), input.backgroundWork),
    listSubagents: ({ parentSessionId }) => store().listSubagents(parentSessionId),
    childSessions: {
      admit: input.subagentAdmission,
      deriveSessionId: input.deriveChildSessionId,
      pendingWakes: (parentSessionId) => store().listPendingSubagentWakes(parentSessionId),
      wakeParents: () => store().listSubagentWakeParents(),
      turnReply: (sessionId, turnId) => store().turnReply(sessionId, turnId),
      origins: {
        record: (parentSessionId, subagentKey, origin) => store().recordSubagentOrigin(parentSessionId, subagentKey, origin),
        read: (parentSessionId, subagentKey) => store().subagentOrigin(parentSessionId, subagentKey),
      },
    },
    queuedPrompts: () => queuedPromptStore(store()),
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
    afterUpdateSession: ({ sessionId, updates }) => {
      store().updateSession(sessionId, updates)
    },
  } satisfies Partial<SessionRoutesOptions>
}
