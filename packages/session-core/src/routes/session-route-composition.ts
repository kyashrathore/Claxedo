import { HTTPException } from "hono/http-exception"
import { DEFAULT_RECOVERY_BUDGETS, type AgentSessionStarts, type BackgroundWork, type SessionHarness, type SubagentObservation, type SubagentUpdatedEvent } from "@claxedo/agent-runtime-contract"
import type { SessionCore } from "../core"
import type { AgentRuntime, AgentRuntimeRecovery } from "../host/runtime"
import type { SessionAccessPolicy } from "../session-access-policy"
import type { RuntimeStore } from "../store"
import type { ChildSessionHost } from "./session-children"
import type { SessionRoutesOptions } from "./session"
import { storeSessionRoutes } from "./session-store-reads"

export type SessionRouteCheckpoint<Turn> = {
  createActiveTurnScope: NonNullable<SessionRoutesOptions["createActiveTurnScope"]>
  turnsOf(sessionId: string): readonly Turn[]
  cancelActiveTurn(turn: Turn, deadlineAt: number): Promise<{ drained: boolean; reason?: string }>
}

export type SessionRouteMachine<Turn> = {
  checkpoint: SessionRouteCheckpoint<Turn>
  readAttachment: NonNullable<SessionRoutesOptions["readAttachment"]>
  flushSessionDocuments: NonNullable<SessionRoutesOptions["flushSessionDocuments"]>
  disposeSessionDocuments: NonNullable<SessionRoutesOptions["disposeSessionDocuments"]>
  sessionToolPrompt(sessionId: string): string | undefined
  afterCreateSession?: SessionRoutesOptions["afterCreateSession"]
}

export type SessionRouteCompositionInput<Turn = unknown> = {
  core: SessionCore
  runtime: () => Promise<AgentRuntime>
  /** The recovery owner already built, without building one: recovery answers while the host is closing. */
  recovery: () => AgentRuntimeRecovery | undefined
  store: () => RuntimeStore
  sessionStarts: AgentSessionStarts
  sessionAccessPolicy: SessionAccessPolicy
  currentRunner: () => SessionHarness
  deriveChildSessionId: ChildSessionHost["deriveSessionId"]
  subagentAdmission: (parentSessionId: string, observation: SubagentObservation) => Promise<SubagentUpdatedEvent>
  backgroundWork: (sessionId: string) => BackgroundWork | undefined
  machine?: SessionRouteMachine<Turn>
}

/** The session routes of one host, reading its store and driving its runtime. */
export function composeSessionRoutes<Turn>(input: SessionRouteCompositionInput<Turn>) {
  return input.core.sessionRoutes(input.runtime, {
    ...storeSessionRoutes({
      store: input.store,
      subagentAdmission: input.subagentAdmission,
      deriveChildSessionId: input.deriveChildSessionId,
      backgroundWork: input.backgroundWork,
    }),
    sessionAccessPolicy: input.sessionAccessPolicy,
    sessionStarts: input.sessionStarts,
    requestedSessionHarness: (requested) => requested ?? input.currentRunner(),
    resolveRecoveryOwner: () => input.recovery(),
    ...(input.machine ? machineRouteOptions(input.machine) : {}),
  })
}

function machineRouteOptions<Turn>(machine: SessionRouteMachine<Turn>) {
  const { checkpoint } = machine
  return {
    flushSessionDocuments: machine.flushSessionDocuments,
    disposeSessionDocuments: machine.disposeSessionDocuments,
    readAttachment: machine.readAttachment,
    createActiveTurnScope: (scope) => checkpoint.createActiveTurnScope(scope),
    transformPromptBody: ({ sessionId, body }) => {
      const prompt = machine.sessionToolPrompt(sessionId)
      if (!prompt) return body
      return { ...body, parts: [...(body.parts ?? []), { type: "text", text: prompt }] }
    },
    afterCreateSession: machine.afterCreateSession,
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
  } satisfies Partial<SessionRoutesOptions>
}
