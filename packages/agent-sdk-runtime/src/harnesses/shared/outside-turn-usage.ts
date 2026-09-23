import type { AgentRuntimeEventOf } from "@claxedo/agent-event-runtime"
import { createClientPresentationProjection } from "@claxedo/agent-event-runtime/client-presentation"
import type { RuntimeEventHub } from "../../runtime-event-hub"
import type { AgentRuntimeStoreCore } from "./runtime-store"

export type OutsideTurnUsage = {
  sessionId: string
  directory: string
  /** The turn the usage is billed to, as its usage is keyed. */
  assistantMessageId: string
  usage: AgentRuntimeEventOf<"usage">
}

/**
 * Records usage no running turn projects — a harness's side request for a
 * session, a thread of it still spending after its turn ended — on the
 * session turn it belongs to, through the same projection and global
 * publication a turn's own usage takes.
 */
export function recordOutsideTurnUsage(
  host: { store: Pick<AgentRuntimeStoreCore, "appendEvent" | "getAgentSessionId">; eventHub?: RuntimeEventHub },
  input: OutsideTurnUsage,
) {
  const projection = createClientPresentationProjection({
    sessionId: input.sessionId,
    directory: input.directory,
    assistantMessageId: input.assistantMessageId,
  })
  const agentSessionId = host.store.getAgentSessionId(input.sessionId) ?? undefined
  for (const event of projection.ingest(input.usage)) {
    const committed = host.store.appendEvent({
      sessionId: input.sessionId,
      ...(agentSessionId ? { agentSessionId } : {}),
      payload: event.payload,
      source: { dir: "in", method: "usage.outside-turn" },
    }).payload
    host.eventHub?.publishGlobal({ directory: input.directory, payload: committed })
  }
}
