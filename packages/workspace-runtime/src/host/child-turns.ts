import { randomUUID } from "node:crypto"
import { isTerminalSubagentStatus, type PromptInput, type SubagentObservation } from "@claxedo/agent-runtime-contract"
import type { SubagentUpdatedEvent, AgentPresentationEvent } from "@claxedo/agent-runtime-contract"
import type { BrokerPorts } from "@claxedo/harness/broker"
import type { ChildSessionRef } from "@claxedo/harness/contract"
import type { ChildProjectionTarget } from "../projection/child-event-routing"
import type { RuntimeAppendSource } from "../projection/turn-projection"
import type { AgentRuntimeStore } from "./contracts"
import { AgentRuntimeStaleTurnError } from "../store"
import type { LeasedTurnFailure } from "../broker-ports"

type ChildLifecycleEvent =
  | { type: "session-status"; status: "busy" }
  | { type: "finish"; sessionId: string }
  | { type: "error"; error: string }

/** What a parent's running turn, prompted or provider-initiated, lends its children: the prompt they inherit and where their lifecycle projects. */
export type ParentTurnContext = {
  directory: string
  input: Pick<PromptInput, "agent" | "model" | "variant">
  fencingToken?: number
  projectChild: (target: ChildProjectionTarget, event: ChildLifecycleEvent, source: RuntimeAppendSource) => void
}

type SeededChild = {
  parent: ParentTurnContext
  mode: SubagentObservation["mode"]
  target: ChildProjectionTarget
  leaseId: string
  fencingToken?: number
  settled: boolean
}

const SOURCE: RuntimeAppendSource = { dir: "in", method: "subagent" }

export class TurnAuthorityUnavailableError extends Error {
  readonly code = "turn_authority_unavailable"
  constructor(readonly sessionId: string) {
    super(`A child turn cannot be projected for session ${sessionId}: another owner holds its turn lease`)
    this.name = "TurnAuthorityUnavailableError"
  }
}

function childOutcome(event: Pick<SubagentUpdatedEvent, "status" | "label">) {
  const completedAt = Date.now()
  if (event.status === "failed") return { status: "failed" as const, completedAt, error: event.label ?? "Subagent failed" }
  if (event.status === "completed") return { status: "completed" as const, completedAt }
  return { status: "cancelled" as const, completedAt, reason: event.status ?? "interrupted" }
}

/**
 * The child sessions a host turn's subagents own. A child has no prompt
 * response of its own, so its turn exists only because the host seeds it when
 * the broker admits the child and ends it when the terminal observation
 * arrives; both steps project through the same router its routed events use,
 * so a reader watching the child sees it start, work and stop.
 */
