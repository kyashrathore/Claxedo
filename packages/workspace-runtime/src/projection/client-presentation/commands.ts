import type { AgentEventEnvelope, AgentRuntimeEventOf } from "@claxedo/agent-runtime-contract"
import { withDir } from "../presentation-events"

export function projectSessionCommands(sessionId: string, directory: string, chunk: AgentRuntimeEventOf<"available-commands-update">): AgentEventEnvelope {
  return withDir(directory, {
    type: "session.commands",
    properties: { sessionID: sessionId, commands: chunk.commands },
  })
}
