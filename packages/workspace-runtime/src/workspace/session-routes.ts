import {
  storeSessionRoutes,
  type SessionCore,
  type AgentRuntime,
  type AgentRuntimeRecovery,
  type SessionAccessPolicy,
  type RuntimeStore,
} from "@claxedo/session-core"
import { deriveChildSessionId } from "../host/child-identity"
import { readSessionAttachment } from "../host/attachment-files"
import { flushRuntimeSessionDocuments, disposeRuntimeSessionDocuments } from "../routes/document-hydration"
import { DEFAULT_RECOVERY_BUDGETS, type SubagentObservation } from "@claxedo/agent-runtime-contract"
import type { AgentSessionStarts, BackgroundWork, SubagentUpdatedEvent } from "@claxedo/agent-runtime-contract"
import { HTTPException } from "hono/http-exception"
import type { WorkspaceCheckpoint } from "./checkpoint"
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
  afterCreateSession?: (input: { directory: string; session: unknown }) => Promise<void> | void
  sessionToolPrompt: (sessionId: string) => string | undefined
  subagentAdmission: (parentSessionId: string, observation: SubagentObservation) => Promise<SubagentUpdatedEvent>
  backgroundWork: (sessionId: string) => BackgroundWork | undefined
}

/** The session routes of one workspace host, reading the store and driving the runtime host. */
export function mountSessionRoutes(input: SessionRoutesMountInput) {
  const { store, checkpoint } = input
  return input.core.sessionRoutes(input.runtime, {
    ...storeSessionRoutes({
      store,
      subagentAdmission: input.subagentAdmission,
      deriveChildSessionId: (identity) => deriveChildSessionId(store().runtimeSecret("child-session"), identity),
      backgroundWork: input.backgroundWork,
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
      // A delete runs only once the session's turn has released its admission,
      // but the host reader of that turn's stream ends after the release: it
      // still reads the transcript and drops its residency pin. It is drained
      // here while the execution binding exists, because deleting first fences
      // out the reads it needs to finish.
      const deadlineAt = Date.now() + DEFAULT_RECOVERY_BUDGETS.gracefulCancelMs
      const results = await Promise.all(checkpoint.turnsOf(sessionId).map((turn) => checkpoint.cancelActiveTurn(turn, deadlineAt)))
      const stuck = results.filter((result) => !result.drained)
      if (stuck.length > 0) {
        throw new HTTPException(409, { message: `Session ${sessionId} still has running work: ${stuck.map((result) => result.reason).join(", ")}` })
      }
    },
  })
}
