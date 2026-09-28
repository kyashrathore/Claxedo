import type { AgentGoalMutationResult, GoalAction, GoalCapabilities } from "@claxedo/agent-runtime-contract"
import { agentRuntimeEvent, type RuntimeGoalSnapshot } from "@claxedo/agent-runtime-contract"
import type { RuntimeDirectory } from "@claxedo/agent-sdk-runtime"
import { GoalCapabilityError, requireGoalAction } from "@claxedo/agent-sdk-runtime/adapters"
import type { NativeGoalOperations } from "@claxedo/harness/contract"
import type { AttachedSession } from "./attachments"
import { normalizeDirectory } from "./execution-binding"
import { createKeyedSerializer } from "@claxedo/helpers"
import type { RecoveryTurnCapture } from "./recovery"
import { AgentRuntimeGoalError } from "./contracts"
import type {
  AgentRuntimeEventEnvelope,
  AgentRuntimeGoalStartInput,
  AgentRuntimeStore,
} from "./contracts"

export interface RuntimeGoalControllerInput {
  store: AgentRuntimeStore
  attached: (sessionId: string) => Promise<AttachedSession>
  publish: (event: AgentRuntimeEventEnvelope) => void
  subscribeRuntime: (listen: (event: AgentRuntimeEventEnvelope) => void) => () => void
  /** Reads the turn a mutation may end, before the mutation's first await. */
  captureTurn: (sessionId: string, directory?: RuntimeDirectory) => RecoveryTurnCapture
  /** Ends exactly that turn; the runtime owns turn admission. */
  cancelCapturedTurn: (capture: RecoveryTurnCapture, directory?: RuntimeDirectory) => void | Promise<void>
}

type GoalContext = {
  attached: AttachedSession
  directory: RuntimeDirectory
  harness: string
  capabilities: GoalCapabilities
}

type AvailableGoalContext = GoalContext & { ops: NativeGoalOperations }

/**
 * The runtime's Goal surface: capability resolution, the single mutation path,
 * and one fan-out for every Goal state a subscriber may observe, whichever side
 * produced it — a mutation performed here, or a provider-originated update that
 * reached the event hub. Deduping by snapshot signature keeps a mutation that
 * is also mirrored onto the hub from publishing the same state twice.
 */
export function createRuntimeGoalController(input: RuntimeGoalControllerInput) {
  const startAdmissions = createKeyedSerializer()
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

  const readContext = async (sessionId: string, requestedDirectory?: RuntimeDirectory): Promise<GoalContext> => {
    const session = input.store.getSession(sessionId)
    if (!session) {
      throw new AgentRuntimeGoalError("goal_session_not_found", `Session ${sessionId} not found`)
    }
    const directory = session.directory ?? undefined
    if (requestedDirectory !== undefined && normalizeDirectory(requestedDirectory) !== normalizeDirectory(directory)) {
      throw new AgentRuntimeGoalError("goal_scope_mismatch", `Session ${sessionId} does not belong to this directory`)
    }
    const attached = await input.attached(sessionId)
    const declared = await attached.handle.transport.capabilities({ directory: attached.session.directory, sessionId })
    return { attached, directory, harness: attached.handle.runner.id, capabilities: declared.goals }
  }

  const operableContext = async (sessionId: string, requestedDirectory?: RuntimeDirectory): Promise<AvailableGoalContext> => {
    const context = await readContext(sessionId, requestedDirectory)
    const ops = context.attached.handle.transport.goals
    if (!ops) throw new AgentRuntimeGoalError("goal_unavailable", `${context.harness} does not expose the Goal resource`)
    return { ...context, ops }
  }

  const availableContext = async (sessionId: string, requestedDirectory?: RuntimeDirectory) => {
    const context = await operableContext(sessionId, requestedDirectory)
    const { capabilities } = context
    if (!capabilities.implemented || !capabilities.available) {
      throw new AgentRuntimeGoalError(
        "goal_unavailable",
        capabilities.unavailableReason ?? `${context.harness} Goal is unavailable`,
      )
    }
    return context
  }

  const perform = (context: AvailableGoalContext, mutation: GoalAction | "stop") => {
    const { session, broker } = context.attached
    if (mutation === "pause") return context.ops.pause(session)
    if (mutation === "resume") return context.ops.resume(session, broker)
    if (mutation === "stop") return context.ops.stop(session)
    return context.ops.delete(session)
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
    // Captured before the first await. Resolving the harness and running the
    // provider mutation both yield, and the turn this caller meant to stop can
    // finish and be replaced across either of them.
    const capture = input.captureTurn(sessionId, requestedDirectory)
    const context = await availableContext(sessionId, requestedDirectory)
    if (mutation !== "stop") {
      try {
        requireGoalAction(context.capabilities, mutation)
      } catch (error) {
        const message = error instanceof GoalCapabilityError ? error.message : `Goal action '${mutation}' is unavailable`
        throw new AgentRuntimeGoalError("goal_action_unavailable", message)
      }
    }
    const result = await perform(context, mutation)
    publishResult(sessionId, context.directory, result)
    if (result.ok && mutation !== "resume" && input.store.getSession(sessionId)?.status === "busy") {
      try { await input.cancelCapturedTurn(capture, context.directory) }
      catch (error) {
        return { ok: false, status: "failed", message: error instanceof Error ? error.message : "Goal turn did not stop" }
      }
    }
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
        return (await readContext(sessionId, directory)).capabilities
      },
      async read(sessionId: string, directory?: RuntimeDirectory): Promise<RuntimeGoalSnapshot | null> {
        const context = await operableContext(sessionId, directory)
        return await context.ops.read(context.attached.session)
      },
      async start(
        goal: AgentRuntimeGoalStartInput,
        directory?: RuntimeDirectory,
      ): Promise<AgentGoalMutationResult> {
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
          if (await context.ops.read(context.attached.session)) {
            throw new AgentRuntimeGoalError("goal_already_exists", `Session ${goal.sessionId} already has a Goal`)
          }
          const result = await context.ops.start(context.attached.session, objective, context.attached.broker)
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
        return result.ok ? { ok: true, goal: null } : result
      },
    },
  }
}
