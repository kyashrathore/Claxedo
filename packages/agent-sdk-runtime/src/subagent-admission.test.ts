import { describe, expect, test } from "bun:test"
import type { SubagentUpdatedEvent } from "@claxedo/agent-event-runtime"
import {
  createMemorySubagentAdmissionStore,
  createSubagentAdmissionBoundary,
  type SubagentObservation,
} from "./subagent-admission"

function harness() {
  const store = createMemorySubagentAdmissionStore()
  const published: Array<{ parentSessionId: string; event: SubagentUpdatedEvent }> = []
  return {
    store,
    published,
    boundary: createSubagentAdmissionBoundary({
      store,
      publish: (parentSessionId, event) => {
        published.push({ parentSessionId, event })
      },
      allocateKey: () => "subagent_allocated",
    }),
  }
}

describe("subagent host admission", () => {
  test("round-trips Codex provider identity, live transcript, multi-receiver edges, and later interactions", async () => {
    const item = harness()
    const first = await item.boundary.admit("parent-codex", {
      observationId: "codex-spawn-1",
      harnessExecutionId: "run-codex",
      toolCallId: "collab-call",
      toolCallRole: "spawn",
      providerKind: "codex-thread",
      providerId: "thread-1",
      status: "running",
      transcript: { kind: "live", ref: "thread-transcript-1" },
    })
    const second = await item.boundary.admit("parent-codex", {
      observationId: "codex-spawn-2",
      harnessExecutionId: "run-codex",
      toolCallId: "collab-call",
      toolCallRole: "spawn",
      providerKind: "codex-thread",
      providerId: "thread-2",
      status: "running",
      transcript: { kind: "live", ref: "thread-transcript-2" },
    })
    const interaction = await item.boundary.admit("parent-codex", {
      observationId: "codex-send-1",
      harnessExecutionId: "run-codex",
      toolCallId: "send-call",
      toolCallRole: "interaction",
      providerKind: "codex-thread",
      providerId: "thread-1",
      status: "running",
    })

    expect(first.subagentKey).not.toBe(second.subagentKey)
    expect(interaction.subagentKey).toBe(first.subagentKey)
    expect(interaction.revision).toBe(2)
    expect(item.published.map((row) => row.parentSessionId)).toEqual([
      "parent-codex",
      "parent-codex",
      "parent-codex",
    ])
  })

  test("keeps one Cursor synthetic key whether provider identity arrives late or never", async () => {
    const item = harness()
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
    const item = harness()
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

  test("round-trips generic ACP nested messages and Pi immediate child Session shapes", async () => {
    const item = harness()
    const nested = await item.boundary.admit("parent-example-acp", {
      observationId: "example-acp-nested-1",
      harnessExecutionId: "run-example-acp",
      stableCorrelationId: "agent-tool-call-1",
      label: "Research",
      status: "running",
      transcript: { kind: "messages", ref: "nested-messages-1" },
    })
    const pi = await item.boundary.admit("parent-pi", {
      observationId: "pi-spawn-1",
      harnessExecutionId: "run-pi",
      toolCallId: "pi-tool-1",
      toolCallRole: "spawn",
      mode: "background",
      status: "pending",
      childSessionId: "pi-child-1",
      transcript: { kind: "live", ref: "pi-child-1" },
    })

    expect(nested).toMatchObject({
      type: "subagent-updated",
      revision: 1,
      transcript: { kind: "messages", ref: "nested-messages-1" },
    })
    expect(pi).toMatchObject({
      type: "subagent-updated",
      revision: 1,
      mode: "background",
      childSessionId: "pi-child-1",
      transcript: { kind: "live", ref: "pi-child-1" },
    })
    expect(pi.subagentKey).not.toBe(pi.childSessionId)
  })

  test("retries both sides of publication with the same persisted key and revision", async () => {
    const observation = {
      observationId: "cursor-crash",
      harnessExecutionId: "run-cursor",
      toolCallId: "task-crash",
      toolCallRole: "spawn",
      status: "running",
    } satisfies SubagentObservation

    for (const publishBeforeCrash of [false, true]) {
      const store = createMemorySubagentAdmissionStore()
      const published: SubagentUpdatedEvent[] = []
      const crashing = createSubagentAdmissionBoundary({
        store,
        allocateKey: () => `allocated-${publishBeforeCrash}`,
        publish: (_parentSessionId, event) => {
          if (publishBeforeCrash) published.push(event)
          throw new Error("crash")
        },
      })
      await expect(crashing.admit("parent", observation)).rejects.toThrow("crash")

      const recovered = createSubagentAdmissionBoundary({
        store,
        allocateKey: () => "replacement-must-not-be-used",
        publish: (_parentSessionId, event) => {
          published.push(event)
        },
      })
      const event = await recovered.admit("parent", observation)

      expect(event.subagentKey).toBe(store.records()[0]?.event.subagentKey)
      expect(event.revision).toBe(1)
      expect(new Set(published.map((row) => `${row.subagentKey}:${row.revision}`))).toEqual(
        new Set([`${event.subagentKey}:1`]),
      )
    }
  })

  test("exact replay is idempotent and conflicting observation-id reuse fails closed", async () => {
    const item = harness()
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
    const item = harness()
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

  test("rejects partial role-bearing tool-call edges before persistence", async () => {
    const item = harness()
    await expect(item.boundary.admit("parent", {
      observationId: "bad-edge",
      toolCallId: "call-without-role",
    })).rejects.toThrow("require both toolCallId and toolCallRole")
    expect(item.store.records()).toEqual([])
  })

  test("child identity is the strongest correlator: an observation naming an owned child resolves to the owning row", async () => {
    const item = harness()
    // Claude dual-channel split: the tool-call channel and the background-task
    // channel carry disjoint keys, so admission legitimately opens two rows.
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

    // The linking observation carries row B's stable key AND row A's child.
    // The child wins: it must land on row A, never bind child-a to row B.
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

  test("admission allocates the child once and reuses the binding for later child-less observations", async () => {
    const item = harness()
    let allocations = 0
    const allocateChildSessionId = () => `child-allocated-${++allocations}`
    const spawn = await item.boundary.admit("parent", {
      observationId: "spawn",
      harnessExecutionId: "run",
      toolCallId: "tool-1",
      toolCallRole: "spawn",
      status: "pending",
      transcript: { kind: "messages" },
    }, { allocateChildSessionId })
    expect(spawn.childSessionId).toBe("child-allocated-1")

    // A later observation of the same row without a child (the caller's
    // in-memory state is empty after a process restart) reuses the binding
    // instead of allocating a second child or tripping the compat check.
    const progress = await item.boundary.admit("parent", {
      observationId: "progress",
      harnessExecutionId: "run",
      toolCallId: "tool-1",
      toolCallRole: "spawn",
      status: "running",
      transcript: { kind: "messages" },
    }, { allocateChildSessionId })
    expect(progress.subagentKey).toBe(spawn.subagentKey)
    expect(progress.childSessionId).toBe("child-allocated-1")
    expect(allocations).toBe(1)
  })

  test("a duplicate delivery lacking the allocated child dedupes instead of conflicting", async () => {
    const item = harness()
    const observation: SubagentObservation = {
      observationId: "spawn",
      harnessExecutionId: "run",
      toolCallId: "tool-1",
      toolCallRole: "spawn",
      status: "pending",
      transcript: { kind: "messages" },
    }
    const first = await item.boundary.admit("parent", observation, {
      allocateChildSessionId: () => "child-allocated",
    })
    expect(first.childSessionId).toBe("child-allocated")

    // Same observationId, same content, no child (another host instance or a
    // replayed frame cannot know the allocation): returns the admitted event.
    const duplicate = await item.boundary.admit("parent", observation)
    expect(duplicate).toEqual(first)

    // A duplicate that names a DIFFERENT child is still a conflict.
    await expect(item.boundary.admit("parent", {
      ...observation,
      childSessionId: "child-other",
    })).rejects.toThrow("reused with conflicting content")
  })
})
