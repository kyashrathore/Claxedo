import { randomUUID } from "node:crypto"
import { createAgentEventRuntime } from "@claxedo/agent-event-runtime"
import { createAcpEventTranslator } from "@claxedo/agent-event-runtime/harnesses/acp"
import { createSubagentAdmissionBoundary } from "../../subagent-admission"
import { createSubagentChildren, type SubagentChild } from "../shared/subagent-lifecycle"
import { createChildEventRouter } from "../shared/child-event-routing"
import { createTurnEventProjector } from "../shared/turn-projection"
import type { RuntimeEventEnvelopeInput } from "../../runtime-event-hub"
import type { AgentRuntimeStoreWithRecovery } from "../shared/runtime-store"
import type { PromptInput } from "../../index"
import type { CompatEvent } from "../../compat-events"
import { acpSubagentUpdate, type ACPSubagentNotification } from "./subagents"

/** Agent-issued child identities enter the same admission and presentation
 * routes as native harness children. No tool-name or content inference. */
export function createACPSubagentRuntime(host: {
  sessionId: string
  agentSessionId: () => string
  harness: string
  directory: string
  input: PromptInput
  store: AgentRuntimeStoreWithRecovery
  bindSession: AgentRuntimeStoreWithRecovery["bindSession"]
  publish: (event: CompatEvent) => void
  publishRuntime?: (event: RuntimeEventEnvelopeInput) => void
}) {
  // Child executions can outlive the parent prompt. Their projectors are owned
  // by the connection/session, independent of a completed parent's write fence.
  const parent = createTurnEventProjector({ store: host.store, owner: { sessionId: host.sessionId, getAgentSessionId: host.agentSessionId },
    directory: host.directory, input: host.input, assistantMessageId: host.input.assistantMessageId, created: Date.now(),
    onEvent: host.publish, onRuntimeEvent: host.publishRuntime })
  const router = createChildEventRouter({ parent,
    createChildProjector: (target) => createTurnEventProjector({ store: host.store,
      owner: { sessionId: target.sessionId, getAgentSessionId: target.getAgentSessionId }, directory: host.directory,
      input: target.input, assistantMessageId: target.assistantMessageId, created: target.created,
      onEvent: host.publish, onRuntimeEvent: host.publishRuntime }),
    onDiagnostic: (event) => parent.project(event, { dir: "in", method: "acp.child-routing" }),
  })
  const generation = randomUUID()
  const open = new Map<string, { parentId: string; subagentKey: string }>()
  let replaying = false
  const replayed = new Set<string>()
  const settledReplay = new Set<string>()
  const children = new Map<string, SubagentChild>()
  const byAgent = new Map<string, SubagentChild>()
  const runtimes = new Map<string, ReturnType<typeof createAgentEventRuntime>>()
  const parents = new Map<string, ReturnType<typeof createSubagentChildren>>()
  const lifecycle = (parentSessionId: string) => {
    let value = parents.get(parentSessionId)
    if (!value) {
      value = createSubagentChildren({ parentSessionId, directory: host.directory, input: host.input, fenced: {},
        store: host.store, children, bindSession: host.bindSession, projectChild: router.projectChild, publish: host.publish })
      parents.set(parentSessionId, value)
    }
    return value
  }
  return {
    setReplaying(value: boolean) { replaying = value },
    async disconnect() {
      for (const [agentSessionId, row] of open) {
        if (!host.store.admit || !host.store.markPublished) continue
        const observation = { observationId: `acp:disconnect:${generation}:${agentSessionId}`, subagentKey: row.subagentKey, status: "interrupted" as const }
        const source = { dir: "in" as const, method: "acp.connection.closed" }
        await createSubagentAdmissionBoundary({
          store: { admit: (input) => host.store.admit!(input), markPublished: (id, observation) => host.store.markPublished!(id, observation) },
          publish: (_, event) => router.project(event, source, row.parentId === host.sessionId ? { kind: "parent" } : { kind: "child", correlationKey: host.store.getAgentSessionId(row.parentId) ?? undefined }),
        }).admit(row.parentId, observation)
        const child = byAgent.get(agentSessionId)
        if (child) lifecycle(row.parentId).settle(child, observation, source)
      }
      open.clear()
      router.dispose()
    },
    async receive(notification: ACPSubagentNotification) {
      const source = { dir: "in" as const, method: "session/update", frame: notification }
      const isRoot = notification.sessionId === host.agentSessionId()
      const parent = byAgent.get(notification.sessionId)
      const localSessionId = isRoot ? host.sessionId : parent?.sessionId
      if (!localSessionId) throw new Error(`ACP child output preceded its authoritative spawn: ${notification.sessionId}`)
      const observed = acpSubagentUpdate(notification.update)
      if (observed) {
        if (!host.store.admit || !host.store.markPublished) throw new Error("ACP child sessions require durable subagent admission")
        if (!observed.capabilities && !byAgent.has(observed.agentSessionId)) throw new Error(`ACP child completion preceded its authoritative spawn: ${observed.agentSessionId}`)
        const event = await createSubagentAdmissionBoundary({
          store: { admit: (input) => host.store.admit!(input), markPublished: (id, observation) => host.store.markPublished!(id, observation) },
          publish: (_, event) => router.project(event, source, isRoot ? { kind: "parent" } : { kind: "child", correlationKey: notification.sessionId }),
        }).admit(localSessionId, observed.observation, { allocateChildSessionId: () => randomUUID() })
        if (!event.childSessionId) throw new Error("ACP child admission did not allocate a transcript session")
        // Agent history replay reuses the canonical persisted child assistant turn.
        if (replaying && !byAgent.has(observed.agentSessionId)) {
          const previous = host.store.getMessages(event.childSessionId).findLast((message) => message.info.role === "assistant")
          if (previous) {
            const child: SubagentChild = { sessionId: event.childSessionId, agentSessionId: observed.agentSessionId,
              target: { sessionId: event.childSessionId, getAgentSessionId: () => observed.agentSessionId,
                assistantMessageId: previous.info.id, created: previous.info.time?.created ?? Date.now(), input: host.input } }
            children.set(observed.agentSessionId, child)
            byAgent.set(observed.agentSessionId, child)
            replayed.add(observed.agentSessionId)
            if (previous.info.time?.completed !== undefined) settledReplay.add(observed.agentSessionId)
          }
        }
        const owner = lifecycle(localSessionId)
        const { child } = owner.child({ observation: observed.observation, subagentKey: event.subagentKey, childSessionId: event.childSessionId, source })
        byAgent.set(observed.agentSessionId, child)
        router.associate(observed.agentSessionId, child.target)
        if (observed.observation.status === "running") open.set(observed.agentSessionId, { parentId: localSessionId, subagentKey: event.subagentKey })
        else open.delete(observed.agentSessionId)
        owner.track(observed.observation, event)
        if (!(replaying && settledReplay.has(observed.agentSessionId))) owner.settle(child, observed.observation, source)
        return
      }
      if (replaying && replayed.has(notification.sessionId)) return
      let runtime = runtimes.get(notification.sessionId)
      if (!runtime) {
        runtime = createAgentEventRuntime({ harness: host.harness, threadId: notification.sessionId, adapter: createAcpEventTranslator({ client: host.harness }) })
        runtimes.set(notification.sessionId, runtime)
      }
      for (const event of runtime.ingest({ source: "acp.jsonrpc", method: "session/update", payload: notification.update }).events) {
        router.project(event, source, { kind: "child", correlationKey: notification.sessionId })
      }
    },
  }
}
