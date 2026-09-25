import { randomUUID } from "node:crypto"
import { UnknownHostSubagentKeyError, type SubagentObservation } from "@claxedo/agent-runtime-contract"
import type { ChildSessionRef } from "../../contract/broker"
import type { BrokerPorts } from "../ports"

export class SubagentBroker {
  constructor(private readonly ports: BrokerPorts) {}

  associate(sessionId: string, correlationKey: string, child: ChildSessionRef): void {
    if (!this.ports.subagentAdmissionStore.hasChild(sessionId, child.sessionId)) {
      const admitted = this.ports.subagentAdmissionStore.admit({
        parentSessionId: sessionId,
        observation: { observationId: `host-association:${correlationKey}`,
          subagentKey: correlationKey, providerKind: "claxedo", childSessionId: child.sessionId },
        allocateKey: () => correlationKey,
        child,
      })
      this.ports.subagentAdmissionStore.markPublished(sessionId, admitted.observationId)
    }
    this.ports.bindChildCorrelation(sessionId, correlationKey, child.sessionId)
  }

  async observe(sessionId: string, observation: SubagentObservation): Promise<ChildSessionRef | undefined> {
    let event
    try {
      const transcript = observation.transcript?.kind
      const openable = transcript === "live" || transcript === "messages" || transcript === "file"
      const admitted = this.ports.subagentAdmissionStore.admit({
        parentSessionId: sessionId,
        observation,
        allocateKey: () => `subagent_${randomUUID()}`,
        ...(openable ? { allocateChildSessionId: () => randomUUID() } : {}),
      })
      event = admitted.event
      if (!admitted.published) {
        await this.ports.publishSubagent(sessionId, event)
        this.ports.subagentAdmissionStore.markPublished(sessionId, observation.observationId)
      }
    } catch (error) {
      if (!(error instanceof UnknownHostSubagentKeyError)) throw error
      await this.ports.publishSubagentDiagnostic(sessionId, {
        code: "subagent-binding-unknown",
        message: error.message,
        severity: "warn",
        source: "subagent-admission",
        details: {
          observationId: observation.observationId,
          ...(observation.subagentKey ? { subagentKey: observation.subagentKey } : {}),
          ...(observation.toolCallId ? { toolCallId: observation.toolCallId } : {}),
        },
      })
      return undefined
    }
    if (!event.childSessionId) return undefined
    return this.ports.admitChildSession(sessionId, event.childSessionId, observation)
  }
}
