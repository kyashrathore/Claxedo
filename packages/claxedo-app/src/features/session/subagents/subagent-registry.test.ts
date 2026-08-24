import { describe, expect, test } from "bun:test"
import type { SubagentUpdatedEvent } from "@claxedo/agent-event-runtime"
import { createSubagentRegistry, type SubagentRegistryEntry } from "./subagent-registry"

function comparable(entry: SubagentRegistryEntry | undefined) {
  if (!entry) return entry
  return {
    parentSessionId: entry.parentSessionId,
    subagentKey: entry.subagentKey,
    mode: entry.mode,
    status: entry.status,
    label: entry.label,
    subagentType: entry.subagentType,
    description: entry.description,
    providerId: entry.providerId,
    providerKind: entry.providerKind,
    childSessionId: entry.childSessionId,
    transcript: entry.transcript,
    toolCallEdges: [...entry.toolCallEdges.entries()].sort(),
    fieldRevisions: Object.fromEntries(Object.entries(entry.fieldRevisions).sort(([a], [b]) => a.localeCompare(b))),
  }
}

function permutations<T>(items: T[]): T[][] {
  if (items.length < 2) return [items]
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]),
  )
}

describe("subagent registry", () => {
  test("every ordering of distinct-field updates, replay, and duplicates converges", () => {
    const updates: SubagentUpdatedEvent[] = [
      { type: "subagent-updated", subagentKey: "child", revision: 1, mode: "foreground" },
      { type: "subagent-updated", subagentKey: "child", revision: 2, status: "running" },
      { type: "subagent-updated", subagentKey: "child", revision: 3, label: "Research" },
      { type: "subagent-updated", subagentKey: "child", revision: 4, description: "Inspect the repo" },
      {
        type: "subagent-updated",
        subagentKey: "child",
        revision: 5,
        transcript: { kind: "messages", ref: "nested-1" },
      },
      { type: "subagent-updated", subagentKey: "child", revision: 6, toolCallId: "spawn-1", toolCallRole: "spawn" },
    ]
    const states = permutations(updates).map((ordered) => {
      const registry = createSubagentRegistry()
      for (const event of [...ordered, ...ordered, ...ordered.toReversed()]) registry.apply("parent", event)
      return comparable(registry.get("parent", "child"))
    })

    expect(new Set(states.map((state) => JSON.stringify(state))).size).toBe(1)
    expect(states[0]).toMatchObject({
      parentSessionId: "parent",
      subagentKey: "child",
      mode: "foreground",
      status: "running",
      label: "Research",
      description: "Inspect the repo",
      transcript: { kind: "messages", ref: "nested-1" },
      toolCallEdges: [["spawn-1", "spawn"]],
    })
  })

  test("keeps host, provider, and child Session identities separate and immutable", () => {
    const registry = createSubagentRegistry()
    registry.apply("parent", {
      type: "subagent-updated",
      subagentKey: "host-key",
      revision: 1,
      providerKind: "pi",
      providerId: "provider-key",
      childSessionId: "child-session",
      transcript: { kind: "live", ref: "child-session" },
    })
    registry.apply("parent", {
      type: "subagent-updated",
      subagentKey: "host-key",
      revision: 2,
      providerId: "conflicting-provider",
      childSessionId: "conflicting-session",
    })
    registry.apply("parent", {
      type: "subagent-updated",
      subagentKey: "host-key",
      revision: 1,
      providerKind: "conflicting-kind",
    })

    expect(registry.get("parent", "host-key")).toMatchObject({
      subagentKey: "host-key",
      providerId: "provider-key",
      childSessionId: "child-session",
    })
    expect(registry.diagnostics().map((row) => row.code)).toEqual([
      "subagent.binding_conflict",
      "subagent.binding_conflict",
      "subagent.binding_conflict",
    ])
  })

  test("edges are grow-only, role-bearing, many-to-many associations", () => {
    const registry = createSubagentRegistry()
    const apply = (subagentKey: string, revision: number, toolCallId: string, toolCallRole: "spawn" | "interaction") =>
      registry.apply("parent", { type: "subagent-updated", subagentKey, revision, toolCallId, toolCallRole })

    apply("child-1", 1, "spawn-many", "spawn")
    apply("child-2", 1, "spawn-many", "spawn")
    apply("child-1", 2, "send-input", "interaction")
    apply("child-1", 3, "send-input", "spawn")

    expect([...registry.get("parent", "child-1")!.toolCallEdges]).toEqual([
      ["spawn-many", "spawn"],
      ["send-input", "interaction"],
    ])
    expect([...registry.get("parent", "child-2")!.toolCallEdges]).toEqual([["spawn-many", "spawn"]])
    expect(registry.diagnostics()).toMatchObject([{ code: "subagent.edge_conflict" }])
  })

  test("terminal entries ignore later non-terminal updates diagnostically", () => {
    const registry = createSubagentRegistry()
    registry.apply("parent", { type: "subagent-updated", subagentKey: "child", revision: 4, status: "completed" })
    registry.apply("parent", { type: "subagent-updated", subagentKey: "child", revision: 5, status: "running" })

    expect(registry.get("parent", "child")?.status).toBe("completed")
    expect(registry.diagnostics()).toMatchObject([
      {
        code: "subagent.terminal_regression",
        revision: 5,
      },
    ])
    expect(registry.get("parent", "child")?.fieldRevisions.status).toBe(5)
  })

  test("terminal precedence converges across ordering, replay, and duplicates", () => {
    const completed = {
      type: "subagent-updated",
      subagentKey: "child",
      revision: 4,
      status: "completed",
    } satisfies SubagentUpdatedEvent
    const running = {
      type: "subagent-updated",
      subagentKey: "child",
      revision: 5,
      status: "running",
    } satisfies SubagentUpdatedEvent
    const states = permutations([completed, running]).map((ordered) => {
      const registry = createSubagentRegistry()
      for (const event of [...ordered, ...ordered, ...ordered.toReversed()]) registry.apply("parent", event)
      return comparable(registry.get("parent", "child"))
    })

    expect(new Set(states.map((state) => JSON.stringify(state))).size).toBe(1)
    expect(states[0]).toMatchObject({ status: "completed", fieldRevisions: { status: 5 } })
  })

  test("a newer terminal status may refine an earlier terminal status", () => {
    const registry = createSubagentRegistry()
    registry.apply("parent", { type: "subagent-updated", subagentKey: "child", revision: 4, status: "interrupted" })
    registry.apply("parent", { type: "subagent-updated", subagentKey: "child", revision: 5, status: "failed" })

    expect(registry.get("parent", "child")).toMatchObject({
      status: "failed",
      fieldRevisions: { status: 5 },
    })
  })

  test("isolates identical keys by parent and covers delete, archive, workspace, replay-gap, and abort teardown", () => {
    const registry = createSubagentRegistry()
    const changes: Array<{ type: string; parentSessionId?: string }> = []
    registry.subscribe((change) => changes.push(change))
    const add = (parent: string, key: string, mode: "foreground" | "background" = "foreground") =>
      registry.apply(parent, { type: "subagent-updated", subagentKey: key, revision: 1, mode, status: "running" })

    add("parent-1", "same")
    add("parent-2", "same")
    expect(registry.deleteParent("parent-1")).toHaveLength(1)
    expect(registry.get("parent-2", "same")).toBeDefined()

    add("parent-archive", "child")
    expect(registry.archiveParent("parent-archive")).toHaveLength(1)
    expect(registry.get("parent-archive", "child")).toBeUndefined()

    add("parent-abort", "foreground")
    add("parent-abort", "background", "background")
    expect(registry.abortParent("parent-abort", () => 2).map((entry) => entry.subagentKey)).toEqual(["foreground"])
    expect(registry.get("parent-abort", "foreground")?.status).toBe("interrupted")
    expect(registry.get("parent-abort", "background")?.status).toBe("running")

    registry.workspaceChanged()
    expect(registry.list()).toEqual([])
    add("parent-replay", "child")
    registry.replayGap()
    expect(registry.list()).toEqual([])
    registry.replayGap()
    registry.deleteParent("empty-parent")
    expect(changes).toContainEqual({ type: "remove", parentSessionId: "parent-1" })
    expect(changes).toContainEqual({ type: "remove", parentSessionId: "empty-parent" })
    expect(changes.filter((change) => change.type === "reset")).toHaveLength(3)
  })

  test("round-trips the four validation-rail transcript and identity shapes", () => {
    const registry = createSubagentRegistry()
    const events: Array<[string, SubagentUpdatedEvent]> = [
      [
        "codex",
        {
          type: "subagent-updated",
          subagentKey: "thread-1",
          revision: 1,
          providerKind: "codex-thread",
          providerId: "thread-1",
          transcript: { kind: "live", ref: "live-1" },
        },
      ],
      [
        "cursor",
        { type: "subagent-updated", subagentKey: "synthetic-cursor", revision: 1, transcript: { kind: "none" } },
      ],
      [
        "claude-acp",
        {
          type: "subagent-updated",
          subagentKey: "synthetic-acp",
          revision: 1,
          transcript: { kind: "messages", ref: "messages-1" },
        },
      ],
      [
        "pi",
        {
          type: "subagent-updated",
          subagentKey: "synthetic-pi",
          revision: 1,
          childSessionId: "child-pi",
          transcript: { kind: "live", ref: "child-pi" },
        },
      ],
    ]

    for (const [parent, event] of events) registry.apply(parent, event)

    expect(
      registry.list().map((entry) => [entry.parentSessionId, entry.transcript?.kind, entry.childSessionId]),
    ).toEqual([
      ["codex", "live", undefined],
      ["cursor", "none", undefined],
      ["claude-acp", "messages", undefined],
      ["pi", "live", "child-pi"],
    ])
  })
})
