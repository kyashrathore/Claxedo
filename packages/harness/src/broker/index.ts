import type { RequestBroker, SessionBroker, TurnBroker } from "../contract/broker"
import { goalPort, admitProviderTurn } from "./goals"
import type { BrokerPorts, SessionBrokerContext, TurnBrokerContext } from "./ports"
import { RequestTable } from "./requests/table"
import { SubagentBroker } from "./subagents"

export type BrokerOwner = {
  ports: BrokerPorts
  requests: RequestTable
  subagents: SubagentBroker
  endTurn(authority: TurnBrokerContext["authority"]): Promise<void>
  endStart(context: SessionBrokerContext): Promise<void>
}

export function createRequestBroker(ports: BrokerPorts): BrokerOwner & { broker: RequestBroker } {
  const requests = new RequestTable(ports)
  return {
    ports, requests, subagents: new SubagentBroker(ports), broker: requests,
    endTurn: (authority) => requests.cancelTurn(authority),
    endStart: (context) => requests.cancelStart(context),
  }
}

export function createTurnBroker(owner: BrokerOwner, context: TurnBrokerContext): TurnBroker {
  return {
    signal: context.signal,
    origin: context.origin,
    ask: (request, options) => owner.requests.askTurn(context, request, options),
    completeElicitation: (elicitationId) => owner.requests.completeElicitation(context.authority.sessionId, context.authority.connectionId, elicitationId),
    observeSubagent: (observation) => owner.subagents.observe(context.authority.sessionId, observation),
    associateChild: (correlationKey, child) => owner.subagents.associate(context.authority.sessionId, correlationKey, child),
  }
}

export function createSessionBroker(owner: BrokerOwner, context: SessionBrokerContext): SessionBroker {
  const { ports } = owner
  if (context.start && (context.start.sessionId !== context.sessionId || context.start.directory !== context.directory ||
    context.start.workspaceId !== context.workspaceId || context.start.connectionId !== context.connectionId ||
    context.start.operationId !== context.operationId)) throw new Error("Session start binding does not match broker context")
  return {
    sessionId: context.sessionId,
    ask: (request, options) => owner.requests.askStart(context, request, options),
    completeElicitation: (elicitationId) => {
      if (!context.start) throw new Error("Session completion requires a start binding")
      return owner.requests.completeElicitation(context.sessionId, context.start.connectionId, elicitationId)
    },
    rebind: (upstreamSessionId) => ports.rebind(context.sessionId, upstreamSessionId),
    persistHandoff: (handoff) => ports.persistHandoff(context.sessionId, handoff),
    admitProviderTurn: (input, run) => admitProviderTurn(
      ports, context.sessionId, input,
      (turnId, signal) => {
        const authority = ports.currentTurnAuthority(context.sessionId)
        if (!authority || authority.turnId !== turnId) throw new Error("Provider turn authority unavailable")
        return createTurnBroker(owner, { authority, origin: context.origin, signal })
      },
      run,
    ),
    meter: (usage) => {
      if (usage.sessionId !== context.sessionId || usage.directory !== context.directory) {
        throw new Error("Usage belongs to another session")
      }
      ports.meterUsage(usage)
    },
    publish: (event) => ports.publishSessionEvent(context.sessionId, event),
    goal: goalPort(ports, context.sessionId),
    config: () => ports.config(context.sessionId),
    reportFailure: (error) => ports.reportOwnerFailure(context.sessionId, error),
  }
}

export type { BrokerPorts, SessionBrokerContext, TurnBrokerContext, TurnAuthority } from "./ports"
