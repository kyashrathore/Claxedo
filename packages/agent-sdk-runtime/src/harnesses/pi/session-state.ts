import type { Agent, AgentTool } from "@mariozechner/pi-agent-core"
import type { RuntimeGoalSnapshot } from "@claxedo/agent-event-runtime"
import type { PiModelBackend } from "./model-backend"
import type { AgentMessage, AgentSession, RuntimeDirectory, SessionConfig } from "../../index"
import type { AgentProcessObserverHandle } from "../../process-observer"
import type { SessionEnv } from "../../session-env"

export type PiSession = {
  id: string
  directory?: RuntimeDirectory
  parentID?: string
  title: string | null
  created: number
  updated: number
  archived?: number
  env: SessionEnv
  config: SessionConfig
  messages: AgentMessage[]
  active?: AbortController
  agent?: Agent
  agentExtraTools?: AgentTool[]
  processOwnerId: string
  processObservation: AgentProcessObserverHandle
  goal?: RuntimeGoalSnapshot | null
  goalRun?: { generation: number; backend: PiModelBackend; done: Promise<void> }
}

export function piSessionRow(session: PiSession): AgentSession {
  return {
    id: session.id,
    ...(session.parentID ? { parentID: session.parentID } : {}),
    title: session.title,
    slug: session.id,
    version: "central",
    time: {
      created: session.created,
      updated: session.updated,
      ...(session.archived !== undefined ? { archived: session.archived } : {}),
    },
  }
}

export function defaultPiSessionConfig(): SessionConfig {
  return {
    harness: { id: "pi", access: "native" },
    model: { providerID: "pi", modelID: "virtual" },
    variant: null,
    agent: null,
  }
}
