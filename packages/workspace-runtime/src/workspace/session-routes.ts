import { storeSessionRoutes, type SessionCore } from "@claxedo/session-core"
import { deriveChildSessionId } from "../host/child-identity"
import { readSessionAttachment } from "../host/attachment-files"
import { flushRuntimeSessionDocuments, disposeRuntimeSessionDocuments } from "../routes/document-hydration"
import { DEFAULT_RECOVERY_BUDGETS, type SubagentObservation } from "@claxedo/agent-runtime-contract"
import type { AgentSessionStarts, SubagentUpdatedEvent } from "@claxedo/agent-runtime-contract"
import { HTTPException } from "hono/http-exception"
import type { AgentRuntime, AgentRuntimeRecovery } from "@claxedo/session-core"
import type { SessionAccessPolicy } from "@claxedo/session-core"
import type { RuntimeStore } from "@claxedo/session-core"
import type { WorkspaceCheckpoint } from "./checkpoint"
import type { WorkspaceTranscriptRoutesOptions } from "./core"
import type { RuntimeRunner } from "./snapshot"

export type SessionRoutesMountInput = {
  core: SessionCore
  runtime: () => Promise<AgentRuntime>
  /** The recovery owner already built, without building one: recovery answers while the host is closing. */
  recovery: () => AgentRuntimeRecovery | undefined
  store: () => RuntimeStore
  sessionStarts: AgentSessionStarts
  sessionAccessPolicy: SessionAccessPolicy
  checkpoint: WorkspaceCheckpoint
  currentRunner: () => RuntimeRunner
  transcripts?: WorkspaceTranscriptRoutesOptions
  afterCreateSession?: (input: { directory: string; session: unknown }) => Promise<void> | void
  sessionToolPrompt: (sessionId: string) => string | undefined
  subagentAdmission: (parentSessionId: string, observation: SubagentObservation) => Promise<SubagentUpdatedEvent>
}

/** The session routes of one workspace host, reading the store and driving the runtime host. */
export function mountSessionRoutes(input: SessionRoutesMountInput) {
  const { store, checkpoint } = input
  return input.core.sessionRoutes(input.runtime, {
    ...storeSessionRoutes({
      store,
      subagentAdmission: input.subagentAdmission,
      deriveChildSessionId: (identity) => deriveChildSessionId(store().runtimeSecret("child-session"), identity),
    }),
    flushSessionDocuments: flushRuntimeSessionDocuments,
    disposeSessionDocuments: disposeRuntimeSessionDocuments,
    readAttachment: readSessionAttachment,
    sessionAccessPolicy: input.sessionAccessPolicy,
    sessionStarts: input.sessionStarts,
    requestedSessionHarness: (requested) => requested ?? input.currentRunner(),
    resolveRecoveryOwner: () => input.recovery(),
    createActiveTurnScope: ({ directory, sessionId }) => checkpoint.createActiveTurnScope({ directory, sessionId }),
    transformPromptBody: ({ sessionId, body }) => {
      const prompt = input.sessionToolPrompt(sessionId)
      if (!prompt) return body
      return { ...body, parts: [...(body.parts ?? []), { type: "text", text: prompt }] }
    },
    afterCreateSession: input.afterCreateSession,
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
  })
}
