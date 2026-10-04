import { type SubagentObservation, type SubagentUpdatedEvent, UnknownHostSubagentKeyError } from "@claxedo/agent-runtime-contract"
import { MemoryPorts } from "../conformance/test-support/memory-ports"
import { createRequestBroker, createMemorySubagentAdmissionStore } from "./index"
import { expect, test, describe } from "bun:test"

function subagentFixture() {
  const ports = new MemoryPorts()
  const store = createMemorySubagentAdmissionStore()
  Object.defineProperty(ports, "subagentAdmissionStore", { value: store })
  const published: Array<{ parentSessionId: string; event: SubagentUpdatedEvent }> = []
  ports.publishSubagent = async (parentSessionId, event) => { published.push({ parentSessionId, event }) }
  return { ports, store, published, boundary: createRequestBroker(ports).subagents }
}

function hostCreate(subagentKey: string, childSessionId: string): SubagentObservation {
  return {
    observationId: `host:create:${childSessionId}`,
    subagentKey,
    mode: "background",
    status: "pending",
    label: "codex subagent",
    providerKind: "claxedo",
    providerId: childSessionId,
    childSessionId,
    transcript: { kind: "live" },
  }
}

function harnessBinding(subagentKey: string, childSessionId: string): SubagentObservation {
  return {
    observationId: `claude:host-subagent:user-1:tool-1`,
    harnessExecutionId: "sdk-1",
    subagentKey,
    toolCallId: "tool-1",
    toolCallRole: "spawn",
    status: "running",
    providerKind: "claxedo",
    providerId: childSessionId,
    childSessionId,
    transcript: { kind: "live" },
  }
}

describe("subagent binding", () => {
  test("a harness tool edge naming a claxedo key the host never minted is refused as unknown and leaves no row", async () => {
    const item = subagentFixture()
    const forged = harnessBinding("subagent_forged", "someone-elses-session")
    await expect(item.boundary.admit("parent", forged)).rejects.toBeInstanceOf(UnknownHostSubagentKeyError)
    expect(item.store.records()).toEqual([])
    expect(item.published).toEqual([])
  })

  test("the host's own create mints the claxedo row; the harness tool edge then attaches to it", async () => {
    const item = subagentFixture()
    const created = await item.boundary.admit("parent", hostCreate("subagent_host", "child-9"))
    const bound = await item.boundary.admit("parent", harnessBinding("subagent_host", "child-9"))
    expect(created).toMatchObject({ subagentKey: "subagent_host", childSessionId: "child-9", revision: 1 })
    expect(bound).toMatchObject({
      subagentKey: "subagent_host",
      childSessionId: "child-9",
      toolCallId: "tool-1",
      toolCallRole: "spawn",
      status: "running",
      revision: 2,
    })
  })

  test("a harness tool edge naming the host's key with a different child is the immutable-binding conflict", async () => {
    const item = subagentFixture()
    await item.boundary.admit("parent", hostCreate("subagent_host", "child-9"))
    await expect(item.boundary.admit("parent", harnessBinding("subagent_host", "someone-elses-session")))
      .rejects.toThrow("conflicting immutable subagent providerId binding")
    expect(item.store.records()).toHaveLength(1)
  })

  test("child identity is the strongest correlator: an observation naming an owned child resolves to the owning row", async () => {
    const item = subagentFixture()
    const spawn = await item.boundary.admit("parent", {
      observationId: "claude:agent-tool:w:tool-1",
      harnessExecutionId: "run",
      toolCallId: "tool-1",
      toolCallRole: "spawn",
      providerKind: "claude-agent",
      childSessionId: "child-a",
      status: "pending",
      transcript: { kind: "messages" },
    })
    const background = await item.boundary.admit("parent", {
      observationId: "claude:background-task:w:task-1",
      harnessExecutionId: "run",
      stableCorrelationId: "task-1",
      providerKind: "claude-agent",
      status: "running",
      transcript: { kind: "messages" },
    })
    expect(background.subagentKey).not.toBe(spawn.subagentKey)
    const linked = await item.boundary.admit("parent", {
      observationId: "claude:task_started:w",
      harnessExecutionId: "run",
      stableCorrelationId: "task-1",
      toolCallId: "tool-1",
      toolCallRole: "spawn",
      providerKind: "claude-agent",
      childSessionId: "child-a",
      status: "running",
      transcript: { kind: "messages" },
    })
    expect(linked.subagentKey).toBe(spawn.subagentKey)
    expect(linked.childSessionId).toBe("child-a")
  })

  test("an observation matching two rows joins the stronger key instead of opening a third", async () => {
    const item = subagentFixture()
    const hosted = await item.boundary.admit("parent", {
      observationId: "host:create:child-1",
      subagentKey: "subagent_host",
      harnessExecutionId: "run",
      stableCorrelationId: "task-1",
      status: "pending",
    })
    const spawn = await item.boundary.admit("parent", {
      observationId: "claude:agent-tool:w:tool-1",
      harnessExecutionId: "run",
      toolCallId: "tool-1",
      toolCallRole: "spawn",
      providerKind: "claude-agent",
      status: "pending",
      transcript: { kind: "messages" },
    })
    expect(hosted.subagentKey).toBe("subagent_host")
    expect(spawn.subagentKey).not.toBe("subagent_host")

    const linking = await item.boundary.admit("parent", {
      observationId: "claude:task_started:w",
      harnessExecutionId: "run",
      stableCorrelationId: "task-1",
      toolCallId: "tool-1",
      toolCallRole: "spawn",
      status: "running",
      transcript: { kind: "messages" },
    })
    expect(linking.subagentKey).toBe("subagent_host")
  })
})

