import type { SessionHandoff } from "@claxedo/agent-runtime-contract"
import type { TurnAuthority } from "@claxedo/harness/broker"
import type { HarnessBinding } from "@claxedo/harness/contract"
import type { RuntimeStore } from "../store"

export class BrokerAuthority {
  constructor(private readonly store: RuntimeStore, private readonly ownerGeneration: string) {}

  currentTurnAuthority(sessionId: string): TurnAuthority | undefined {
    const binding = this.store.getExecutionBinding(sessionId)
    if (!binding || !this.store.readTurnAuthority(sessionId)) return undefined
    const row = this.store.database().prepare<{ assistant_message_id: string }>(`
      SELECT start.assistant_message_id
      FROM runtime_journal start
      WHERE start.session_id = ? AND start.kind = 'control' AND start.type = 'turn.start'
        AND NOT EXISTS (
          SELECT 1 FROM runtime_journal finish
          WHERE finish.session_id = start.session_id AND finish.kind = 'control'
            AND finish.type = 'turn.finish' AND finish.assistant_message_id = start.assistant_message_id
        )
      ORDER BY start.seq DESC LIMIT 1
    `).get(sessionId)
    return row ? { ...binding, ownerGeneration: this.ownerGeneration, turnId: row.assistant_message_id } : undefined
  }

  readStart(sessionId: string) {
    return this.store.sessionStarts.get(sessionId)
  }

  async rebind(sessionId: string, upstreamSessionId: string): Promise<HarnessBinding> {
    const binding = this.store.getExecutionBinding(sessionId)
    if (!binding) throw new Error(`Session ${sessionId} has no execution binding`)
    this.store.bindSession({
      sessionId, workspaceId: binding.workspaceId, directory: binding.directory,
      connectionId: binding.connectionId, upstreamSessionId, agentSessionId: upstreamSessionId,
    })
    const committed = this.store.getExecutionBinding(sessionId)
    if (!committed) throw new Error(`Session ${sessionId} lost its execution binding`)
    return committed
  }

  async persistHandoff(sessionId: string, context: SessionHandoff): Promise<void> {
    if (!this.store.getSession(sessionId)) throw new Error(`Session ${sessionId} does not exist`)
    this.store.updateSessionConfig(sessionId, { handoff: context })
  }
}