export function createChildTurns(input: {
  store: AgentRuntimeStore
  publish: (parentSessionId: string, event: AgentPresentationEvent) => void
  /** Retains a child terminal the store refused under the child's lease; `false` when nothing could, and the lease is released. */
  retainLeasedTurnFailure: (sessionId: string, turn: LeasedTurnFailure, error: unknown) => boolean
}) {
  const parents = new Map<string, ParentTurnContext>()
  const children = new Map<string, SeededChild>()

  const seed = (parentSessionId: string, ref: ChildSessionRef, observation: SubagentObservation, parent: ParentTurnContext): SeededChild => {
    const agentSessionId = input.store.getAgentSessionId(ref.sessionId) ?? ref.sessionId
    const target: ChildProjectionTarget = {
      sessionId: ref.sessionId,
      getAgentSessionId: () => input.store.getAgentSessionId(ref.sessionId) ?? agentSessionId,
      assistantMessageId: ref.assistantMessageId,
      created: ref.created,
      input: { userMessageId: randomUUID(), agent: parent.input.agent, model: parent.input.model,
        ...(parent.input.variant ? { variant: parent.input.variant } : {}) },
      ...(parent.fencingToken === undefined ? {} : { fencingToken: parent.fencingToken }),
    }
    const leaseId = input.store.acquireTurnLease(ref.sessionId)
    if (!leaseId) throw new TurnAuthorityUnavailableError(ref.sessionId)
    try {
      const parentConfig = input.store.getSessionConfig(parentSessionId)
      if (parentConfig) input.store.updateSessionConfig(ref.sessionId, parentConfig)
      const started = input.store.startTurn({
        sessionId: ref.sessionId,
        agentSessionId,
        userMessageId: target.input.userMessageId,
        assistantMessageId: ref.assistantMessageId,
        agent: target.input.agent,
        model: target.input.model,
        parts: observation.description ? [{ type: "text", text: observation.description }] : [],
        ...(target.input.variant ? { variant: target.input.variant } : {}),
        ...(parent.fencingToken === undefined ? {} : { fencingToken: parent.fencingToken }),
      })
      for (const event of started.events) input.publish(ref.sessionId, event)
    } catch (failure) {
      input.store.releaseTurnLease(ref.sessionId, leaseId)
      throw failure
    }
    parent.projectChild(target, { type: "session-status", status: "busy" }, SOURCE)
    const seeded: SeededChild = { target, leaseId, settled: false, parent, mode: observation.mode,
      ...(parent.fencingToken === undefined ? {} : { fencingToken: parent.fencingToken }) }
    children.set(ref.sessionId, seeded)
    return seeded
  }

  const settle = (child: SeededChild, event: Pick<SubagentUpdatedEvent, "status" | "label">, parent: ParentTurnContext | undefined) => {
    if (child.settled) return
    child.settled = true
    const outcome = childOutcome(event)
    let finished
    try {
      finished = input.store.finishTurn({
        sessionId: child.target.sessionId, assistantMessageId: child.target.assistantMessageId, outcome, leaseId: child.leaseId,
        ...(child.fencingToken === undefined ? {} : { fencingToken: child.fencingToken }),
      })
    } catch (error) {
      const retained = !(error instanceof AgentRuntimeStaleTurnError) && input.retainLeasedTurnFailure(child.target.sessionId,
        { leaseId: child.leaseId, assistantMessageId: child.target.assistantMessageId, outcome }, error)
      if (!retained) input.store.releaseTurnLease(child.target.sessionId, child.leaseId)
      throw error
    }
    try {
      parent?.projectChild(child.target,
        outcome.status === "failed" ? { type: "error", error: outcome.error } : { type: "finish", sessionId: child.target.sessionId },
        SOURCE)
      for (const payload of finished.events) input.publish(child.target.sessionId, payload)
    } finally {
      input.store.releaseTurnLease(child.target.sessionId, child.leaseId)
    }
  }

  return {
    /** The projection target of the child turn this host seeded, when the route names that turn. */
    target(childSessionId: string, assistantMessageId: string): ChildProjectionTarget | undefined {
      const child = children.get(childSessionId)
      return child?.target.assistantMessageId === assistantMessageId ? child.target : undefined
    },
    beginTurn(parentSessionId: string, context: ParentTurnContext) {
      parents.set(parentSessionId, context)
      return () => {
        if (parents.get(parentSessionId) !== context) return
        parents.delete(parentSessionId)
        const failures: unknown[] = []
        for (const child of children.values()) {
          if (child.parent !== context || child.mode === "background" || child.settled) continue
          try { settle(child, { status: "interrupted" }, context) } catch (error) { failures.push(error) }
        }
        if (failures.length) throw new AggregateError(failures, "Foreground child settlement failed")
      }
    },
    /** The ports every broker call reaches, with the child lifecycle a host turn owes layered over the store's persistence. */
    ports(base: BrokerPorts): BrokerPorts {
      return {
        ...base,
        admitChildSession: async (parentSessionId, childSessionId, observation) => {
          const ref = await base.admitChildSession(parentSessionId, childSessionId, observation)
          const parent = parents.get(parentSessionId)
          const known = children.get(childSessionId)
          if (parent && (!known || known.settled && ref.assistantMessageId !== known.target.assistantMessageId)) seed(parentSessionId, ref, observation, parent)
          return ref
        },
        publishSubagent: async (parentSessionId, event) => {
          await base.publishSubagent(parentSessionId, event)
          const child = event.childSessionId ? children.get(event.childSessionId) : undefined
          if (child && isTerminalSubagentStatus(event.status)) settle(child, event, parents.get(parentSessionId))
        },
      }
    },
  }
}
