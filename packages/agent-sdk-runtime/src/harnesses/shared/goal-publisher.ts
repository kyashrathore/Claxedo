import { agentRuntimeEvent, type RuntimeGoalSnapshot } from "@claxedo/agent-event-runtime"
import type { RuntimeEventHub } from "../../runtime-event-hub"

/**
 * The one Goal publication policy shared by every adapter: dedupe by snapshot
 * signature so each accepted state publishes once, let the adapter mirror its
 * own state, then publish the canonical goal-updated/goal-cleared runtime
 * event. Extracted because adapters carried drifting copies of this sequence.
 */
export function createGoalPublisher(eventHub?: Pick<RuntimeEventHub, "publishRuntime">) {
  const published = new Map<string, string>()
  return {
    publish(input: {
      sessionId: string
      directory: string
      agentSessionId?: string
      goal: RuntimeGoalSnapshot | null
      /**
       * Adapter-specific state mirroring and projection finishing. Runs only
       * when the snapshot actually changed, before the runtime event goes out.
       */
      applyState?: (goal: RuntimeGoalSnapshot | null) => void
    }) {
      const signature = JSON.stringify(input.goal)
      if (published.get(input.sessionId) === signature) return
      published.set(input.sessionId, signature)
      input.applyState?.(input.goal)
      eventHub?.publishRuntime({
        directory: input.directory,
        sessionId: input.sessionId,
        ...(input.agentSessionId ? { agentSessionId: input.agentSessionId } : {}),
        payload: input.goal
          ? agentRuntimeEvent.goalUpdated({ sessionId: input.sessionId, goal: input.goal })
          : agentRuntimeEvent.goalCleared({ sessionId: input.sessionId }),
      })
    },
    /** Drop the dedup entry when the session itself goes away. */
    forget(sessionId: string) {
      published.delete(sessionId)
    },
  }
}

export type GoalPublisher = ReturnType<typeof createGoalPublisher>
