import { subagentIdentitySeed } from "./admission"
import { createKeyedSerializer, prefixedRandomId, sha256Hex } from "@claxedo/helpers"
import { UnknownHostSubagentKeyError, type SubagentObservation } from "@claxedo/agent-runtime-contract"
import type { SubagentUpdatedEvent } from "@claxedo/agent-runtime-contract"
import type { ChildSessionRef } from "../../contract/broker"
import type { BrokerPorts } from "../ports"

export class SubagentBroker {
  private readonly admissions = createKeyedSerializer<string>()
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

  admit(sessionId: string, observation: SubagentObservation): Promise<SubagentUpdatedEvent> {
    return this.admissions.run(sessionId, () => this.admitOrdered(sessionId, observation))
  }

  private async admitOrdered(sessionId: string, observation: SubagentObservation): Promise<SubagentUpdatedEvent> {
    const transcript = observation.transcript?.kind
    const openable = transcript === "live" || transcript === "messages" || transcript === "file"
    const seed = subagentIdentitySeed(sessionId, observation)
    const stableKey = seed ? `subagent_${(await sha256Hex(seed)).slice(0, 24)}` : undefined
    const admitted = this.ports.subagentAdmissionStore.admit({
      parentSessionId: sessionId,
      observation,
      allocateKey: () => stableKey ?? prefixedRandomId("subagent", "_"),
      ...(openable ? { allocateChildSessionId: () => crypto.randomUUID() } : {}),
    })
    if (!admitted.published) {
      await this.ports.publishSubagent(sessionId, admitted.event)
      this.ports.subagentAdmissionStore.markPublished(sessionId, observation.observationId)
    }
    return admitted.event
  }

  async observe(sessionId: string, observation: SubagentObservation): Promise<ChildSessionRef | undefined> {
    let event
    try {
      event = await this.admit(sessionId, observation)
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
