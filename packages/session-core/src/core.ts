import { createBus, type WorkspaceRuntimeEvent } from "./bus"
import { createSessionPlacement, type SessionPlacementPort } from "./placement"
import { createRuntimeEventHub } from "./projection/runtime-event-hub"
import { createAgentRuntime, type AgentRuntimeCompositionInput } from "./host/runtime"
import { SessionRoutes, type SessionRoutesOptions } from "./routes/session"
import { workspaceEventsHandler, type WorkspaceEventsOptions } from "./routes/events"

export function createSessionCore(ports: { placement: SessionPlacementPort; eventHub?: import("./projection/runtime-event-hub").RuntimeEventHub }) {
  const bus = createBus<WorkspaceRuntimeEvent>()
  const placement = createSessionPlacement(ports.placement)
  const eventHub = ports.eventHub ?? createRuntimeEventHub()
  return {
    bus, placement, eventHub,
    createRuntime(input: Omit<AgentRuntimeCompositionInput, "eventHub">) {
      return createAgentRuntime({ ...input, eventHub })
    },
    sessionRoutes(runtime: Parameters<typeof SessionRoutes>[0], options: Omit<SessionRoutesOptions, "bus" | "placement" | "eventHub" | "sessionIdWorkspace">) {
      return SessionRoutes(runtime, { ...options, bus, placement, eventHub, sessionIdWorkspace: placement.sessionIdWorkspace })
    },
    events(options: Omit<WorkspaceEventsOptions, "bus" | "placement" | "eventHub">) {
      return workspaceEventsHandler({ ...options, bus, placement, eventHub })
    },
  }
}

export type SessionCore = ReturnType<typeof createSessionCore>
