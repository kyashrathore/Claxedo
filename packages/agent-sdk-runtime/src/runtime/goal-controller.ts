import { agentRuntimeEvent, type RuntimeGoalSnapshot } from "@claxedo/agent-event-runtime"
import type { RuntimeDirectory } from "../index"
import type { AgentGoalMutationResult, AgentGoalResource, AgentHarnessAdapter } from "../adapter-contract"
import { requireGoalResource } from "../adapter-contract"
import { GoalCapabilityError, requireGoalAction, type GoalAction, type GoalCapabilities } from "../capabilities"
import { normalizeDirectory } from "./execution-binding"
import { createGoalStartAdmission } from "./goal-start-admission"
import { AgentRuntimeGoalError } from "./contracts"
import type {
  AgentRuntimeEventEnvelope,
  AgentRuntimeGoalStartInput,
  AgentRuntimeStore,
} from "./contracts"

export interface RuntimeGoalControllerInput {
  store: AgentRuntimeStore
  adapterForSession: (sessionId: string) => Promise<AgentHarnessAdapter>
  publish: (event: AgentRuntimeEventEnvelope) => void
  subscribeRuntime: (listen: (event: AgentRuntimeEventEnvelope) => void) => () => void
  /** Ends a turn the mutation cancelled; the runtime owns turn admission. */
  completeCancellation: (sessionId: string, directory?: RuntimeDirectory) => void
}

/**
 * The runtime's Goal surface: capability resolution, the single mutation path,
 * and one fan-out for every Goal state a subscriber may observe, whichever side
 * produced it — a mutation performed here, or a provider-originated update that
 * reached the event hub. Deduping by snapshot signature — the same policy
 * adapters apply on the hub side — keeps a mutation that is also mirrored onto
 * the hub from publishing the same state twice.
 */