describe("subagent identity", () => {
  test("keeps one Cursor synthetic key whether provider identity arrives late or never", async () => {
    const item = subagentFixture()
    const spawn = await item.boundary.admit("parent-cursor", {
      observationId: "cursor-spawn",
      harnessExecutionId: "run-cursor",
      toolCallId: "task-1",
      toolCallRole: "spawn",
      status: "running",
      transcript: { kind: "none" },
    })
    const complete = await item.boundary.admit("parent-cursor", {
      observationId: "cursor-complete",
      harnessExecutionId: "run-cursor",
      toolCallId: "task-1",
      toolCallRole: "spawn",
      providerKind: "cursor-agent",
      providerId: "agent-1",
      status: "completed",
      transcript: { kind: "file", ref: "cursor-transcript-1" },
    })
    const neverBound = await item.boundary.admit("parent-cursor", {
      observationId: "cursor-no-id",
      harnessExecutionId: "run-cursor",
      toolCallId: "task-2",
      toolCallRole: "spawn",
      status: "failed",
      transcript: { kind: "none" },
    })

    expect(complete.subagentKey).toBe(spawn.subagentKey)
    expect(complete.providerId).toBe("agent-1")
    expect(neverBound.subagentKey).not.toBe(spawn.subagentKey)
    expect(neverBound.providerId).toBeUndefined()
  })

  test("keeps one Claude host key when provider kind precedes the late agent id", async () => {
    const item = subagentFixture()
    const spawn = await item.boundary.admit("parent-claude", {
      observationId: "claude-agent-tool:tool-1",
      harnessExecutionId: "run-claude",
      toolCallId: "tool-1",
      toolCallRole: "spawn",
      providerKind: "claude-agent",
      status: "pending",
      transcript: { kind: "messages" },
    })
    const bound = await item.boundary.admit("parent-claude", {
      observationId: "claude-agent-result:tool-1",
      harnessExecutionId: "run-claude",
      toolCallId: "tool-1",
      toolCallRole: "spawn",
      providerKind: "claude-agent",
      providerId: "agent-1",
      status: "running",
      transcript: { kind: "messages" },
    })

    expect(bound.subagentKey).toBe(spawn.subagentKey)
    expect(bound.providerId).toBe("agent-1")
    expect(bound.revision).toBe(2)
  })

  test("exact replay is idempotent and conflicting observation-id reuse fails closed", async () => {
    const item = subagentFixture()
    const observation = {
      observationId: "replay-1",
      harnessExecutionId: "run-1",
      toolCallId: "task-1",
      toolCallRole: "spawn",
      status: "running",
    } satisfies SubagentObservation

    const first = await item.boundary.admit("parent", observation)
    const replay = await item.boundary.admit("parent", observation)

    expect(replay).toEqual(first)
    expect(item.published).toHaveLength(1)
    await expect(item.boundary.admit("parent", { ...observation, status: "completed" }))
      .rejects.toThrow("reused with conflicting content")
  })

  test("allows immutable bindings once and rejects later conflicts for an explicit host key", async () => {
    const item = subagentFixture()
    await item.boundary.admit("parent", {
      observationId: "binding-1",
      subagentKey: "host-key",
      status: "running",
    })
    const bound = await item.boundary.admit("parent", {
      observationId: "binding-2",
      subagentKey: "host-key",
      providerKind: "cursor-agent",
      providerId: "provider-1",
      childSessionId: "child-1",
    })

    expect(bound).toMatchObject({
      subagentKey: "host-key",
      providerKind: "cursor-agent",
      providerId: "provider-1",
      childSessionId: "child-1",
    })
    await expect(item.boundary.admit("parent", {
      observationId: "binding-3",
      subagentKey: "host-key",
      providerKind: "cursor-agent",
      providerId: "provider-2",
    })).rejects.toThrow("conflicting immutable subagent providerId binding")
    await expect(item.boundary.admit("parent", {
      observationId: "binding-4",
      subagentKey: "host-key",
      childSessionId: "child-2",
    })).rejects.toThrow("conflicting immutable subagent childSessionId binding")
  })

  test("rejects a tool-call role without its call before persistence", async () => {
    const item = subagentFixture()
    await expect(item.boundary.admit("parent", {
      observationId: "bad-edge",
      toolCallRole: "spawn",
    })).rejects.toThrow("a subagent tool-call role requires its toolCallId")
    expect(item.store.records()).toEqual([])
  })

  test("a call without a role joins observations into one row and records no edge", async () => {
    const item = subagentFixture()
    const started = await item.boundary.admit("parent", {
      observationId: "fork-started",
      harnessExecutionId: "run-1",
      stableCorrelationId: "task-1",
      toolCallId: "skill-call",
      status: "running",
    })
    const finished = await item.boundary.admit("parent", {
      observationId: "fork-result",
      harnessExecutionId: "run-1",
      toolCallId: "skill-call",
      providerKind: "claude-agent",
      providerId: "agent-1",
      status: "completed",
    })

    expect(finished.subagentKey).toBe(started.subagentKey)
    expect(item.published.map(({ event }) => event.toolCallRole)).toEqual([undefined, undefined])
  })

  test("attention travels from the observation onto the published event", async () => {
    const item = subagentFixture()
    const created = await item.boundary.admit("parent", {
      observationId: "host-create",
      subagentKey: "subagent_host",
      status: "pending",
      providerKind: "claxedo",
      providerId: "child-1",
      childSessionId: "child-1",
      transcript: { kind: "live" },
    })
    const attention = await item.boundary.admit("parent", {
      observationId: "host-attention-1",
      subagentKey: "subagent_host",
      attention: 2,
    })
    const cleared = await item.boundary.admit("parent", {
      observationId: "host-attention-2",
      subagentKey: "subagent_host",
      attention: 0,
    })
    expect(created.attention).toBeUndefined()
    expect(attention).toMatchObject({ subagentKey: "subagent_host", revision: 2, attention: 2 })
    expect(cleared).toMatchObject({ revision: 3, attention: 0 })
  })
})

