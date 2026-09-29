import { createTurnEventProjector } from "../projection/turn-projection"
import type { CompatEvent } from "../projection/compat-events"

type ProjectorInput = Parameters<typeof createTurnEventProjector>[0]

/** A turn projector over a journal the test owns, with the defaults every projection test shares. */
export function testTurnProjector(input: Partial<Omit<ProjectorInput, "store">> & {
  appendEvent?: (event: { sessionId: string; agentSessionId?: string; payload: CompatEvent }) => { payload: CompatEvent }
}) {
  const { appendEvent, ...options } = input
  return createTurnEventProjector({
    store: { appendEvent: appendEvent ?? ((event) => ({ payload: event.payload })) },
    owner: { sessionId: "session-1", getAgentSessionId: () => "agent-session-1" },
    directory: "/repo",
    input: { userMessageId: "user-1", agent: "general", model: { providerID: "test", modelID: "model" }, variant: "default" },
    assistantMessageId: "assistant-1",
    created: 100,
    onEvent: () => {},
    ...options,
  })
}