export function createRuntimeGoalController(input: RuntimeGoalControllerInput) {
  const startAdmissions = createGoalStartAdmission()
  const publishedSignatures = new Map<string, string>()

  const publishSnapshot = (sessionId: string, directory: RuntimeDirectory, goal: RuntimeGoalSnapshot | null) => {
    const signature = JSON.stringify(goal ?? null)
    if (publishedSignatures.get(sessionId) === signature) return
    publishedSignatures.set(sessionId, signature)
    input.publish({
      sessionId,
      directory,
      payload: goal
        ? agentRuntimeEvent.goalUpdated({ sessionId, goal })
        : agentRuntimeEvent.goalCleared({ sessionId }),
    })
  }

  const publishResult = (sessionId: string, directory: RuntimeDirectory, result: AgentGoalMutationResult) => {
    if (!result.ok) return
    publishSnapshot(sessionId, directory, result.goal ?? null)
  }

  const unsubscribeBridge = input.subscribeRuntime((event) => {
    if (event.payload.type !== "goal-updated" && event.payload.type !== "goal-cleared") return
    const session = input.store.getSession(event.sessionId)
    publishSnapshot(
      event.sessionId,
      session ? session.directory ?? undefined : event.directory,
      event.payload.type === "goal-updated" ? event.payload.goal : null,
    )
  })

  const readContext = async (sessionId: string, requestedDirectory?: RuntimeDirectory) => {
    const session = input.store.getSession(sessionId)
    if (!session) {
      throw new AgentRuntimeGoalError("goal_session_not_found", `Session ${sessionId} not found`)
    }
    const directory = session.directory ?? undefined
    if (requestedDirectory !== undefined && normalizeDirectory(requestedDirectory) !== normalizeDirectory(directory)) {
      throw new AgentRuntimeGoalError("goal_scope_mismatch", `Session ${sessionId} does not belong to this directory`)
    }
    const adapter = await input.adapterForSession(sessionId)
    const coarse = await adapter.readHarnessCapabilities(directory, { sessionId })
    let resource: AgentGoalResource
    try {
      resource = requireGoalResource(adapter)
    } catch (error) {
      const message = error instanceof Error ? error.message : "Goal resource is unavailable"
      throw new AgentRuntimeGoalError("goal_unavailable", message)
    }
    return { adapter, directory, harness: coarse.harness, resource }
  }

  const capableContext = async (sessionId: string, requestedDirectory?: RuntimeDirectory) => {
    const context = await readContext(sessionId, requestedDirectory)
    const capabilities = await context.resource.readCapabilities(sessionId, context.directory)
    return { ...context, capabilities }
  }

  const availableContext = async (sessionId: string, requestedDirectory?: RuntimeDirectory) => {
    const context = await capableContext(sessionId, requestedDirectory)
    const { capabilities } = context
    if (!capabilities.implemented || !capabilities.available) {
      throw new AgentRuntimeGoalError(
        "goal_unavailable",
        capabilities.unavailableReason ?? `${context.harness} Goal is unavailable`,
      )
    }
    return context
  }

  /**
   * The single Goal mutation path. `stop` is deliberately ungated: it is the
   * safety valve that must end a running Goal even on a harness that offers no
   * pause/resume/delete, so it is not one of `GOAL_ACTIONS`.
   */
  const mutate = async (
    sessionId: string,
    mutation: GoalAction | "stop",
    requestedDirectory?: RuntimeDirectory,
  ): Promise<AgentGoalMutationResult> => {
    const context = await availableContext(sessionId, requestedDirectory)
    if (mutation !== "stop") {
      try {
        requireGoalAction(context.capabilities, mutation)
      } catch (error) {
        const message = error instanceof GoalCapabilityError ? error.message : `Goal action '${mutation}' is unavailable`
        throw new AgentRuntimeGoalError("goal_action_unavailable", message)
      }
    }
    const result = await context.resource[mutation](sessionId, context.directory) as AgentGoalMutationResult
    if (result.ok && mutation !== "resume" && input.store.getSession(sessionId)?.status === "busy") {
      input.completeCancellation(sessionId, context.directory)
    }
    publishResult(sessionId, context.directory, result)
    return result
  }

  return {
    forgetSession(sessionId: string) {
      publishedSignatures.delete(sessionId)
    },
    dispose() {
      startAdmissions.clear()
      publishedSignatures.clear()
      unsubscribeBridge()
    },
    resource: {
      async capabilities(sessionId: string, directory?: RuntimeDirectory): Promise<GoalCapabilities> {
        return (await capableContext(sessionId, directory)).capabilities
      },
      async read(sessionId: string, directory?: RuntimeDirectory): Promise<RuntimeGoalSnapshot | null> {
        const context = await readContext(sessionId, directory)
        return await context.resource.read(sessionId, context.directory)
      },
      async start(
        goal: AgentRuntimeGoalStartInput,
        directory?: RuntimeDirectory,
      ): Promise<AgentGoalMutationResult<RuntimeGoalSnapshot>> {
        if (typeof goal?.objective !== "string") {
          throw new AgentRuntimeGoalError("goal_invalid_objective", "Goal objective must be a string")
        }
        const objective = goal.objective.trim()
        if (!objective || objective.length > 4_000) {
          throw new AgentRuntimeGoalError(
            "goal_invalid_objective",
            "Goal objective must contain between 1 and 4,000 characters",
          )
        }
        return await startAdmissions.run(goal.sessionId, async () => {
          const context = await availableContext(goal.sessionId, directory)
          if (await context.resource.read(goal.sessionId, context.directory)) {
            throw new AgentRuntimeGoalError("goal_already_exists", `Session ${goal.sessionId} already has a Goal`)
          }
          const result = await context.resource.start(goal.sessionId, { objective }, context.directory)
          publishResult(goal.sessionId, context.directory, result)
          return result
        })
      },
      async pause(sessionId: string, directory?: RuntimeDirectory) {
        return await mutate(sessionId, "pause", directory)
      },
      async resume(sessionId: string, directory?: RuntimeDirectory) {
        return await mutate(sessionId, "resume", directory)
      },
      async stop(sessionId: string, directory?: RuntimeDirectory): Promise<AgentGoalMutationResult> {
        return await mutate(sessionId, "stop", directory)
      },
      async delete(sessionId: string, directory?: RuntimeDirectory): Promise<AgentGoalMutationResult<null>> {
        const result = await mutate(sessionId, "delete", directory)
        // Delete leaves no goal; the adapter contract says so, and the shared
        // mutation path returns the wider union every action shares.
        return result.ok ? { ok: true, goal: null } : result
      },
    },
  }
}
