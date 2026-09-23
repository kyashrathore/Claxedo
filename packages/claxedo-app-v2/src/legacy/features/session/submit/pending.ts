import type { AgentRuntimeStatus as SessionStatus } from "@claxedo/agent-runtime-contract"
import {
  dispatchSessionStatusEvent,
  schedulePromptSessionStatusTimeouts,
} from "../store/session-status-dispatcher"

export function setPromptSessionStatus(input: {
  sessionID: string
  status: SessionStatus
  source?: "optimistic" | "server"
  refreshDirectory?: VoidFunction
}) {
  dispatchSessionStatusEvent({
    event: {
      type: "session.status",
      source: input.source ?? "optimistic",
      sessionID: input.sessionID,
      status: input.status,
    },
  })
  if ((input.source ?? "optimistic") === "optimistic" && input.status.type !== "idle") {
    schedulePromptSessionStatusTimeouts({
      sessionID: input.sessionID,
      refreshDirectory: input.refreshDirectory,
    })
  }
}
