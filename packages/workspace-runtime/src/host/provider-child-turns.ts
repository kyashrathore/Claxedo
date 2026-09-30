import { createTurnEventProjector, type TurnEventProjector } from "../projection/turn-projection"
import { resolveSessionModel } from "../session/session-model"
import type { ParentTurnContext } from "./child-turns"
import type { AgentRuntimeEventEnvelope, AgentRuntimeStore } from "./contracts"
import { normalizeDirectory } from "./execution-binding"
import { sessionTurnAgent } from "./turn-record"

/**
 * What a provider-initiated turn (a native goal continuation, or a turn the
 * harness started itself) lends the children it spawns. It has no prompt, so
 * its children inherit the agent and model the session itself runs, which is
 * what the provider turn's own record carries.
 */
export function providerParentTurn(
  store: AgentRuntimeStore,
  sessionId: string,
  publish: (event: AgentRuntimeEventEnvelope) => void,
): ParentTurnContext {
  const config = store.getSessionConfig(sessionId)
  if (!config) throw new Error(`Provider turn ${sessionId} has no runtime config`)
  const directory = normalizeDirectory(store.getSession(sessionId)?.directory ?? undefined)
  const model = resolveSessionModel(config)
  const projectors = new Map<string, TurnEventProjector>()
  return {
    directory,
    input: { agent: sessionTurnAgent(config), ...(model ? { model } : {}), ...(config.variant ? { variant: config.variant } : {}) },
    projectChild: (target, event, source) => {
      const key = JSON.stringify([target.sessionId, target.assistantMessageId])
      let projector = projectors.get(key)
      if (!projector) {
        projector = createTurnEventProjector({
          store,
          owner: { sessionId: target.sessionId, getAgentSessionId: target.getAgentSessionId },
          directory,
          input: target.input,
          assistantMessageId: target.assistantMessageId,
          created: target.created,
          ...(target.fencingToken === undefined ? {} : { fencingToken: target.fencingToken }),
          onEvent: (payload) => publish({ sessionId: target.sessionId, directory, payload }),
          onRuntimeEvent: publish,
        })
        projectors.set(key, projector)
      }
      projector.project(event, source)
    },
  }
}
