import type { RuntimeGoalSnapshot } from "@claxedo/agent-event-runtime"
import type { AgentGoalMutationResult, AgentGoalResource } from "../../adapter-contract"
import type { RuntimeEventHub } from "../../runtime-event-hub"
import { requireWorkspaceDirectory } from "../../target"
import { createGoalPublisher, type GoalPublisher } from "../shared/goal-publisher"
import type { AgentRuntimeStoreWithRecovery } from "../shared/runtime-store"
import { goalCapabilities } from "../../capabilities"
import { errorMessage } from "../shared/sdk-runtime-values"
import type { ACPProcess, SessionUpdate } from "./process"

/** What the Goal surface needs from the ACP adapter that owns it. */
export type AcpGoalHost = {
  store: AgentRuntimeStoreWithRecovery
  eventHub?: RuntimeEventHub
  entryForSession(sessionId: string): { proc: ACPProcess | null } | undefined
  getOrSpawnProcess(sessionId: string, directory: string): Promise<{ proc: ACPProcess }>
  finishGoalProjection(sessionId: string, error?: string): void
  observeGoalSessionUpdate(
    sessionId: string,
    agentSessionId: string,
    directory: string,
    proc: ACPProcess,
    update: SessionUpdate,
  ): void
}

/**
 * One ACP session's Goal: reading it, acting on it, and publishing what the
 * agent reported.
 *
 * Reads deliberately never spawn. The app activates a session on every open to
 * render its composer, and resurrecting an idle-reaped agent binary for that
 * would make looking at a session cost a process launch plus a full ACP
 * initialize. Only actions pay that.
 */
export function createAcpGoals(host: AcpGoalHost) {
  let goalPublisher: GoalPublisher | undefined
  const publisher = (): GoalPublisher => (goalPublisher ??= createGoalPublisher(host.eventHub))

const publishGoal = (sessionId: string, directory: string, goal: RuntimeGoalSnapshot | null) => {
  publisher().publish({
    sessionId,
    directory,
    agentSessionId: host.store.getAgentSessionId(sessionId) ?? undefined,
    goal,
    applyState: (next) => {
      const previous = host.store.getGoal?.(sessionId)
      host.store.setGoal?.(sessionId, next)
      const advancedIteration = next?.status === "active"
        && previous?.status === "active"
        && next.iteration !== undefined
        && previous.iteration !== undefined
        && next.iteration !== previous.iteration
      if (!next || next.status !== "active" || advancedIteration) host.finishGoalProjection(sessionId)
    },
  })
}

const bindGoalListeners = (sessionId: string, directory: string, agentSessionId: string, proc: ACPProcess) => {
  proc.listenGoal(agentSessionId, sessionId, (goal) => publishGoal(sessionId, directory, goal))
  proc.listenGoalUpdates(agentSessionId, (update) => {
    host.observeGoalSessionUpdate(sessionId, agentSessionId, directory, proc, update)
  })
}

/**
 * Goal target for a session whose agent is ALREADY running.
 *
 * Returns null instead of spawning. Reads (capabilities and Goal state) go
 * through here so that merely activating a session — which the app does on
 * every open, to render the composer dock — never resurrects an idle-reaped
 * agent binary. Only Goal actions pay that cost, through `goalTarget`.
 */
const liveGoalTarget = (sessionId: string, directory: string | undefined) => {
  const required = requireWorkspaceDirectory(directory)
  const agentSessionId = host.store.getAgentSessionId(sessionId)
  const proc = host.entryForSession(sessionId)?.proc
  if (!agentSessionId || !proc?.alive) return null
  bindGoalListeners(sessionId, required, agentSessionId, proc)
  return { agentSessionId, directory: required, proc }
}

/** Goal target for ACTIONS: spawns the agent when it has been idle-reaped. */
const goalTarget = async (sessionId: string, directory: string) => {
  const required = requireWorkspaceDirectory(directory)
  const agentSessionId = host.store.getAgentSessionId(sessionId)
  if (!agentSessionId) throw new Error(`Session ${sessionId} has no ACP session binding`)
  const { proc } = await host.getOrSpawnProcess(sessionId, required)
  bindGoalListeners(sessionId, required, agentSessionId, proc)
  return { agentSessionId, directory: required, proc }
}

const resource = (): AgentGoalResource => {
  const mutate = async <T extends RuntimeGoalSnapshot | null>(
    sessionId: string,
    directory: string,
    operation: (target: Awaited<ReturnType<typeof goalTarget>>) => Promise<T>,
  ): Promise<AgentGoalMutationResult<T>> => {
    try {
      const target = await goalTarget(sessionId, directory)
      const goal = await operation(target)
      publishGoal(sessionId, target.directory, goal)
      return { ok: true, goal }
    } catch (cause) {
      return {
        ok: false,
        status: "failed",
        message: errorMessage(cause),
      }
    }
  }
  return {
    readCapabilities: async (sessionId, directory) => {
      const unavailable = (unavailableReason: string) => goalCapabilities({
        implemented: false,
        available: false,
        unavailableReason,
        actions: [],
        recovery: "blocked",
        optionalFields: [],
      })
      try {
        const target = liveGoalTarget(sessionId, directory)
        if (!target) return unavailable("The ACP agent for this session is not running")
        return goalCapabilities(target.proc.goalCapabilities())
      } catch (cause) {
        return unavailable(errorMessage(cause))
      }
    },
    read: async (sessionId, directory) => {
      const target = liveGoalTarget(sessionId, directory)
      // No live agent: the store projection is the last state the agent
      // reported, and answering from it keeps a session open from costing a
      // process spawn plus a full ACP initialize.
      if (!target) return host.store.getGoal?.(sessionId) ?? null
      const goal = await target.proc.readGoal(target.agentSessionId, sessionId)
      host.store.setGoal?.(sessionId, goal)
      return goal
    },
    start: (sessionId, input, directory) => mutate(sessionId, requireWorkspaceDirectory(directory), async (target) => {
      const goal = await target.proc.startGoal(target.agentSessionId, sessionId, input.objective)
      if (!goal) throw new Error("ACP Goal start returned no Goal")
      return goal
    }),
    pause: (sessionId, directory) => mutate(sessionId, requireWorkspaceDirectory(directory), async (target) => {
      const goal = await target.proc.goalAction("pause", target.agentSessionId, sessionId)
      if (!goal) throw new Error("ACP Goal pause returned no Goal")
      return goal
    }),
    resume: (sessionId, directory) => mutate(sessionId, requireWorkspaceDirectory(directory), async (target) => {
      const resumed = await target.proc.goalAction("resume", target.agentSessionId, sessionId)
      const refreshed = await target.proc.readGoal(target.agentSessionId, sessionId)
      const goal = refreshed ?? resumed
      if (!goal) throw new Error("ACP Goal resume returned no Goal")
      return goal
    }),
    stop: (sessionId, directory) => mutate(sessionId, requireWorkspaceDirectory(directory), (target) =>
      target.proc.stopGoal(target.agentSessionId, sessionId)),
    delete: (sessionId, directory) => mutate(sessionId, requireWorkspaceDirectory(directory), async (target) => {
      await target.proc.goalAction("delete", target.agentSessionId, sessionId)
      return null
    }),
  }
}

  return { resource, publishGoal, bindGoalListeners, forget: (sessionId: string) => goalPublisher?.forget(sessionId) }
}

export type AcpGoals = ReturnType<typeof createAcpGoals>