describe("subagent replay", () => {
  const observation: SubagentObservation = {
    observationId: "spawn", harnessExecutionId: "run", toolCallId: "tool", toolCallRole: "spawn",
    status: "running", transcript: { kind: "messages" },
  }

  test("retries both sides of publication with the same persisted key and revision", async () => {
    for (const publishBeforeCrash of [false, true]) {
      const f = subagentFixture()
      const publish = f.ports.publishSubagent.bind(f.ports)
      f.ports.publishSubagent = async (parent, event) => {
        if (publishBeforeCrash) await publish(parent, event)
        throw new Error("crash")
      }
      await expect(f.boundary.admit("parent", observation)).rejects.toThrow("crash")
      f.ports.publishSubagent = publish
      const event = await createRequestBroker(f.ports).subagents.admit("parent", observation)
      expect(f.store.records()[0]?.event.subagentKey).toBe(event.subagentKey)
      expect(event.revision).toBe(1)
      expect(new Set(f.published.map((row) => `${row.event.subagentKey}:${row.event.revision}`))).toEqual(new Set([`${event.subagentKey}:1`]))
    }
  })

  test("admission allocates one child and child-less updates reuse it", async () => {
    const f = subagentFixture()
    const first = await f.boundary.admit("parent", observation)
    expect(first.childSessionId).toBeString()
    const progress = await f.boundary.admit("parent", { ...observation, observationId: "progress", status: "completed" })
    expect(progress.childSessionId).toBe(first.childSessionId)
    expect(progress.subagentKey).toBe(first.subagentKey)
    expect(new Set(f.store.records().map((row) => row.event.childSessionId))).toEqual(new Set([first.childSessionId]))
  })

  test("child-less replay dedupes but a different explicit child is refused", async () => {
    const f = subagentFixture()
    const first = await f.boundary.admit("parent", observation)
    expect(await f.boundary.admit("parent", observation)).toEqual(first)
    expect(f.published).toHaveLength(1)
    await expect(f.boundary.admit("parent", { ...observation, childSessionId: "other" })).rejects.toThrow("reused with conflicting content")
    expect(f.store.records()).toHaveLength(1)
  })
})

test("child admission preserves observation order while deriving a Web Crypto identity", async () => {
  const item = subagentFixture()
  const parent = "parent-ordered"
  const providerId = "provider-child"
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${parent}\0provider:claude:${providerId}`))
  const key = `subagent_${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 24)}`
  const first = item.boundary.admit(parent, {
    observationId: "started", providerKind: "claude", providerId, status: "running",
  })
  const second = item.boundary.admit(parent, {
    observationId: "finished", subagentKey: key, status: "completed",
  })
  const outcomes = await Promise.allSettled([first, second])
  expect(outcomes.map((outcome) => outcome.status)).toEqual(["fulfilled", "fulfilled"])
  expect(item.published.map(({ event }) => event.status)).toEqual(["running", "completed"])
  expect(item.published.map(({ event }) => event.subagentKey)).toEqual([key, key])
})
