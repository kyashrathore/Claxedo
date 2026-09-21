import { randomUUID } from "crypto"
import type { RuntimeGoalSnapshot } from "@claxedo/agent-event-runtime"
import type { AgentGoalMutationResult, AgentGoalResource } from "../../adapter-contract"
import type { AgentRuntimeStreamEvent, PromptInput } from "../../index"
import type { RuntimeEventHub } from "../../runtime-event-hub"
import { requireWorkspaceDirectory } from "../../target"
import { createGoalPublisher, type GoalPublisher } from "./goal-publisher"
import { createNativeGoalResource } from "./native-goal-resource"
import type { ActiveTurn, SdkRuntimeDriver, SdkRuntimeStore, SdkRuntimeTurnInput } from "./sdk-runtime-driver"
import type { SessionTurnLifecycle } from "./turn-lifecycle"

/** What the Goal surface needs from the adapter that owns it. */
export type SdkRuntimeGoalHost = {
  driver: SdkRuntimeDriver
  store: SdkRuntimeStore
  eventHub?: RuntimeEventHub
  lifecycle(): SessionTurnLifecycle<ActiveTurn>
  currentModel(): string
  /** The adapter's own turn projection, which a provider-driven Goal turn runs through. */
  streamTurn(
    sessionId: string,
    input: PromptInput,
    directory: string,
    execute: (turn: SdkRuntimeTurnInput) => Promise<void>,
  ): AsyncIterable<AgentRuntimeStreamEvent>
}

/**
 * The Goal surface an SDK-backed adapter exposes, and the provider-turn host a
 * driver-owned Goal needs to project through.
 *
 * Every mutation publishes the snapshot it accepted, and a Goal turn the
 * provider starts on its own reaches the transcript through the same
 * projection an ordinary prompt does — which is what keeps one session from
 * having two ideas of what its Goal is.
 */
export function createSdkRuntimeGoals(host: SdkRuntimeGoalHost) {
  let goalPublisher: GoalPublisher | undefined
  /**
   * Lazy so instances built without the constructor (Object.create in tests)
   * still publish and forget safely — same pattern as the ACP adapter.
   */
  const publisher = (): GoalPublisher => (goalPublisher ??= createGoalPublisher(host.eventHub))

const resource = (): AgentGoalResource | undefined => {
  const goals = host.driver.goals
  if (!goals) return nativeResource()
  const publish = async <T extends RuntimeGoalSnapshot | null>(
    sessionId: string,
    directory: string,
    operation: () => Promise<AgentGoalMutationResult<T>>,
  ) => {
    const result = await operation()
    if (result.ok) publishGoal(sessionId, directory, result.goal)
    return result
  }
  return {
    readCapabilities: (sessionId, directory) => goals.readCapabilities(sessionId, directory),
    read: (sessionId, directory) => goals.read(sessionId, directory),
    start: (sessionId, input, directory) => {
      const required = requireWorkspaceDirectory(directory)
      return publish(sessionId, required, () => goals.start(sessionId, input, required))
    },
    pause: (sessionId, directory) => {
      const required = requireWorkspaceDirectory(directory)
      return publish(sessionId, required, () => goals.pause(sessionId, required))
    },
    resume: (sessionId, directory) => {
      const required = requireWorkspaceDirectory(directory)
      return publish(sessionId, required, () => goals.resume(sessionId, required))
    },
    stop: (sessionId, directory) => {
      const required = requireWorkspaceDirectory(directory)
      return publish(sessionId, required, () => goals.stop(sessionId, required))
    },
    delete: (sessionId, directory) => {
      const required = requireWorkspaceDirectory(directory)
      return publish(sessionId, required, () => goals.delete(sessionId, required))
    },
  }
}

const nativeResource = (): AgentGoalResource | undefined => {
  const native = host.driver.nativeGoal
  if (!native) return undefined
  return createNativeGoalResource({
    native,
    driverType: host.driver.type,
    lifecycle: () => host.lifecycle(),
    projectedGoal: (sessionId) => host.store.getGoal?.(sessionId),
    publishGoal: (sessionId, directory, goal) => publishGoal(sessionId, directory, goal),
    sessionConfig: async (sessionId) => host.store.getSessionConfig(sessionId) ?? {
      harness: { id: host.driver.type, access: "native" },
      variant: null,
      agent: null,
    },
    defaultModelId: () => host.currentModel(),
    streamTurn: (sessionId, input, directory, execute) => host.streamTurn(sessionId, input, directory, execute),
  })
}

const publishGoal = (sessionId: string, directory: string, goal: RuntimeGoalSnapshot | null) => {
  publisher().publish({
    sessionId,
    directory,
    agentSessionId: host.store.getAgentSessionId(sessionId) ?? undefined,
    goal,
    applyState: (next) => host.store.setGoal?.(sessionId, next),
  })
}

const runProviderTurn = (
  sessionId: string,
  directory: string,
  execute: (turn: SdkRuntimeTurnInput) => Promise<void>,
  userMessage?: { id: string; text: string },
): Promise<boolean> => {
  return (async () => {
    const config = host.store.getSessionConfig(sessionId)
    const parent = userMessage ? undefined : host.store.getLatestUserMessageId(sessionId)
    if (!userMessage && !parent) throw new Error(`Provider turn has no user intent for session ${sessionId}`)
    const input: PromptInput = {
      parts: userMessage ? [{ type: "text", text: userMessage.text }] : [],
      ...(userMessage ? { userMessageId: userMessage.id } : { parentMessageId: parent! }),
      assistantMessageId: randomUUID(),
      agent: config?.agent ?? "build",
      model: config?.model ?? { providerID: host.driver.type, modelID: host.currentModel() || "default" },
      ...(config?.variant ? { variant: config.variant } : {}),
    }
    let admitted = false
    for await (const _event of host.streamTurn(sessionId, input, directory, async (turn) => {
      admitted = true
      await execute(turn)
    })) {}
    return admitted
  })().catch((error) => {
    console.error(`${host.driver.type} provider Goal turn projection failed`, error)
    return false
  })
}

  return { resource, publishGoal, runProviderTurn, publisher }
}

export type SdkRuntimeGoals = ReturnType<typeof createSdkRuntimeGoals>
