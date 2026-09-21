import { expect, test } from "bun:test"
import { createMemoryRuntimeStore } from "../../stores/memory"
import { createSessionTurnLifecycle } from "../shared/turn-lifecycle"
import { registerTurnAuthority } from "../shared/turn-authority"
import type { WithInternals } from "../../test-utils/class-internals"
import { AcpHarnessAdapter } from "./index"

type GoalInternals = {
  store: ReturnType<typeof createMemoryRuntimeStore>
  options: { reportOwnerFailure?: (sessionId: string, error: unknown) => void }
  goalProjections: Map<string, unknown>
  goalRuntimes: Map<string, unknown>
  turnLifecycle: ReturnType<typeof createSessionTurnLifecycle>
}

/**
 * A Goal projection the way `startGoalProjection` leaves one: a claimed lease,
 * a started turn, and the session inside its busy section.
 */
function goalProjection(input: { finishFails?: boolean } = {}) {
  const store = createMemoryRuntimeStore()
  store.bindSession({ sessionId: "s1", directory: "/work", agentSessionId: "agent-1" })
  const lifecycle = createSessionTurnLifecycle()
  const leaveBusy = lifecycle.enter("s1")!
  const authority = registerTurnAuthority(store, "acp_goal", { sessionId: "s1", assistantMessageId: "asst-1" })!
  store.startTurn({ sessionId: "s1", agentSessionId: "agent-1", assistantMessageId: "asst-1", agent: "build", parts: [] })

  const failures: Array<{ sessionId: string; error: unknown }> = []
  const runner = Object.create(AcpHarnessAdapter.prototype) as WithInternals<AcpHarnessAdapter, GoalInternals> & {
    finishGoalProjection(sessionId: string, error?: string): void
    lifecycle(): ReturnType<typeof createSessionTurnLifecycle>
  }
  runner.store = input.finishFails
    ? new Proxy(store, {
        get: (target, key, receiver) => key === "finishTurn"
          ? () => { throw new Error("journal is unavailable") }
          : Reflect.get(target, key, receiver),
      })
    : store
  runner.options = { reportOwnerFailure: (sessionId, error) => failures.push({ sessionId, error }) }
  runner.turnLifecycle = lifecycle
  const turn = { drain: () => {}, stops: { attempts: [] } }
  runner.goalProjections = new Map([["s1", {
    agentSessionId: "agent-1",
    directory: "/work",
    assistantMessageId: "asst-1",
    authority,
    runtime: undefined,
    projector: { project: () => {}, terminalizeOpenTools: () => {} },
    proc: { permissionPushers: new Map() },
    turn,
    leaveBusy,
  }]])
  runner.goalRuntimes = new Map()
  lifecycle.set("s1", turn as never)
  return { runner, store, lifecycle, failures }
}

test("a Goal projection that finalizes cleanly releases the session", () => {
  const { runner, store, lifecycle } = goalProjection()

  runner.finishGoalProjection("s1")

  expect(store.readTurnAuthority("s1")).toBeUndefined()
  expect(lifecycle.busySessions.has("s1")).toBe(false)
  expect(lifecycle.enter("s1")).not.toBeNull()
})

test("a Goal terminal the store refuses still leaves the session admissible", () => {
  const { runner, lifecycle, failures } = goalProjection({ finishFails: true })

  runner.finishGoalProjection("s1")

  // The projection is over either way. Holding the busy section on a refusal
  // would leave the session unable to run anything, forever.
  expect(lifecycle.busySessions.has("s1")).toBe(false)
  expect(lifecycle.enter("s1")).not.toBeNull()
  // And the refusal is not swallowed: it belongs to the session's owner.
  expect(failures).toHaveLength(1)
  expect(failures[0].sessionId).toBe("s1")
})

test("a Goal projection whose turn could not start does not keep the session's lease", () => {
  const store = createMemoryRuntimeStore()
  store.bindSession({ sessionId: "s1", directory: "/work", agentSessionId: "agent-1" })
  const lifecycle = createSessionTurnLifecycle()
  const failures: unknown[] = []

  const runner = Object.create(AcpHarnessAdapter.prototype) as WithInternals<AcpHarnessAdapter, GoalInternals> & {
    startGoalProjection(sessionId: string, agentSessionId: string, directory: string, proc: unknown, runtime: unknown): unknown
  }
  runner.store = new Proxy(store, {
    get: (target, key, receiver) => key === "startTurn"
      ? () => { throw new Error("journal is unavailable") }
      : Reflect.get(target, key, receiver),
  })
  runner.options = { reportOwnerFailure: (_sessionId, error) => failures.push(error) }
  runner.turnLifecycle = lifecycle
  runner.goalProjections = new Map()
  runner.goalRuntimes = new Map()

  expect(() => runner.startGoalProjection("s1", "agent-1", "/work", { permissionPushers: new Map() }, undefined))
    .toThrow("journal is unavailable")

  // Nothing will finalize a projection that never started, so a retained lease
  // would block the session for the life of the process.
  expect(store.readTurnAuthority("s1")).toBeUndefined()
  expect(lifecycle.enter("s1")).not.toBeNull()
  expect(failures).toHaveLength(1)
})
