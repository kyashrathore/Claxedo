import { createBus, type WorkspaceRuntimeEvent } from "./bus"
import { createSessionPlacement, type SessionPlacementPort } from "./placement"
import { createEventFeedCursor } from "./projection/event-feed-cursor"
import { createRuntimeEventHub, type RuntimeEventHub } from "./projection/runtime-event-hub"
import { createAgentRuntime, type AgentRuntimeCompositionInput } from "./host/runtime"
import { SessionRoutes, type SessionRoutesOptions } from "./routes/session"
import { workspaceEventsHandler, type WorkspaceEventsOptions } from "./routes/events"

export function createSessionCore(ports: { placement: SessionPlacementPort; eventHub?: RuntimeEventHub }) {
  const bus = createBus<WorkspaceRuntimeEvent>()
  const placement = createSessionPlacement(ports.placement)
  const eventHub = ports.eventHub ?? createRuntimeEventHub()
  const cursor = createEventFeedCursor()
  eventHub.subscribeGlobal(cursor.advance)
  bus.subscribe(cursor.advance)
  const eventCursor = cursor.current
  return {
    bus, placement, eventHub, eventCursor,
    createRuntime(input: Omit<AgentRuntimeCompositionInput, "eventHub">) {
      return createAgentRuntime({ ...input, eventHub })
    },
    sessionRoutes(runtime: Parameters<typeof SessionRoutes>[0], options: Omit<SessionRoutesOptions, "bus" | "placement" | "eventHub" | "eventCursor">) {
      return SessionRoutes(runtime, { ...options, bus, placement, eventHub, eventCursor })
    },
    events(options: Omit<WorkspaceEventsOptions, "bus" | "placement" | "eventHub" | "eventCursor">) {
      return workspaceEventsHandler({ ...options, bus, placement, eventHub, eventCursor })
    },
  }
}

export type SessionCore = ReturnType<typeof createSessionCore>
