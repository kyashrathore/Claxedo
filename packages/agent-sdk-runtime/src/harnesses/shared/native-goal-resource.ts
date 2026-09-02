import { randomUUID } from "crypto"
import type { RuntimeGoalSnapshot } from "@claxedo/agent-event-runtime"
import type { AgentGoalMutationResult, AgentGoalResource } from "../../adapter-contract"
import type { AgentRuntimeStreamEvent, PromptInput, SessionConfig } from "../../index"
import { requireWorkspaceDirectory } from "../../target"
import { settleGoalStop, type GoalTurnInterrupt } from "./goal-stop-order"
import type { SdkRuntimeDriver, SdkRuntimeTurnInput } from "./sdk-runtime-driver"
import { errorMessage } from "./sdk-runtime-values"

export type NativeGoal = NonNullable<SdkRuntimeDriver["nativeGoal"]>

/** What a native Goal needs from the adapter that owns the session. */
export type NativeGoalResourceHost = {
  native: NativeGoal
  driverType: string
  lifecycle(): GoalTurnInterrupt
  /** The Goal the runtime store still projects for a session. */
  projectedGoal(sessionId: string): RuntimeGoalSnapshot | null | undefined
  publishGoal(sessionId: string, directory: string, goal: RuntimeGoalSnapshot | null): void
  sessionConfig(sessionId: string, directory: string): Promise<SessionConfig>
  defaultModelId(): string
  streamTurn(
    sessionId: string,
    input: PromptInput,
    directory: string,
    execute: (turn: SdkRuntimeTurnInput) => Promise<void>,
  ): AsyncIterable<AgentRuntimeStreamEvent>
}

/**
 * The Goal surface for a driver whose Goal lives inside a provider session
 * rather than in a controller of our own: the runtime can start one, stop it,
 * and reconcile the projection it left behind, but the provider owns the loop.
 */
export function createNativeGoalResource(host: NativeGoalResourceHost): AgentGoalResource {
  const native = host.native
  const unsupported = (action: string) => Promise.resolve({
    ok: false as const,
    status: "unsupported" as const,
    message: `${host.driverType} does not advertise Goal ${action}`,
  })
  const notFound = { ok: false as const, status: "not_found" as const, message: "No Goal exists" }
  /**
   * Recovery outcome for a Goal the driver no longer holds.
   *
   * A native Goal lives in a provider process, so a restart leaves the driver
   * with nothing to stop while the store still projects the Goal — which
   * `read` surfaces as `blocked`. There is no live work to interrupt, so
   * clearing the projection is both the honest result and the only way the
   * Goal can ever leave the session: without it the projected Goal is
   * permanently unstoppable and undeletable.
   */
  const clearProjectedGoal = (sessionId: string, directory: string) => {
    if (!host.projectedGoal(sessionId)) return notFound
    host.publishGoal(sessionId, directory, null)
    return { ok: true as const, goal: null }
  }
  return {
    // The resource can delete beyond what the driver advertises: a Goal the
    // driver no longer holds is cleared from the projection, and a driver
    // `delete` clears a live one. Only a live Goal on a driver without
    // `delete` is truly undeletable, so advertise per-session honesty.
    readCapabilities: async (sessionId, directory) => {
      const required = requireWorkspaceDirectory(directory)
      const capabilities = await native.capabilities(sessionId, required)
      if (capabilities.actions.includes("delete")) return capabilities
      const deletable = !!native.delete || !(await native.read(sessionId, required))
      return deletable ? { ...capabilities, actions: [...capabilities.actions, "delete"] } : capabilities
    },
    read: async (sessionId, directory) => {
      const required = requireWorkspaceDirectory(directory)
      const live = await native.read(sessionId, required)
      if (live) return live
      const projected = host.projectedGoal(sessionId)
      if (!projected) return null
      const capabilities = await native.capabilities(sessionId, required)
      return capabilities.recovery === "blocked"
        ? { ...projected, status: "blocked", updatedAt: Date.now() }
        : projected
    },
    start: (sessionId, input, directory) =>
      startNativeGoal(host, sessionId, input.objective, requireWorkspaceDirectory(directory)),
    pause: () => unsupported("Pause"),
    resume: () => unsupported("Resume"),
    delete: async (sessionId, directory) => {
      const required = requireWorkspaceDirectory(directory)
      // Only the leftover projection of a Goal the driver has lost can be
      // cleared without the provider.
      if (!await native.read(sessionId, required)) return clearProjectedGoal(sessionId, required)
      // Deleting a LIVE Goal locally would lie: a resumed provider session
      // re-emits it. Only a driver whose provider has a clear operation may do
      // it, and then in the same order as `stop`.
      const clear = native.delete
      if (!clear) return unsupported("Delete")
      return settleGoalStop<null>({
        sessionId,
        lifecycle: host.lifecycle(),
        disableContinuation: async () => {
          await native.stop(sessionId, required)
          return { ok: true, goal: null }
        },
        settle: async () => {
          if (!await clear(sessionId, required)) return notFound
          host.publishGoal(sessionId, required, null)
          return { ok: true, goal: null }
        },
      })
    },
    stop: async (sessionId, directory) => {
      const required = requireWorkspaceDirectory(directory)
      if (!await native.read(sessionId, required)) return clearProjectedGoal(sessionId, required)
      return settleGoalStop<RuntimeGoalSnapshot | null>({
        sessionId,
        lifecycle: host.lifecycle(),
        disableContinuation: async () => {
          const stopped = await native.stop(sessionId, required)
          if (!stopped) return notFound
          host.publishGoal(sessionId, required, stopped)
          return { ok: true, goal: stopped }
        },
      })
    },
  }
}

/**
 * Starting a native Goal IS a turn: the provider accepts the objective inside
 * the run it starts for it. The mutation settles on the first Goal snapshot the
 * provider reports, while the turn keeps streaming behind it.
 */
async function startNativeGoal(
  host: NativeGoalResourceHost,
  sessionId: string,
  objective: string,
  directory: string,
): Promise<AgentGoalMutationResult<RuntimeGoalSnapshot>> {
  const config = await host.sessionConfig(sessionId, directory)
  const input: PromptInput = {
    parts: [{ type: "text", text: objective }],
    userMessageId: randomUUID(),
    assistantMessageId: randomUUID(),
    agent: config.agent ?? "build",
    model: config.model ?? { providerID: host.driverType, modelID: host.defaultModelId() || "default" },
    ...(config.variant ? { variant: config.variant } : {}),
  }
  let settled = false
  let accept: (result: AgentGoalMutationResult<RuntimeGoalSnapshot>) => void = () => {}
  const accepted = new Promise<AgentGoalMutationResult<RuntimeGoalSnapshot>>((resolve) => {
    accept = resolve
  })
  const consume = async () => {
    for await (const _event of host.streamTurn(
      sessionId,
      input,
      directory,
      (turn) => host.native.run(turn, objective, (goal) => {
        host.publishGoal(sessionId, directory, goal)
        if (!settled && goal) {
          settled = true
          accept({ ok: true, goal })
        }
      }),
    )) {}
    if (!settled) {
      settled = true
      accept({ ok: false, status: "failed", message: `${host.driverType} ended before accepting Goal` })
    }
  }
  void consume().catch((error) => {
    if (settled) return
    settled = true
    accept({ ok: false, status: "failed", message: errorMessage(error) })
  })
  return await accepted
}
