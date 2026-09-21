import { expect, test } from "bun:test"
import type { CompatEvent } from "../../compat-events"
import { createMemoryRuntimeStore } from "../../stores/memory"
import type { SubagentObservation } from "../../subagent-admission"
import { createSubagentChildren, type SubagentChild } from "./subagent-lifecycle"
import { registerTurnAuthority } from "./turn-authority"

const SOURCE = { dir: "in" as const, method: "subagent/updated" }

function parentTurn(parentSessionId = "parent") {
  const store = createMemoryRuntimeStore()
  store.bindSession({ sessionId: parentSessionId, directory: "/work", agentSessionId: "agent-parent" })
  const published: CompatEvent[] = []
  const children = new Map<string, SubagentChild>()
  const owner = createSubagentChildren({
    parentSessionId,
    directory: "/work",
    input: { agent: "build" },
    fenced: {},
    store,
    children,
    bindSession: (input) => store.bindSession(input),
    publish: (event) => published.push(event),
    projectChild: () => {},
  })
  return { store, owner, children, published }
}

function observation(id: string, status: SubagentObservation["status"]): SubagentObservation {
  return { observationId: `obs-${id}-${status}`, subagentKey: id, providerId: `provider-${id}`, providerKind: "codex", status }
}

function seedChild(turn: ReturnType<typeof parentTurn>, key: string, childSessionId: string) {
  return turn.owner.child({
    observation: observation(key, "running"),
    subagentKey: key,
    childSessionId,
    source: SOURCE,
  })
}

test("a child's turn claims the child session's own lease, not the parent's", () => {
  const turn = parentTurn()
  const { child } = seedChild(turn, "task-1", "child-1")

  expect(child.authority?.domain).toBe("provider_child")
  expect(turn.store.readTurnAuthority("child-1")?.leaseId).toBe(child.authority!.leaseId)
  // The parent is untouched: a child turn is not the parent's turn.
  expect(turn.store.readTurnAuthority("parent")).toBeUndefined()
})

test("settling a child releases its lease, and a repeated terminal is a replay", () => {
  const turn = parentTurn()
  const { child } = seedChild(turn, "task-1", "child-1")

  turn.owner.settle(child, observation("task-1", "completed"), SOURCE)
  expect(turn.store.readTurnAuthority("child-1")).toBeUndefined()

  const after = turn.published.length
  // The provider repeats its terminal; there is nothing left to end.
  turn.owner.settle(child, observation("task-1", "completed"), SOURCE)
  expect(turn.published.length).toBe(after)
})

test("a late settle against a replacement child generation is refused by the store fence", () => {
  const turn = parentTurn()
  const { child } = seedChild(turn, "task-1", "child-1")
  const stale = { ...child, authority: child.authority }

  turn.owner.settle(child, observation("task-1", "completed"), SOURCE)

  // The child session is admitted to a replacement turn by another owner.
  const replacement = registerTurnAuthority(turn.store, "provider_child", {
    sessionId: "child-1",
    assistantMessageId: "asst-replacement",
  })!
  turn.store.startTurn({
    sessionId: "child-1",
    agentSessionId: "provider-task-1",
    assistantMessageId: "asst-replacement",
    agent: "build",
    parts: [],
  })

  expect(() => turn.owner.settle(stale, observation("task-1", "completed"), SOURCE)).toThrow()
  // The replacement still holds the session; the stale terminal ended nothing.
  expect(turn.store.readTurnAuthority("child-1")?.leaseId).toBe(replacement.leaseId)
})

test("settleOpen interrupts a foreground child this turn still owns, and skips a background one", async () => {
  const turn = parentTurn()
  const foreground = seedChild(turn, "task-fg", "child-fg")
  seedChild(turn, "task-bg", "child-bg")
  turn.owner.track(observation("task-fg", "running"), { subagentKey: "task-fg", status: "running" } as never)
  turn.owner.track(observation("task-bg", "running"), { subagentKey: "task-bg", status: "running", mode: "background" } as never)

  const interrupted: string[] = []
  await turn.owner.settleOpen("turn-end", async (row) => { interrupted.push(row.subagentKey!) })

  // Continuing past the turn is what a background subagent is for.
  expect(interrupted).toEqual(["task-fg"])
  expect(foreground.child.authority).toBeDefined()
})

test("a child whose turn could not start does not keep the session's lease", () => {
  const turn = parentTurn()
  const refusing = new Proxy(turn.store, {
    get: (target, key, receiver) => key === "startTurn"
      ? () => { throw new Error("journal is unavailable") }
      : Reflect.get(target, key, receiver),
  })
  const owner = createSubagentChildren({
    parentSessionId: "parent",
    directory: "/work",
    input: { agent: "build" },
    fenced: {},
    store: refusing,
    children: new Map(),
    bindSession: (input) => turn.store.bindSession(input),
    publish: () => {},
    projectChild: () => {},
  })

  expect(() => owner.child({
    observation: observation("task-1", "running"),
    subagentKey: "task-1",
    childSessionId: "child-1",
    source: SOURCE,
  })).toThrow("journal is unavailable")
  // Nothing will ever finalize a turn that never started, so a retained lease
  // would block the child session for the life of the process.
  expect(turn.store.readTurnAuthority("child-1")).toBeUndefined()
})
