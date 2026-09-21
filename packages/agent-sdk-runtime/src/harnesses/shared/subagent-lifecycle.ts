import { randomUUID } from "node:crypto"
import type { SubagentMode, SubagentStatus, SubagentUpdatedEvent } from "@claxedo/agent-event-runtime"
import type { PromptInput } from "../../index"
import type { CompatEvent } from "../../compat-events"
import type { SubagentObservation } from "../../subagent-admission"
import type { ChildProjectionTarget } from "./child-event-routing"
import type { AgentRuntimeSessionBinding, AgentRuntimeStoreCore } from "./runtime-store"
import { scopedSubagentKey, subagentOutcome } from "./subagent-transcript"
import {
  finalizeAuthoredTurn,
  registerTurnAuthority,
  TurnAuthorityUnavailableError,
  type TurnAuthority,
} from "./turn-authority"
import type { RuntimeAppendSource } from "./turn-projection"

export type SubagentChild = {
  sessionId: string
  agentSessionId: string
  target: ChildProjectionTarget
  /**
   * Captured when the child's turn is seeded. Absent when the session's lease
   * was already held, which is what makes a late settle against a replacement
   * generation refusable rather than silently authoritative.
   */
  authority?: TurnAuthority
}

const UNSETTLED_SUBAGENT_STATUSES: ReadonlySet<string> = new Set(["pending", "running", "paused"])

/**
 * The child sessions a turn's subagents own: one seeded turn per child, the
 * execution binding it is later given, and its end. A child has no prompt
 * response of its own, so the store is the only place its turn exists unless
 * every step here also projects — through the same projector its routed events
 * use, so a reader watching the child sees it start, work and stop.
 */
export function createSubagentChildren(host: {
  parentSessionId: string
  directory: string
  input: Pick<PromptInput, "agent" | "model" | "variant">
  fenced: { fencingToken?: number }
  store: Pick<AgentRuntimeStoreCore, "startTurn" | "finishTurn" | "getSessionConfig" | "updateSessionConfig" | "acquireTurnLease" | "releaseTurnLease">
  children: Map<string, SubagentChild>
  bindSession: (input: AgentRuntimeSessionBinding) => void
  publish: (event: CompatEvent) => void
  projectChild: (target: ChildProjectionTarget, event: { type: "session-status"; status: "busy" } | { type: "finish"; sessionId: string }, source: RuntimeAppendSource) => void
}) {
  const open = new Map<string, { status?: SubagentStatus; mode?: SubagentMode }>()
  const title = (observation: SubagentObservation) =>
    observation.description ?? observation.label ?? "Subagent"

  const seed = (observation: SubagentObservation, childSessionId: string, childKey: string, source: RuntimeAppendSource) => {
    const agentSessionId = observation.providerId ?? `unbound:${childSessionId}`
    const target = {
      sessionId: childSessionId,
      getAgentSessionId: () => host.children.get(childKey)?.agentSessionId ?? agentSessionId,
      assistantMessageId: randomUUID(),
      created: Date.now(),
      input: {
        userMessageId: randomUUID(),
        agent: host.input.agent,
        model: host.input.model,
        ...(host.input.variant ? { variant: host.input.variant } : {}),
      },
    } satisfies ChildProjectionTarget
    host.bindSession({
      sessionId: childSessionId,
      parentSessionId: host.parentSessionId,
      directory: host.directory,
      title: title(observation),
      agentSessionId,
    })
    const authority = registerTurnAuthority(host.store, "provider_child", {
      sessionId: childSessionId,
      assistantMessageId: target.assistantMessageId,
      ...(host.fenced.fencingToken === undefined ? {} : { fencingToken: host.fenced.fencingToken }),
    })
    if (!authority) throw new TurnAuthorityUnavailableError("provider_child", childSessionId)
    const parentConfig = host.store.getSessionConfig(host.parentSessionId)
    if (parentConfig) host.store.updateSessionConfig(childSessionId, parentConfig)
    const started = host.store.startTurn({
      ...host.fenced,
      sessionId: childSessionId,
      agentSessionId,
      userMessageId: target.input.userMessageId,
      assistantMessageId: target.assistantMessageId,
      agent: target.input.agent,
      model: target.input.model,
      parts: observation.description ? [{ type: "text", text: observation.description }] : [],
      ...(target.input.variant ? { variant: target.input.variant } : {}),
    })
    for (const event of started.events) host.publish(event)
    host.projectChild(target, { type: "session-status", status: "busy" }, source)
    return { sessionId: childSessionId, agentSessionId, target, authority }
  }

  return {
    /**
     * Rows this turn is executing, for `settleOpen`. A claxedo child is the
     * host's own session: it outlives the turn that asked for it, so the turn
     * has no standing to end it.
     */
    track(observation: SubagentObservation, event: SubagentUpdatedEvent) {
      if (observation.providerKind === "claxedo") return
      open.set(event.subagentKey, {
        status: event.status ?? open.get(event.subagentKey)?.status,
        mode: event.mode ?? open.get(event.subagentKey)?.mode,
      })
    },

    child(input: {
      observation: SubagentObservation
      subagentKey: string
      childSessionId: string
      source: RuntimeAppendSource
    }) {
      const childKey = scopedSubagentKey(host.parentSessionId, input.subagentKey)
      const child = host.children.get(childKey)
        ?? [...host.children.values()].find((candidate) => candidate.sessionId === input.childSessionId)
        ?? seed(input.observation, input.childSessionId, childKey, input.source)
      if (input.observation.providerId && child.agentSessionId.startsWith("unbound:")) {
        child.agentSessionId = input.observation.providerId
        host.bindSession({
          sessionId: child.sessionId,
          parentSessionId: host.parentSessionId,
          directory: host.directory,
          title: title(input.observation),
          agentSessionId: child.agentSessionId,
        })
      }
      host.children.set(childKey, child)
      return { child, childKey }
    },

    /**
     * `finishTurn` commits terminal events only for a failed turn. Without the
     * projected `finish` the child's assistant message never closes and its
     * transcript reads "Thinking" for the life of the process.
     */
    settle(child: SubagentChild, observation: SubagentObservation, source: RuntimeAppendSource) {
      const outcome = subagentOutcome(observation)
      if (!outcome) return
      // A child this turn never seeded is one it never had authority over, so
      // its terminal belongs to whoever did.
      if (!child.authority) throw new TurnAuthorityUnavailableError("provider_child", child.sessionId)
      if (outcome.status !== "failed") {
        host.projectChild(child.target, { type: "finish", sessionId: child.sessionId }, source)
      }
      const finished = finalizeAuthoredTurn(host.store, child.authority, outcome)
      child.authority = undefined
      for (const event of finished.events) host.publish(event)
    },

    /**
     * A foreground subagent cannot outlive the turn that spawned it, so one
     * still open when the turn ends never reported its end: the provider
     * dropped the terminal, or the user aborted. Left alone the row reads
     * "working" and its child transcript stays busy for the life of the
     * process — the store settles orphans only when it is constructed. A
     * background subagent is excluded because continuing past the turn is what
     * it is for.
     */
    async settleOpen(observationPrefix: string, observe: (observation: SubagentObservation) => Promise<unknown>) {
      for (const [subagentKey, row] of open) {
        if (row.mode === "background") continue
        if (row.status && !UNSETTLED_SUBAGENT_STATUSES.has(row.status)) continue
        await observe({ observationId: `${observationPrefix}:${subagentKey}`, subagentKey, status: "interrupted" })
      }
    },
  }
}
